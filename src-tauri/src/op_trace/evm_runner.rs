//! EVM 执行入口
//!
//! 负责 RPC 数据获取、CacheDB 缓存管理、EVM 构建和执行。

use crate::optrace_journal::OpTraceJournal;
use alloy_provider::{
    network::TransactionResponse,
    Provider, ProviderBuilder,
};
use alloy_rpc_types_eth::{BlockNumberOrTag, TransactionTrait};
use revm::{
    context::{BlockEnv, CfgEnv, Evm, LocalContext, TxEnv},
    context_interface::JournalTr,
    database::{AlloyDB, BlockId, CacheDB, Cache},
    database_interface::WrapDatabaseAsync,
    handler::{instructions::EthInstructions, EthPrecompiles},
    primitives::{hardfork::SpecId, hex::FromHex, Address, Bytes, Log, TxKind, B256, U256},
    state::{AccountInfo, Bytecode, EvmState},
    Context, InspectEvm,
};
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tauri::ipc::Channel;

use super::debug_session::{self, DebugSession};
use super::inspector::Cheatcodes;
use super::message_encoder::MessageEncoder;
use super::types::{BlockDebugData, TxDebugData};
use super::AlloyCacheDB;
use super::fork::fork_inspector::ForkInspector;
use super::fork::StatePatch;


fn get_cache_path(app: &AppHandle, tx_hash: &str, chain_id: u64, block_num: u64, prestate: bool) -> PathBuf {
    let cache_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("optrace"));
    let dir = cache_dir.join("cache").join("evm_cache").join(chain_id.to_string());
    std::fs::create_dir_all(&dir).ok();
    let suffix = if prestate { "_pre" } else { "" };
    dir.join(format!("{}_{}{}.bin", &tx_hash.trim_start_matches("0x")[..16], block_num, suffix))
}

/// ERC20 Transfer(address,address,uint256) topic
const TRANSFER_TOPIC: B256 = B256::new([
    0xdd, 0xf2, 0x52, 0xad, 0x1b, 0xe2, 0xc8, 0x9b, 0x69, 0xc2, 0xb0, 0x68, 0xfc, 0x37, 0x8d, 0xaa,
    0x95, 0x2b, 0xa7, 0xf1, 0x63, 0xc4, 0xa1, 0x16, 0x28, 0xf5, 0x5a, 0x4d, 0xf5, 0x23, 0xb3, 0xef,
]);

fn topic_to_addr(topic: &B256) -> Address {
    Address::from_slice(&topic.as_slice()[12..])
}

fn full_addr(a: &Address) -> String {
    format!("{:?}", a)
}

fn fmt_addr_short(a: &Address) -> String {
    let s = full_addr(a);
    if s.len() > 10 { format!("{}...{}", &s[..6], &s[s.len()-4..]) } else { s }
}

/// 计算按钱包地址汇总的余额净变化，同时打印 + 返回 JSON 字符串
/// JSON 格式: [{ "address": "0x...", "eth": "+1000" | "-500" | null, "tokens": [{ "contract": "0x...", "delta": "+500" }] }]
pub(crate) fn compute_and_print_balance_changes(evm_state: &EvmState, logs: &[Log]) -> String {
    use std::collections::HashMap as HM;

    let eth_key = Address::ZERO;
    
    let mut wallet: HM<Address, HM<Address, (U256, U256)>> = HM::new();

    for log in logs {
        let topics = log.data.topics();
        if topics.len() < 3 || topics[0] != TRANSFER_TOPIC { continue; }
        let from   = topic_to_addr(&topics[1]);
        let to     = topic_to_addr(&topics[2]);
        let amount = if log.data.data.len() >= 32 {
            U256::from_be_slice(&log.data.data[..32])
        } else { U256::ZERO };
        if amount.is_zero() { continue; }
        wallet.entry(from).or_default()
              .entry(log.address).or_insert((U256::ZERO, U256::ZERO)).1 += amount;
        wallet.entry(to).or_default()
              .entry(log.address).or_insert((U256::ZERO, U256::ZERO)).0 += amount;
    }

    for (addr, account) in evm_state.iter() {
        let orig = account.original_info.balance;
        let curr = account.info.balance;
        if orig == curr { continue; }
        let (gained, lost) = if curr > orig { (curr - orig, U256::ZERO) }
                             else           { (U256::ZERO, orig - curr) };
        let e = wallet.entry(*addr).or_default()
                      .entry(eth_key).or_insert((U256::ZERO, U256::ZERO));
        e.0 += gained;
        e.1 += lost;
    }

    if wallet.is_empty() {
        println!("[statediff] (no balance changes)");
        return "[]".to_string();
    }

    println!("[statediff] ===== BALANCE CHANGES BY ADDRESS =====");
    let mut addrs: Vec<Address> = wallet.keys().cloned().collect();
    addrs.sort_by_key(|a| full_addr(a));

    let mut json_entries: Vec<String> = Vec::with_capacity(addrs.len());

    for addr in &addrs {
        let tokens = &wallet[addr];
        println!("[statediff] {:?}", addr);

        // ETH
        let eth_json = if let Some(&(gained, lost)) = tokens.get(&eth_key) {
            let delta_str = if gained >= lost {
                format!("+{}", gained - lost)
            } else {
                format!("-{}", lost - gained)
            };
            if gained >= lost {
                println!("  ETH  +{}", gained - lost);
            } else {
                println!("  ETH  -{}", lost - gained);
            }
            format!("\"{}\"", delta_str)
        } else {
            "null".to_string()
        };

        // ERC20 tokens
        let mut token_addrs: Vec<Address> = tokens.keys()
            .filter(|&&t| t != eth_key).cloned().collect();
        token_addrs.sort_by_key(|a| full_addr(a));

        let mut token_json_parts: Vec<String> = Vec::new();
        for token in &token_addrs {
            let (gained, lost) = tokens[token];
            let net_str = if gained >= lost {
                if (gained - lost).is_zero() { continue; }
                let n = gained - lost;
                println!("  token {}  +{}", fmt_addr_short(token), n);
                format!("+{n}")
            } else {
                let n = lost - gained;
                println!("  token {}  -{}", fmt_addr_short(token), n);
                format!("-{n}")
            };
            token_json_parts.push(format!(
                "{{\"contract\":\"{}\",\"delta\":\"{}\"}}",
                full_addr(token), net_str
            ));
        }

        json_entries.push(format!(
            "{{\"address\":\"{}\",\"eth\":{},\"tokens\":[{}]}}",
            full_addr(addr),
            eth_json,
            token_json_parts.join(",")
        ));
    }

    println!("[statediff] ===== END =====");
    format!("[{}]", json_entries.join(","))
}

fn save_cache(db: &AlloyCacheDB, path: &Path) {    match bincode::serialize(&db.cache) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(path, bytes) {
                eprintln!("[cache] write failed: {e}");
            } else {
                println!(
                    "[cache] saved to {:?} ({} accounts, {} contracts)",
                    path,
                    db.cache.accounts.len(),
                    db.cache.contracts.len()
                );
            }
        }
        Err(e) => eprintln!("[cache] serialize failed: {e}"),
    }
}

fn load_cache(cache_db: &mut AlloyCacheDB, path: &Path) -> bool {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return false,
    };
    match bincode::deserialize::<Cache>(&bytes) {
        Ok(loaded) => {
            println!(
                "[cache] loaded from {:?} ({} accounts, {} contracts)",
                path,
                loaded.accounts.len(),
                loaded.contracts.len()
            );
            cache_db.cache = loaded;
            true
        }
        Err(e) => {
            eprintln!("[cache] deserialize failed (stale?): {e}");
            false
        }
    }
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
        Self {
            block: BlockEnv::default(),
            tx: TxEnv::default(),
            cfg,
        }
    }
}


/// debug_traceTransaction 返回的 prestateTracer 单个账户
#[derive(serde::Deserialize, Debug)]
struct PrestateAccount {
    #[serde(default)]
    balance: Option<U256>,
    #[serde(default)]
    nonce: Option<u64>,
    #[serde(default)]
    code: Option<Bytes>,
    #[serde(default)]
    storage: Option<HashMap<B256, U256>>,
}

/// 通过 debug_traceTransaction + prestateTracer 获取交易执行前的所有相关状态
async fn fetch_prestate(
    provider: &alloy_provider::DynProvider,
    tx_hash: B256,
) -> anyhow::Result<HashMap<Address, PrestateAccount>> {
    let params = serde_json::json!([
        tx_hash,
        { "tracer": "prestateTracer" }
    ]);
    let result: HashMap<Address, PrestateAccount> = provider
        .raw_request(Cow::Borrowed("debug_traceTransaction"), params)
        .await
        .map_err(|e| anyhow::anyhow!("prestateTracer RPC failed: {e}"))?;
    println!(
        "[prestate] fetched {} accounts from prestateTracer",
        result.len()
    );
    Ok(result)
}

/// 将 prestateTracer 返回的数据预填到 CacheDB
fn apply_prestate(cache_db: &mut AlloyCacheDB, prestate: HashMap<Address, PrestateAccount>) {
    for (address, acct) in prestate {
        let code_bytes = acct.code.unwrap_or_default();
        let code_hash = revm::primitives::keccak256(&code_bytes);
        let info = AccountInfo {
            balance: acct.balance.unwrap_or_default(),
            nonce: acct.nonce.unwrap_or(0),
            code_hash,
            account_id: None,
            code: Some(Bytecode::new_raw(code_bytes)),
        };
        cache_db.insert_account_info(address, info);

        if let Some(storage) = acct.storage {
            for (slot, value) in storage {
                let _ = cache_db.insert_account_storage(
                    address,
                    slot.into(),
                    value,
                );
            }
        }
    }
}


pub async fn op_trace(
    tx: &str,
    tx_data: Option<TxDebugData>,
    block_data: Option<BlockDebugData>,
    rpc_url: &str,
    use_alloy_cache: bool,
    use_prestate: bool,
    patches: Vec<StatePatch>,
    channel: Channel,
    app_handle: AppHandle,
    session_state: Arc<Mutex<Option<DebugSession>>>,
) -> anyhow::Result<()> {
    let is_fork = !patches.is_empty();
    // 创建新的 DebugSession 并存入全局状态
    let session = Arc::new(Mutex::new(DebugSession::new()));
    {
        let mut guard = session_state.lock().unwrap();
        *guard = None; // 清空上一次的 session
    }

    let encoder = MessageEncoder::new(channel);
    let base_inspector =
        Cheatcodes::<BlockEnv, TxEnv, CfgEnv>::new(encoder, session.clone());

    let provider = ProviderBuilder::new().connect(rpc_url).await?.erased();

    let chain_id = provider.get_chain_id().await.unwrap_or(1);

    let (from_address, to_address, tx_value, tx_gas_price, tx_gas_limit, tx_input, tx_data_block) =
        if let Some(ref custom_tx) = tx_data {
            let from = Address::from_hex(&custom_tx.from)?;
            let to = Address::from_hex(&custom_tx.to)?;
            let value = U256::from_str_radix(&custom_tx.value, 10).unwrap_or_default();
            let gas_price = u128::from_str_radix(&custom_tx.gas_price, 10).unwrap_or(0);
            let gas_limit = u64::from_str_radix(&custom_tx.gas_limit, 10).unwrap_or(21000);
            let input = Bytes::from_hex(&custom_tx.data).unwrap_or_default();

            let tx_chain_data = provider
                .get_transaction_by_hash(tx.parse().unwrap())
                .await?
                .unwrap();
            let block_num = tx_chain_data.block_number().unwrap() - 1;

            (from, to, value, gas_price, gas_limit, input, block_num)
        } else {
            let tx_chain_data = provider
                .get_transaction_by_hash(tx.parse().unwrap())
                .await?
                .unwrap();
            let from = tx_chain_data.from();
            let to = *tx_chain_data.inner.kind().to().unwrap();
            let value = tx_chain_data.value();
            let gas_price = tx_chain_data.effective_gas_price(None);
            let gas_limit = tx_chain_data.gas_limit();
            let input = tx_chain_data.inner.input().clone();
            let block_num = tx_chain_data.block_number().unwrap() - 1;

            (from, to, value, gas_price, gas_limit, input, block_num)
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
            u64::from_str_radix(&custom_block.gas_limit, 10).unwrap_or(30000000);
    } else {
        let block = provider
            .get_block_by_number(BlockNumberOrTag::Number(tx_data_block))
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

    // prestateTracer 预填 — 精确模式（块内非首笔交易时保证状态正确）
    // 必须在 provider 被 AlloyDB::new() 消耗前调用
    let prestate_data = if use_prestate {
        let tx_hash = B256::from_hex(tx)?;
        match fetch_prestate(&provider, tx_hash).await {
            Ok(data) => Some(data),
            Err(e) => {
                eprintln!("[prestate] failed, falling back to lazy load: {e}");
                None
            }
        }
    } else {
        None
    };

    let alloy_db =
        WrapDatabaseAsync::new(AlloyDB::new(provider, BlockId::number(tx_data_block))).unwrap();
    let mut cache_db = CacheDB::new(alloy_db);

    // 先从磁盘加载缓存（补全大量数据，减少 RPC 请求）
    let cache_path = get_cache_path(&app_handle, tx, chain_id, tx_data_block, use_prestate);
    if use_alloy_cache {
        let cache_hit = load_cache(&mut cache_db, &cache_path);
        if !cache_hit {
            println!("[cache] miss, will fetch from RPC");
        }
    } else {
        println!("[cache] disabled by user");
    }

    // 再用 prestate 覆盖（精确值优先级最高，必须在 cache 之后写入）
    if let Some(prestate) = prestate_data {
        apply_prestate(&mut cache_db, prestate);
    }

    let env = Env::mainnet();

    let mut backend: OpTraceJournal<CacheDB<WrapDatabaseAsync<AlloyDB<alloy_provider::network::Ethereum, alloy_provider::DynProvider>>>> = OpTraceJournal::new(SpecId::default(), cache_db);
    backend.set_spec_id(SpecId::OSAKA);

    let tx = TxEnv::builder()
        .caller(from_address)
        .kind(TxKind::Call(to_address))
        .value(tx_value)
        .data(tx_input)
        .gas_price(tx_gas_price)
        .gas_limit(tx_gas_limit)
        .build()
        .unwrap();

    let context = Context {
        tx: tx.clone(),
        block: evm_block,
        cfg: env.cfg,
        journaled_state: backend,
        chain: (),
        local: LocalContext::default(),
        error: Ok(()),
    };

    // send_finished 必须推迟到 session 存入全局状态之后（前端收到 Finished 后立即 seek_to）
    let (result, send_finished_fn): (_, Box<dyn FnOnce()>) = if is_fork {
        let mut fi = ForkInspector::<BlockEnv, TxEnv, CfgEnv>::new_from_cheatcodes(
            base_inspector, patches,
        );
        let patch_count = fi.patches.len();
        let mut evm = Evm::new_with_inspector(
            context,
            &mut fi,
            EthInstructions::new_mainnet_with_spec(SpecId::default()),
            EthPrecompiles::new(SpecId::default()),
        );
        println!("[fork] start inspect tx with {} patches", patch_count);
        let result = evm.inspect_tx(tx);
        drop(evm); // 释放可变借用
        if let Ok(ref r) = result {
            let json = compute_and_print_balance_changes(&r.state, r.result.logs());
            fi.send_balance_changes(&json);
        }
        fi.flush_steps();
        (result, Box::new(move || fi.send_finished()))
    } else {
        let mut inspector = base_inspector;
        let mut evm = Evm::new_with_inspector(
            context,
            &mut inspector,
            EthInstructions::new_mainnet_with_spec(SpecId::default()),
            EthPrecompiles::new(SpecId::default()),
        );
        println!("start inspect tx");
        let result = evm.inspect_tx(tx);
        // 正常模式：先保存缓存（evm 还在），再 drop 释放可变借用
        if use_alloy_cache {
            save_cache(evm.ctx.journaled_state.db(), &cache_path);
        }
        let balance_json = if let Ok(ref r) = result {
            compute_and_print_balance_changes(&r.state, r.result.logs())
        } else { "[]".to_string() };
        drop(evm); // 释放可变借用
        inspector.send_balance_changes(&balance_json);
        inspector.flush_steps();
        (result, Box::new(move || inspector.send_finished()))
    };

    // 将 DebugSession 存入全局状态，供 seek_to 使用（必须在 send_finished 之前，否则前端收到 Finished 后立即 seek_to 会找不到 session）
    {
        let finished_session = match Arc::try_unwrap(session) {
            Ok(mutex) => mutex.into_inner().unwrap(),
            Err(arc) => {
                let mut lock = arc.lock().unwrap();
                std::mem::replace(&mut *lock, debug_session::DebugSession::new())
            }
        };
        let trace_len = finished_session.trace.len();
        let frame_count = finished_session.frame_memories.len();
        *session_state.lock().unwrap() = Some(finished_session);
        println!(
            "[seek] session stored: {} steps, {} frames",
            trace_len, frame_count
        );
    }

    send_finished_fn();

    match result {
        Ok(res) => {
            println!("Execution Success: {:?}", res.result);
        }
        Err(e) => {
            println!("EVM Transaction Error: {:?}", e);
        }
    }
    println!("end inspect tx");

    Ok(())
}
