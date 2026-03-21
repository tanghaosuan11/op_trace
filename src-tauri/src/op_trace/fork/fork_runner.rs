//! Fork Runner：重跑交易，注入 patch，复用 CacheDB 缓存。

use crate::optrace_journal::OpTraceJournal;
use alloy_provider::{network::TransactionResponse, Provider, ProviderBuilder};
use alloy_rpc_types_eth::{BlockNumberOrTag, TransactionTrait};
use revm::{
    context::{BlockEnv, CfgEnv, Evm, LocalContext, TxEnv},
    context_interface::JournalTr,
    database::{AlloyDB, BlockId, CacheDB, Cache},
    database_interface::WrapDatabaseAsync,
    handler::{instructions::EthInstructions, EthPrecompiles},
    primitives::{hardfork::SpecId, hex::FromHex, Address, Bytes, TxKind, B256, U256},
    Context, InspectEvm,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Manager};
use tauri::ipc::Channel;

use super::super::debug_session::DebugSession;
use super::super::message_encoder::MessageEncoder;
use super::super::types::{BlockDebugData, TxDebugData};
use super::fork_inspector::ForkInspector;


#[derive(Debug, serde::Deserialize)]
pub struct StatePatch {
    pub step_index: usize,
    pub stack_patches: Vec<(usize, String)>,     // (stack_pos, hex_value)
    pub memory_patches: Vec<(usize, String)>,     // (byte_offset, hex_data)
}

#[derive(Debug, serde::Deserialize)]
pub struct ForkConfig {
    pub tx_hash: String,
    pub rpc_url: String,
    pub patches: Vec<StatePatch>,
    pub tx_data: Option<TxDebugData>,
    pub block_data: Option<BlockDebugData>,
}

/// Fork 独立的 session state，不与主 DebugSession 冲突
pub struct ForkSessionState(pub Arc<RwLock<Option<DebugSession>>>);


fn get_cache_path(app: &AppHandle, tx_hash: &str, chain_id: u64) -> PathBuf {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("optrace"));
    let dir = cache_dir.join("evm_cache").join(chain_id.to_string());
    std::fs::create_dir_all(&dir).ok();
    dir.join(format!("{}.bin", &tx_hash.trim_start_matches("0x")[..16]))
}

fn load_cache(
    cache_db: &mut CacheDB<WrapDatabaseAsync<AlloyDB<alloy_provider::network::Ethereum, alloy_provider::DynProvider>>>,
    path: &std::path::Path,
) -> bool {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return false,
    };
    match bincode::deserialize::<Cache>(&bytes) {
        Ok(loaded) => {
            println!(
                "[fork-cache] loaded from {:?} ({} accounts, {} contracts)",
                path, loaded.accounts.len(), loaded.contracts.len()
            );
            cache_db.cache = loaded;
            true
        }
        Err(e) => {
            eprintln!("[fork-cache] deserialize failed: {e}");
            false
        }
    }
}


pub async fn fork_execute(
    config: ForkConfig,
    channel: Channel,
    app_handle: AppHandle,
    fork_session_state: Arc<RwLock<Option<DebugSession>>>,
) -> anyhow::Result<()> {
    {
        let mut guard = fork_session_state.write().unwrap();
        *guard = None;
    }

    let session = Arc::new(Mutex::new(DebugSession::new()));
    let encoder = MessageEncoder::new(channel);
    let mut inspector = ForkInspector::<BlockEnv, TxEnv, CfgEnv>::new(
        encoder,
        session.clone(),
        config.patches,
    );

    // 打印收到的 patches，确认前端序列化正确
    println!("[fork_runner] received {} patches:", inspector.patches.len());
    for (i, p) in inspector.patches.iter().enumerate() {
        println!(
            "[fork_runner]   patch[{i}] step_index={} stack_patches={} mem_patches={}",
            p.step_index, p.stack_patches.len(), p.memory_patches.len()
        );
        for (pos, val) in &p.stack_patches {
            println!("[fork_runner]     stack pos={pos} val={val:?}");
        }
        for (off, data) in &p.memory_patches {
            println!("[fork_runner]     mem offset={off} data={data:?}");
        }
    }

    let provider = ProviderBuilder::new().connect(&config.rpc_url).await?.erased();
    let chain_id = provider.get_chain_id().await.unwrap_or(1);

    let (from_address, to_address, tx_value, tx_gas_price, tx_gas_limit, tx_input, tx_data_block) =
        if let Some(ref custom_tx) = config.tx_data {
            let from = Address::from_hex(&custom_tx.from)?;
            let to = Address::from_hex(&custom_tx.to)?;
            let value = U256::from_str_radix(&custom_tx.value, 10).unwrap_or_default();
            let gas_price = u128::from_str_radix(&custom_tx.gas_price, 10).unwrap_or(0);
            let gas_limit = u64::from_str_radix(&custom_tx.gas_limit, 10).unwrap_or(21000);
            let input = Bytes::from_hex(&custom_tx.data).unwrap_or_default();

            let tx_chain_data = provider
                .get_transaction_by_hash(config.tx_hash.parse().unwrap())
                .await?
                .unwrap();
            let block_num = tx_chain_data.block_number().unwrap() - 1;
            (from, to, value, gas_price, gas_limit, input, block_num)
        } else {
            let tx_chain_data = provider
                .get_transaction_by_hash(config.tx_hash.parse().unwrap())
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
    if let Some(ref custom_block) = config.block_data {
        evm_block.number = U256::from_str_radix(&custom_block.number, 10).unwrap_or_default();
        evm_block.timestamp = U256::from_str_radix(&custom_block.timestamp, 10).unwrap_or_default();
        evm_block.basefee = u64::from_str_radix(&custom_block.base_fee, 10).unwrap_or(0);
        evm_block.beneficiary = Address::from_hex(&custom_block.beneficiary).unwrap_or_default();
        evm_block.difficulty = U256::from_str_radix(&custom_block.difficulty, 10).unwrap_or_default();
        evm_block.prevrandao = Some(B256::from_hex(&custom_block.mix_hash).unwrap_or_default());
        evm_block.gas_limit = u64::from_str_radix(&custom_block.gas_limit, 10).unwrap_or(30000000);
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

    // 初始化 CacheDB（复用主执行的缓存，不做 RPC）
    let alloy_db = WrapDatabaseAsync::new(AlloyDB::new(provider, BlockId::number(tx_data_block))).unwrap();
    let mut cache_db = CacheDB::new(alloy_db);

    // 从磁盘加载主执行已有的缓存（零 RPC）
    let cache_path = get_cache_path(&app_handle, &config.tx_hash, chain_id);
    let cache_hit = load_cache(&mut cache_db, &cache_path);
    if !cache_hit {
        println!("[fork] cache miss, will fetch from RPC during execution");
    }

    let mut cfg = CfgEnv::default();
    cfg.disable_nonce_check = true;

    let mut backend = OpTraceJournal::new(SpecId::default(), cache_db);
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
        cfg,
        journaled_state: backend,
        chain: (),
        local: LocalContext::default(),
        error: Ok(()),
    };

    let patch_count = inspector.patches.len();

    let mut evm = Evm::new_with_inspector(
        context,
        &mut inspector,
        EthInstructions::new_mainnet_with_spec(SpecId::default()),
        EthPrecompiles::new(SpecId::default()),
    );

    println!("[fork] start inspect tx with {} patches", patch_count);
    let t0 = std::time::Instant::now();
    let result = evm.inspect_tx(tx);
    let elapsed = t0.elapsed();

    // 不保存缓存 — fork 可能走新路径，污染主缓存
    drop(evm);

    // 计算并发送余额/token 变化（与 evm_runner fork 路径对齐）
    if let Ok(ref r) = result {
        let json = crate::op_trace::evm_runner::compute_and_print_balance_changes(
            &r.state,
            r.result.logs(),
        );
        inspector.send_balance_changes(&json);
    }

    inspector.flush_steps();

    {
        let finished_session = match Arc::try_unwrap(session) {
            Ok(mutex) => mutex.into_inner().unwrap(),
            Err(arc) => {
                let mut lock = arc.lock().unwrap();
                std::mem::replace(&mut *lock, DebugSession::new())
            }
        };
        let trace_len = finished_session.trace.len();
        let frame_count = finished_session.frame_memories.len();
        *fork_session_state.write().unwrap() = Some(finished_session);
        println!(
            "[fork] session stored: {} steps, {} frames | {:.1}ms",
            trace_len, frame_count, elapsed.as_secs_f64() * 1000.0,
        );
    }

    inspector.send_finished();

    match result {
        Ok(res) => println!("[fork] Execution Success: {:?}", res.result),
        Err(e) => println!("[fork] EVM Error: {:?}", e),
    }

    Ok(())
}
