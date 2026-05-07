use alloy_provider::{network::Ethereum, DynProvider};
use revm::{
    database::{AlloyDB, CacheDB},
    database_interface::WrapDatabaseAsync,
};
use serde::Serialize;

pub mod evm_runner;
mod inspector;
pub(crate) mod message_encoder;
mod scan;
pub mod debug_session;
pub mod types;
mod frame_manager;
mod tracer;
pub mod shadow;
pub mod fork;
pub mod cfg_builder;
pub mod symbolic;
pub mod decompile;
pub mod cache;
pub mod balance_diff;
mod prestate;
mod spec_schedule;
pub mod foundry_dump;
pub mod foundry_calltree;

pub use debug_session::DebugSessionState;
pub use evm_runner::{op_trace, tx_env_from_debug};
pub use frame_manager::FrameInfo;
pub use scan::{ConditionGroup, scan_conditions_impl};
pub use types::{BlockDebugData, TxDebugData};

pub(crate) type AlloyCacheDB = CacheDB<WrapDatabaseAsync<AlloyDB<Ethereum, DynProvider>>>;

/// 每个 frame 在 seek 目标时刻的状态
#[derive(Serialize)]
pub struct FrameState {
    pub transaction_id: u32,
    pub context_id: u16,
    pub pc: u32,
    pub gas_cost: u64,
    pub stack: Vec<String>,   // hex strings (0x + 64 chars) 与 JS 一致
    pub memory: String,       // "0x" + hex
}

#[derive(Serialize)]
pub struct SeekResult {
    pub active_transaction_id: u32,
    pub active_context_id: u16,
    pub frames: Vec<FrameState>,
}

/// 从 Rust DebugSession 中查询指定全局步骤的所有 frame 状态
pub fn seek_to_impl(
    session: &debug_session::DebugSession,
    global_index: usize,
) -> Option<SeekResult> {
    if global_index >= session.trace.len() {
        return None;
    }

    let target_step = &session.trace[global_index];
    let active_transaction_id = target_step.transaction_id;
    let active_context_id = target_step.context_id;

    let mut frames = Vec::new();

    for ((tid, ctx_id), indices) in &session.step_index {
        // 二分找 indices 中 <= global_index 的最大值
        let last_global = match indices.binary_search(&global_index) {
            Ok(i) => indices[i],
            Err(0) => continue, // 该 frame 还没执行过
            Err(i) => indices[i - 1],
        };

        let step = &session.trace[last_global];
        let frame_has_ended = global_index > last_global
            && session
                .frame_terminal_states
                .contains_key(&(*tid, *ctx_id));

        // frame 已结束时优先返回 terminal/post-state，避免子 frame 永远停在 RETURN 前
        let (pc, gas_cost, stack, mem_bytes) = if frame_has_ended {
            if let Some(terminal) = session.frame_terminal_states.get(&(*tid, *ctx_id)) {
                (
                    terminal.pc,
                    step.gas_cost,
                    terminal.stack.clone(),
                    terminal.memory.clone(),
                )
            } else {
                (
                    step.pc,
                    step.gas_cost,
                    step.stack.clone(),
                    session.compute_memory_at_step(*tid, *ctx_id, step.frame_step),
                )
            }
        } else {
            (
                step.pc,
                step.gas_cost,
                step.stack.clone(),
                session.compute_memory_at_step(*tid, *ctx_id, step.frame_step),
            )
        };

        let memory = if mem_bytes.is_empty() {
            "0x".to_string()
        } else {
            let mut hex = String::with_capacity(2 + mem_bytes.len() * 2);
            hex.push_str("0x");
            for b in &mem_bytes {
                hex.push_str(&format!("{:02x}", b));
            }
            hex
        };

        // 转换 stack 为 hex strings
        let stack: Vec<String> = stack.iter().map(|v| {
            let bytes = v.to_be_bytes::<32>();
            let mut s = String::with_capacity(66);
            s.push_str("0x");
            for b in &bytes {
                s.push_str(&format!("{:02x}", b));
            }
            s
        }).collect();

        frames.push(FrameState {
            transaction_id: *tid,
            context_id: *ctx_id,
            pc,
            gas_cost,
            stack,
            memory,
        });
    }

    // println!(
    //     "[seek_to] index={} → {} frames: {}",
    //     global_index,
    //     frames.len(),
    //     frames.iter().map(|f| format!("({},{}):stack={}", f.transaction_id, f.context_id, f.stack.len())).collect::<Vec<_>>().join(", ")
    // );
    Some(SeekResult {
        active_transaction_id,
        active_context_id,
        frames,
    })
}


/// 单步完整数据（用于小步数预取缓存）
#[derive(Serialize)]
pub struct StepFullData {
    pub step_index: usize,
    pub transaction_id: u32,
    pub context_id: u16,
    pub pc: u32,
    pub opcode: u8,
    pub gas_cost: u64,
    pub gas_remaining: u64,
    pub stack: Vec<String>,
    pub memory: String,
}

/// 返回 [start, end] 范围内每步的全量数据
pub fn range_full_data_impl(
    session: &debug_session::DebugSession,
    start: usize,
    end: usize,
) -> Vec<StepFullData> {
    let total = session.trace.len();
    if start >= total {
        return Vec::new();
    }
    let end = end.min(total - 1);

    (start..=end)
        .map(|i| {
            let step = &session.trace[i];

            let mem_bytes =
                session.compute_memory_at_step(step.transaction_id, step.context_id, step.frame_step);
            let memory = if mem_bytes.is_empty() {
                "0x".to_string()
            } else {
                let mut hex = String::with_capacity(2 + mem_bytes.len() * 2);
                hex.push_str("0x");
                for b in &mem_bytes {
                    use std::fmt::Write;
                    let _ = write!(hex, "{:02x}", b);
                }
                hex
            };

            let stack: Vec<String> = step.stack.iter().map(|v| {
                let bytes = v.to_be_bytes::<32>();
                let mut s = String::with_capacity(66);
                s.push_str("0x");
                for b in &bytes {
                    use std::fmt::Write;
                    let _ = write!(s, "{:02x}", b);
                }
                s
            }).collect();

            StepFullData {
                step_index: i,
                transaction_id: step.transaction_id,
                context_id: step.context_id,
                pc: step.pc,
                opcode: step.opcode,
                gas_cost: step.gas_cost,
                gas_remaining: step.gas_remaining,
                stack,
                memory,
            }
        })
        .collect()
}
