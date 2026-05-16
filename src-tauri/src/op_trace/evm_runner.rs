//! EVM 执行入口
//!
//! 负责 RPC 数据获取、EVM 构建和执行。
//! 缓存管理、余额差异计算、prestate 获取分别位于同级模块 `cache`、`balance_diff`、`prestate`。

use crate::optrace_journal::OpTraceJournal;
use alloy_provider::{
    network::TransactionResponse,
    Provider, ProviderBuilder,
};
use alloy_rpc_types_eth::{BlockNumberOrTag, TransactionTrait};
use revm::{
    Context, InspectEvm, context::{
        BlockEnv, CfgEnv, Evm, LocalContext, TxEnv, result::{ExecResultAndState, ExecutionResult, HaltReason}
    }, context_interface::JournalTr, database::{AlloyDB, BlockId, CacheDB}, database_interface::WrapDatabaseAsync, handler::{EthPrecompiles, instructions::EthInstructions}, primitives::{Address, B256, Bytes, TxKind, U256, hex::FromHex}, state::EvmState
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use serde::Serialize;

use super::debug_session::{self, DebugSession};
use super::inspector::Cheatcodes;
use super::message_encoder::{MessageEncoder, BytesSender};
use super::types::{parse_tx_kind_from_to_field, BlockDebugData, TxDebugData};
use super::fork::StatePatch;
use super::cache::{resolve_cache_key, get_cache_path_with_dir, dedup_cache_paths, save_cache, read_cache, merge_cache_into};
use super::balance_diff::{full_addr, token_changes_from_logs, fmt_signed_delta, AddressBalanceOut, BalanceTokenChangeOut};
use super::prestate::{fetch_prestate, apply_prestate};
use super::spec_schedule::{parse_spec_id_name, spec_id_for_chain_block};


pub fn tx_env_from_debug(custom: &TxDebugData) -> anyhow::Result<TxEnv> {
    let from = Address::from_hex(&custom.from)?;
    let tx_kind = parse_tx_kind_from_to_field(&custom.to)?;
    let value = U256::from_str_radix(&custom.value, 10).unwrap_or_default();
    let gas_price = u128::from_str_radix(&custom.gas_price, 10).unwrap_or(0);
    let gas_limit = u64::from_str_radix(&custom.gas_limit, 10).unwrap_or(21000);
    let input = Bytes::from_hex(&custom.data).unwrap_or_default();
    Ok(TxEnv::builder()
        .caller(from)
        .kind(tx_kind)
        .value(value)
        .data(input)
        .gas_price(gas_price)
        .gas_limit(gas_limit)
        .build()
        .unwrap())
}


#[derive(Clone, Debug)]
struct Env {
    block: BlockEnv,
    tx: TxEnv,
    cfg: CfgEnv,
}

impl Env {
    fn mainnet() -> Self {
        let mut cfg = CfgEnv::default();
        cfg.disable_nonce_check = true;
        cfg.tx_gas_limit_cap = Some(u64::MAX);
        Self {
            block: BlockEnv::default(),
            tx: TxEnv::default(),
            cfg,
        }
    }
}


pub async fn op_trace(
    tx: &str,
    tx_data: Option<TxDebugData>,
    tx_data_list: Option<Vec<TxDebugData>>,
    block_data: Option<BlockDebugData>,
    rpc_url: &str,
    use_alloy_cache: bool,
    use_prestate: bool,
    enable_shadow: bool,
    readonly: bool,
    patches: Vec<StatePatch>,
    hand_fill: bool,
    hardfork: Option<String>,
    sender: BytesSender,
    data_dir: &Path,
    session_state: Arc<Mutex<std::collections::HashMap<String, super::debug_session::SessionEntry>>>,
    session_id: Option<String>,
) -> anyhow::Result<()> {
    let op_trace_t0 = std::time::Instant::now();
    // 创建新的 DebugSession 并存入全局状态
    let session = Arc::new(Mutex::new(DebugSession::new()));
    let normalized_session_id = super::debug_session::normalize_session_id(session_id.as_deref());
    {
        let mut guard = session_state.lock().unwrap();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let entry = guard.entry(normalized_session_id.clone()).or_default();
        entry.session = None; // 清空同 session_id 的上一次 session
        entry.is_running = true;
        entry.updated_at_ms = now_ms;
    }

    let shadow_temp_dir = data_dir.join("tmp");
    let _ = std::fs::create_dir_all(&shadow_temp_dir);
    let encoder = MessageEncoder::new(sender);
    let mut inspector =
        Cheatcodes::<BlockEnv, TxEnv, CfgEnv>::new(
            encoder,
            session.clone(),
            shadow_temp_dir.clone(),
            enable_shadow,
        );
    inspector.set_patches(patches);

    let provider = ProviderBuilder::new().connect(rpc_url).await?.erased();

    let chain_id = provider.get_chain_id().await.unwrap_or(1);

    // state_block_num = 父块（读库）；exec_block_num = 当前块（BlockEnv）。
    let (exec_block_num, tx_chain_data_opt) = if hand_fill {
        let bd = block_data
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("hand_fill: block_data is required"))?;
        let n = u64::from_str_radix(bd.number.trim(), 10)
            .map_err(|_| anyhow::anyhow!("hand_fill: invalid block number in block_data"))?;
        println!("[env] hand_fill exec_block_num={} (from block_data, no chain tx)", n);
        (n, None)
    } else {
        let tx_chain_data = provider
            .get_transaction_by_hash(tx.parse()?)
            .await?
            .ok_or_else(|| anyhow::anyhow!("transaction not found for hash {}", tx))?;
        let chain_exec_block_num: u64 = tx_chain_data.block_number().unwrap();
        let exec_block_num: u64 = block_data
            .as_ref()
            .and_then(|b| u64::from_str_radix(b.number.trim(), 10).ok())
            .unwrap_or(chain_exec_block_num);
        (exec_block_num, Some(tx_chain_data))
    };
    let state_block_num: u64 = exec_block_num.saturating_sub(1);

    let is_multi = tx_data_list
        .as_ref()
        .map(|v| v.len() >= 2)
        .unwrap_or(false);

    let initial_tx: TxEnv = if is_multi {
        let list = tx_data_list.as_ref().unwrap();
        tx_env_from_debug(&list[0])?
    } else if let Some(ref custom_tx) = tx_data {
        tx_env_from_debug(custom_tx)?
    } else {
        let tc = tx_chain_data_opt
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("missing chain tx; tx_data was None"))?;
        TxEnv::builder()
            .caller(tc.from())
            .kind(tc.inner.kind())
            .value(tc.value())
            .data(tc.inner.input().clone())
            .gas_price(tc.effective_gas_price(None))
            .gas_limit(tc.gas_limit())
            .build()
            .unwrap()
    };

    let mut evm_block = BlockEnv::default();

    if let Some(ref custom_block) = block_data {
        evm_block.number = U256::from_str_radix(&custom_block.number, 10).unwrap_or_default();
        evm_block.timestamp =
            U256::from_str_radix(&custom_block.timestamp, 10).unwrap_or_default();
        evm_block.basefee = u64::from_str_radix(&custom_block.base_fee, 10).unwrap_or(0);
        evm_block.beneficiary =
            Address::from_hex(&custom_block.beneficiary).unwrap_or_default();
        evm_block.difficulty =
            U256::from_str_radix(&custom_block.difficulty, 10).unwrap_or_default();
        evm_block.prevrandao =
            Some(B256::from_hex(&custom_block.mix_hash).unwrap_or_default());
        evm_block.gas_limit =
            u64::from_str_radix(&custom_block.gas_limit, 10).unwrap_or(60000000);
    } else if hand_fill {
        return Err(anyhow::anyhow!("hand_fill: block_data missing for BlockEnv"));
    } else {
        let block = provider
            .get_block_by_number(BlockNumberOrTag::Number(exec_block_num))
            .await?
            .unwrap();
        evm_block.number = U256::from(block.header.number);
        evm_block.timestamp = U256::from(block.header.timestamp);
        evm_block.basefee = block.header.base_fee_per_gas.unwrap_or_default();
        evm_block.beneficiary = block.header.beneficiary;
        evm_block.difficulty = U256::from(block.header.difficulty);
        evm_block.prevrandao = Some(block.header.mix_hash).or(None);
        evm_block.gas_limit = block.header.gas_limit;
    }
    evm_block.gas_limit = u64::MAX; // 调试时不受块 gas limit 限制
    
    // prestateTracer 预填 — 精确模式
    let prestate_data = if use_prestate && !hand_fill {
        let tx_hash = B256::from_hex(tx)?;
        match fetch_prestate(&provider, tx_hash).await {
            Ok(data) => Some(data),
            Err(e) => {
                eprintln!("[prestate] failed, falling back to lazy load: {e}");
                None
            }
        }
    } else {
        if use_prestate && hand_fill {
            println!("[prestate] skipped (hand_fill, no tx hash)");
        }
        None
    };

    let alloy_db =
        WrapDatabaseAsync::new(AlloyDB::new(provider, BlockId::number(state_block_num))).unwrap();
    let mut cache_db = CacheDB::new(alloy_db);

    // 读取缓存路径
    let cache_paths: Vec<PathBuf> = if is_multi {
        let list = tx_data_list.as_ref().unwrap();
        let mut paths = Vec::with_capacity(list.len());
        for row in list.iter() {
            let (h, b) = resolve_cache_key(row, state_block_num);
            paths.push(get_cache_path_with_dir(data_dir, &h, chain_id, b, use_prestate));
        }
        dedup_cache_paths(paths)
    } else {
        let (h, b) = if let Some(ref td) = tx_data {
            resolve_cache_key(td, state_block_num)
        } else if hand_fill {
            let synthetic = format!("hand_{}", exec_block_num);
            (synthetic, state_block_num)
        } else {
            (tx.to_string(), state_block_num)
        };
        vec![get_cache_path_with_dir(data_dir, &h, chain_id, b, use_prestate)]
    };

    let mut cache_loaded_any = false;
    if use_alloy_cache {
        println!("[cache] 准备加载 {} 个缓存路径", cache_paths.len());
        for p in &cache_paths {
            if let Some(loaded) = read_cache(p) {
                merge_cache_into(&mut cache_db, loaded, p);
                cache_loaded_any = true;
            }
        }
        if !cache_loaded_any {
            println!("[cache] ⚠️  无缓存文件，将从 RPC 拉取全部数据");
        }
    } else {
        println!("[cache] ❌ 用户禁用了 AlloyDB 缓存");
    }

    // 再用 prestate 覆盖（精确值优先级最高）
    if let Some(prestate) = prestate_data {
        let prestate_acct_count = prestate.len();
        apply_prestate(&mut cache_db, prestate);
        println!("[cache] 📌 prestate 已覆盖 {} 个账户的精确数据（优先级最高）", prestate_acct_count);
    }
    

    let env = Env::mainnet();

    let spec_id = match hardfork
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("auto"))
    {
        Some(name) => match parse_spec_id_name(name) {
            Some(spec) => {
                println!("[env] hardfork override='{}' -> {:?}", name, spec);
                spec
            }
            None => {
                eprintln!(
                    "[env][warn] unknown hardfork override='{}', fallback to auto schedule",
                    name
                );
                spec_id_for_chain_block(chain_id, exec_block_num)
            }
        },
        None => spec_id_for_chain_block(chain_id, exec_block_num),
    };
    println!(
        "[env] spec_id={:?} (chain_id={}, block={})",
        spec_id, chain_id, exec_block_num
    );

    let mut backend: OpTraceJournal<CacheDB<WrapDatabaseAsync<AlloyDB<alloy_provider::network::Ethereum, alloy_provider::DynProvider>>>> =
        OpTraceJournal::new(spec_id, cache_db);
    backend.set_spec_id(spec_id);

    let to_log = match initial_tx.kind {
        TxKind::Create => "<Create>".to_string(),
        TxKind::Call(addr) => full_addr(&addr),
    };
    println!(
        "[env] from={}, to={}, value={}, gas_price={}, gas_limit={}, input_len={}, block={}",
        full_addr(&initial_tx.caller),
        to_log,
        initial_tx.value,
        initial_tx.gas_price,
        initial_tx.gas_limit,
        initial_tx.data.len(),
        exec_block_num
    );
    if is_multi {
        println!(
            "[env] multi_tx: {} sequential custom txs (shared CacheDB commits between txs)",
            tx_data_list.as_ref().map(|v| v.len()).unwrap_or(0)
        );
    }
    let context = Context {
        tx: initial_tx.clone(),
        block: evm_block,
        cfg: env.cfg,
        journaled_state: backend,
        chain: (),
        local: LocalContext::default(),
        error: Ok(()),
    };

    let mut evm = Evm::new_with_inspector(
        context,
        &mut inspector,
        EthInstructions::new_mainnet_with_spec(spec_id),
        EthPrecompiles::new(spec_id),
    );
    println!("start inspect tx");
    let inspect_t0 = std::time::Instant::now();
    let mut tx_boundary_starts: Vec<u32> = Vec::new();
    let results: anyhow::Result<Vec<ExecResultAndState<ExecutionResult<HaltReason>, EvmState>>> =
        if is_multi {
            let list = tx_data_list.as_ref().unwrap();
            let mut out: Vec<ExecResultAndState<ExecutionResult<HaltReason>, EvmState>> = Vec::with_capacity(list.len());
            for (i, custom_tx) in list.iter().enumerate() {
                let start_idx = session.lock().unwrap().trace.len() as u32;
                if i > 0 {
                    tx_boundary_starts.push(start_idx);
                }
                evm.inspector.reset_frame_stack_for_new_transaction();
                evm.inspector.set_transaction_id(i as u32);
                evm.ctx.journaled_state.set_transaction_id(i as u32);
                let tx_env = tx_env_from_debug(custom_tx)?;
                out.push(evm.inspect_tx(tx_env)?);
            }
            Ok(out)
        } else {
            Ok(vec![evm.inspect_tx(initial_tx)?])
        };
    let tx_finish_boundaries: Option<Vec<u32>> = if is_multi {
        Some(tx_boundary_starts)
    } else {
        None
    };
    let inspect_ms = inspect_t0.elapsed().as_secs_f64() * 1000.0;
    println!(
        "[perf.backend] {} done in {:.1}ms",
        if is_multi {
            "inspect_tx (multi + commit)"
        } else {
            "inspect_tx"
        },
        inspect_ms
    );
    // 统一保存策略
    if use_alloy_cache && !readonly {
        for p in &cache_paths {
            save_cache(evm.ctx.journaled_state.db(), p);
            println!("[cache] ✓ saved {:?}", p);
        }
    }
    let balance_json = if let Ok(ref rs) = results {
        let mut eth_by_tx = evm.ctx.journaled_state.take_eth_deltas_by_tx();
        #[derive(Serialize)]
        struct GroupOut {
            transaction_id: u32,
            changes: Vec<AddressBalanceOut>,
        }
        let mut groups: Vec<GroupOut> = Vec::with_capacity(rs.len());
        for (i, r) in rs.iter().enumerate() {
            let tid = i as u32;
            let token_wallet = token_changes_from_logs(r.result.logs());
            let eth_wallet = eth_by_tx.remove(&tid).unwrap_or_default();

            let mut addrs: Vec<Address> = eth_wallet.keys()
                .chain(token_wallet.keys())
                .cloned()
                .collect();
            addrs.sort_by_key(|a| full_addr(a));
            addrs.dedup();

            let mut changes: Vec<AddressBalanceOut> = Vec::new();
            for addr in addrs {
                let eth = eth_wallet.get(&addr).and_then(|(g, l)| fmt_signed_delta(*g, *l));
                let mut tokens: Vec<BalanceTokenChangeOut> = Vec::new();
                if let Some(tmap) = token_wallet.get(&addr) {
                    let mut token_addrs: Vec<Address> = tmap.keys().cloned().collect();
                    token_addrs.sort_by_key(|a| full_addr(a));
                    for token in token_addrs {
                        let (g, l) = tmap[&token];
                        if let Some(delta) = fmt_signed_delta(g, l) {
                            tokens.push(BalanceTokenChangeOut {
                                contract: full_addr(&token),
                                delta,
                            });
                        }
                    }
                }
                if eth.is_none() && tokens.is_empty() {
                    continue;
                }
                changes.push(AddressBalanceOut {
                    address: full_addr(&addr),
                    eth,
                    tokens,
                });
            }

            groups.push(GroupOut { transaction_id: tid, changes });
        }

        if groups.len() == 1 {
            serde_json::to_string(&groups[0].changes).unwrap_or_else(|_| "[]".to_string())
        } else {
            serde_json::to_string(&groups).unwrap_or_else(|_| "[]".to_string())
        }
    } else { "[]".to_string() };
    drop(evm); // 释放可变借用
    inspector.send_balance_changes(&balance_json);
    inspector.flush_steps();
    let shadow = inspector.take_shadow();
    let send_finished_fn: Box<dyn FnOnce()> =
        Box::new(move || inspector.send_finished(tx_finish_boundaries.as_deref()));

    // 将 DebugSession 存入全局状态
    {
        let mut finished_session = match Arc::try_unwrap(session) {
            Ok(mutex) => mutex.into_inner().unwrap(),
            Err(arc) => {
                let mut lock = arc.lock().unwrap();
                std::mem::replace(&mut *lock, debug_session::DebugSession::new())
            }
        };
        let trace_len = finished_session.trace.len();
        let frame_count = finished_session.frame_memories.len();
        let shadow_nodes = shadow.node_count();
        finished_session.shadow = Some(shadow);
        {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let mut guard = session_state.lock().unwrap();
            let entry = guard.entry(normalized_session_id.clone()).or_default();
            entry.session = Some(finished_session);
            entry.is_running = false;
            entry.updated_at_ms = now_ms;
        }
        println!(
            "[seek] session stored: id={} {} steps, {} frames, {} shadow nodes",
            normalized_session_id, trace_len, frame_count, shadow_nodes
        );
    }

    send_finished_fn();
    println!(
        "[perf.backend] op_trace total done in {:.1}ms",
        op_trace_t0.elapsed().as_secs_f64() * 1000.0
    );

    match results {
        Ok(rs) => {
            if rs.len() <= 1 {
                if let Some(r) = rs.first() {
                    println!("Execution Success: {:?}", r.result);
                } else {
                    println!("Execution Success: []");
                }
            } else {
                for (i, r) in rs.iter().enumerate() {
                    println!("[tx:{}] Execution Success: {:?}", i, r.result);
                }
            }
        }
        Err(e) => {
            println!("EVM Transaction Error: {:?}", e);
        }
    }
    println!("end inspect tx");

    Ok(())
}
