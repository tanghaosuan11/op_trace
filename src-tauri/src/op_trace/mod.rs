use alloy_provider::{network::Ethereum, DynProvider};
use revm::{
    database::{AlloyDB, CacheDB},
    database_interface::WrapDatabaseAsync,
};
use serde::Serialize;

mod evm_runner;
mod inspector;
mod message_encoder;
mod scan;
pub mod debug_session;
mod types;
mod frame_manager;
mod tracer;
pub mod fork;

pub use debug_session::DebugSessionState;
pub use evm_runner::op_trace;
pub use scan::{ConditionGroup, scan_conditions_impl};
pub use types::{BlockDebugData, TxDebugData};

pub(crate) type AlloyCacheDB = CacheDB<WrapDatabaseAsync<AlloyDB<Ethereum, DynProvider>>>;

/// 每个 frame 在 seek 目标时刻的状态
#[derive(Serialize)]
pub struct FrameState {
    pub context_id: u16,
    pub pc: u32,
    pub gas_cost: u64,
    pub stack: Vec<String>,   // hex strings (0x + 64 chars) 与 JS 一致
    pub memory: String,       // "0x" + hex
}

#[derive(Serialize)]
pub struct SeekResult {
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
    let active_context_id = target_step.context_id;

    let mut frames = Vec::new();

    for (ctx_id, indices) in &session.step_index {
        // 二分找 indices 中 <= global_index 的最大值
        let last_global = match indices.binary_search(&global_index) {
            Ok(i) => indices[i],
            Err(0) => continue, // 该 frame 还没执行过
            Err(i) => indices[i - 1],
        };

        let step = &session.trace[last_global];

        // 计算内存
        let mem_bytes = session.compute_memory_at_step(*ctx_id, step.frame_step);
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
        let stack: Vec<String> = step.stack.iter().map(|v| {
            let bytes = v.to_be_bytes::<32>();
            let mut s = String::with_capacity(66);
            s.push_str("0x");
            for b in &bytes {
                s.push_str(&format!("{:02x}", b));
            }
            s
        }).collect();

        frames.push(FrameState {
            context_id: *ctx_id,
            pc: step.pc,
            gas_cost: step.gas_cost,
            stack,
            memory,
        });
    }

    Some(SeekResult {
        active_context_id,
        frames,
    })
}


/// 单步完整数据（用于小步数预取缓存）
#[derive(Serialize)]
pub struct StepFullData {
    pub step_index: usize,
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

            let mem_bytes = session.compute_memory_at_step(step.context_id, step.frame_step);
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
