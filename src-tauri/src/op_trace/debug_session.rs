use revm::primitives::{Address, U256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 多笔调试时定位一帧：每笔内 `frame_id` 从 1 递增，跨笔用 `transaction_id` 区分。
pub type FrameScopeKey = (u32, u16);

/// CFG 构建结果缓存键（与 `doc/CFG_后端分块与裁剪方案.md` §9 一致：bytecode + trace + onlyExecuted + frame 成败）
#[derive(Clone, Hash, PartialEq, Eq)]
pub struct CfgBuildCacheKey {
    pub transaction_id: u32,
    pub context_id: u16,
    pub bytecode_digest: [u8; 32],
    pub trace_digest: [u8; 32],
    pub only_executed: bool,
    /// 0 = 无 `frame_map` 记录，1 = success，2 = 失败
    pub frame_success_bucket: u8,
    /// `opcode_lines` 等展示策略变更时递增，避免命中旧缓存
    pub payload_version: u8,
}


/// Saved once per call frame; populated at call() and finalized at call_end().
#[derive(Clone)]
pub struct FrameRecord {
    pub transaction_id: u32,
    pub frame_id:        u16,
    pub parent_id:       u16,
    pub depth:           u16,
    /// Bytecode address (contract executing the code)
    pub address:         Address,
    pub caller:          Address,
    /// Call target address (may differ from address for DelegateCall)
    pub target_address:  Address,
    /// "Call" | "StaticCall" | "DelegateCall" | "CallCode" | "Create" | "Create2"
    pub kind:            String,
    pub gas_limit:       u64,
    /// Filled at call_end
    pub gas_used:        u64,
    /// Total steps executed inside this frame; filled at call_end
    pub step_count:      usize,
    /// Whether the call succeeded; filled at call_end
    pub success:         bool,
}


/// One storage read or write event, recorded during execution.
#[derive(Clone)]
pub struct StorageChangeRecord {
    /// Global step index (same convention as TraceStep; 1-indexed step counter at step_end)
    pub step_index:  usize,
    /// 多笔交易时第几笔（0-based）；单 tx 恒为 0
    pub transaction_id: u32,
    pub frame_id:    u16,
    pub is_transient: bool,
    /// true = SLOAD/TLOAD read, false = SSTORE/TSTORE write
    pub is_read:     bool,
    pub address:     Address,
    pub key:         U256,
    /// For reads: old_value is zero (irrelevant). For writes: value before this write.
    pub old_value:   U256,
    /// For reads: the value returned. For writes: the new value written.
    pub new_value:   U256,
}

/// 每个step的轻量存储，供 seek_to 使用
#[derive(Clone)]
pub struct TraceStep {
    /// 多笔交易时第几笔（0-based）；单 tx 恒为 0
    pub transaction_id: u32,
    pub context_id: u16,
    pub frame_step: u32,    // frame 内部步数
    pub pc: u32,
    pub opcode: u8,
    pub gas_cost: u64,
    pub gas_remaining: u64,
    pub stack: Vec<U256>,
    /// 当前执行代码所在合约地址（bytecode_address）
    pub contract_address: Address,
    /// 当前 frame 的 call target 地址（target_address）
    pub call_target: Address,
}

/// frame 的全量内存快照（每 50 步一个）
pub struct MemorySnapshot {
    pub frame_step: u32,
    pub data: Vec<u8>,      // 原始字节，不做 hex 转换
}

/// frame 的增量内存补丁
pub struct MemoryPatch {
    pub frame_step: u32,
    pub dst_offset: u32,
    pub data: Vec<u8>,
}

/// Frame 结束后的终态（post-state）。
/// 只在 call_end/create_end 时写入一次，供 seek_to 在“frame 已结束”时返回。
#[derive(Clone)]
pub struct FrameTerminalState {
    pub pc: u32,
    pub opcode: u8,
    pub stack: Vec<U256>,
    pub memory: Vec<u8>,
}

/// 每个 frame 的内存追踪数据
pub struct FrameMemory {
    pub snapshots: Vec<MemorySnapshot>,
    pub patches: Vec<MemoryPatch>,
}

impl FrameMemory {
    pub fn new() -> Self {
        Self {
            snapshots: Vec::new(),
            patches: Vec::new(),
        }
    }
}

/// 调试会话：执行结束后持久存储，供 seek_to 查询
pub struct DebugSession {
    pub trace: Vec<TraceStep>,
    pub frame_memories: HashMap<FrameScopeKey, FrameMemory>,
    /// per-(transaction_id, context_id) 步骤索引：全局步骤下标数组（单调递增）
    pub step_index: HashMap<FrameScopeKey, Vec<usize>>,
    /// (transaction_id, frame_id) → frame metadata（frame_id 每笔内从 1 起）
    pub frame_map: HashMap<FrameScopeKey, FrameRecord>,
    /// All storage read/write events in execution order
    pub storage_changes: Vec<StorageChangeRecord>,
    /// 数据流追踪（Shadow Stack / Memory / Storage）
    pub shadow: Option<super::shadow::ShadowState>,
    /// 每帧的字节码，供 CFG 后端构建使用
    pub frame_bytecodes: HashMap<FrameScopeKey, Vec<u8>>,
    /// 每帧终态（frame 已退出后的 post-state）
    pub frame_terminal_states: HashMap<FrameScopeKey, FrameTerminalState>,
    /// `build_cfg` 结果缓存（bincode 序列化的 `CfgResult`）
    pub cfg_build_cache: HashMap<CfgBuildCacheKey, Vec<u8>>,
}

impl DebugSession {
    pub fn new() -> Self {
        Self {
            trace: Vec::new(),
            frame_memories: HashMap::new(),
            step_index: HashMap::new(),
            frame_map: HashMap::new(),
            storage_changes: Vec::new(),
            shadow: None,
            frame_bytecodes: HashMap::new(),
            frame_terminal_states: HashMap::new(),
            cfg_build_cache: HashMap::new(),
        }
    }

    pub fn push_frame_record(&mut self, record: FrameRecord) {
        let key = (record.transaction_id, record.frame_id);
        self.frame_map.insert(key, record);
    }

    pub fn finalize_frame(
        &mut self,
        transaction_id: u32,
        frame_id: u16,
        gas_used: u64,
        success: bool,
        step_count: usize,
    ) {
        let key = (transaction_id, frame_id);
        if let Some(rec) = self.frame_map.get_mut(&key) {
            rec.gas_used   = gas_used;
            rec.success    = success;
            rec.step_count = step_count;
        }
    }

    pub fn push_storage_change(&mut self, change: StorageChangeRecord) {
        self.storage_changes.push(change);
    }

    /// 追加一个 step 到 trace 并更新索引
    pub fn push_step(&mut self, step: TraceStep) {
        let idx = self.trace.len();
        let key = (step.transaction_id, step.context_id);
        self.trace.push(step);
        self.step_index.entry(key).or_default().push(idx);
    }

    /// 追加全量内存快照
    pub fn push_snapshot(
        &mut self,
        transaction_id: u32,
        context_id: u16,
        frame_step: u32,
        data: Vec<u8>,
    ) {
        let key = (transaction_id, context_id);
        self.frame_memories
            .entry(key)
            .or_insert_with(FrameMemory::new)
            .snapshots
            .push(MemorySnapshot { frame_step, data });
    }

    /// 追加增量内存补丁
    pub fn push_patch(
        &mut self,
        transaction_id: u32,
        context_id: u16,
        frame_step: u32,
        dst_offset: u32,
        data: Vec<u8>,
    ) {
        let key = (transaction_id, context_id);
        self.frame_memories
            .entry(key)
            .or_insert_with(FrameMemory::new)
            .patches
            .push(MemoryPatch { frame_step, dst_offset, data });
    }

    pub fn set_terminal_state(
        &mut self,
        transaction_id: u32,
        context_id: u16,
        state: FrameTerminalState,
    ) {
        self.frame_terminal_states
            .insert((transaction_id, context_id), state);
    }

    /// 计算指定 frame 在指定 frame_step 时的完整内存
    pub fn compute_memory_at_step(
        &self,
        transaction_id: u32,
        context_id: u16,
        target_frame_step: u32,
    ) -> Vec<u8> {
        let key = (transaction_id, context_id);
        let fm = match self.frame_memories.get(&key) {
            Some(fm) => fm,
            None => return Vec::new(),
        };

        if fm.snapshots.is_empty() {
            return Vec::new();
        }

        // 二分找最大的 snapshot.frame_step <= target_frame_step
        let snap_idx = match fm.snapshots.binary_search_by(|s| s.frame_step.cmp(&target_frame_step)) {
            Ok(i) => i,
            Err(0) => return Vec::new(),
            Err(i) => i - 1,
        };

        let snapshot = &fm.snapshots[snap_idx];
        let snapshot_step = snapshot.frame_step;

        // 二分找 patch 范围: patch.frame_step in (snapshot_step, target_frame_step]
        let patches = &fm.patches;
        if patches.is_empty() {
            let mut data = snapshot.data.clone();
            let len = data.len();
            if len % 32 != 0 {
                data.resize((len / 32 + 1) * 32, 0);
            }
            return data;
        }

        // patch_start: 第一个 frame_step > snapshot_step
        let patch_start = match patches.binary_search_by(|p| {
            if p.frame_step <= snapshot_step { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater }
        }) {
            Err(i) => i,
            Ok(_) => unreachable!(),
        };

        // patch_end: 最后一个 frame_step <= target_frame_step
        let patch_end = match patches.binary_search_by(|p| {
            if p.frame_step <= target_frame_step { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater }
        }) {
            Err(i) => i,  // i is insert point, so i-1 is the last <=
            Ok(_) => unreachable!(),
        };

        if patch_start >= patch_end {
            return snapshot.data.clone();
        }

        // 计算所需最大内存大小，向上取整到 32 字节（EVM 以 word 为单位扩展内存）
        let mut max_size = snapshot.data.len();
        for i in patch_start..patch_end {
            let end = patches[i].dst_offset as usize + patches[i].data.len();
            if end > max_size {
                max_size = end;
            }
        }
        // 对齐到 32 字节倍数
        if max_size % 32 != 0 {
            max_size = (max_size / 32 + 1) * 32;
        }

        let mut mem = vec![0u8; max_size];
        mem[..snapshot.data.len()].copy_from_slice(&snapshot.data);

        // 按序叠加 patches
        for i in patch_start..patch_end {
            let p = &patches[i];
            let dst = p.dst_offset as usize;
            mem[dst..dst + p.data.len()].copy_from_slice(&p.data);
        }

        mem
    }

    /// 向前查找最近一次 `value` 出现在栈顶的 step 的全局下标
    /// 即：最近一个 k < global_index 满足 trace[k].stack.last() == value
    /// 仅在当前 context_id 内搜索
    pub fn find_value_origin(&self, global_index: usize, value: U256) -> Option<usize> {
        let current = self.trace.get(global_index)?;
        let key = (current.transaction_id, current.context_id);
        let indices = self.step_index.get(&key)?;
        // pos-1 对应 global_index，搜索范围是 0..pos-1（不含当前步）
        let pos = indices.partition_point(|&i| i <= global_index);
        if pos < 2 {
            return None;
        }
        for k in (0..pos - 1).rev() {
            let gi = indices[k];
            if self.trace[gi].stack.last() == Some(&value) {
                return Some(gi);
            }
        }
        None
    }
}

/// Tauri 全局状态
pub type SessionId = String;
#[derive(Default)]
pub struct SessionEntry {
    /// 执行结束后持久化的 DebugSession；执行中为 None
    pub session: Option<DebugSession>,
    /// 是否正在运行 op_trace（防止同一会话并发启动/覆盖）
    pub is_running: bool,
    /// 最近更新时间戳（毫秒），用于后续回收策略
    pub updated_at_ms: u64,
}

pub type DebugSessionMap = HashMap<SessionId, SessionEntry>;

pub const DEFAULT_SESSION_ID: &str = "__default__";

pub fn normalize_session_id(session_id: Option<&str>) -> SessionId {
    match session_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => id.to_string(),
        None => DEFAULT_SESSION_ID.to_string(),
    }
}

pub fn no_session_error(session_id: &str) -> String {
    format!("No debug session active for session_id={}", session_id)
}

pub struct DebugSessionState(pub Arc<Mutex<DebugSessionMap>>);
