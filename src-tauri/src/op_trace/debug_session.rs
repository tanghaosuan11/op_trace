use revm::primitives::{Address, U256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 每个step的轻量存储，供 seek_to 使用
#[derive(Clone)]
pub struct TraceStep {
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
    pub frame_memories: HashMap<u16, FrameMemory>,
    /// per-context 步骤索引：context_id → 全局步骤下标数组（单调递增）
    pub step_index: HashMap<u16, Vec<usize>>,
}

impl DebugSession {
    pub fn new() -> Self {
        Self {
            trace: Vec::new(),
            frame_memories: HashMap::new(),
            step_index: HashMap::new(),
        }
    }

    /// 追加一个 step 到 trace 并更新索引
    pub fn push_step(&mut self, step: TraceStep) {
        let idx = self.trace.len();
        let cid = step.context_id;
        self.trace.push(step);
        self.step_index.entry(cid).or_default().push(idx);
    }

    /// 追加全量内存快照
    pub fn push_snapshot(&mut self, context_id: u16, frame_step: u32, data: Vec<u8>) {
        self.frame_memories
            .entry(context_id)
            .or_insert_with(FrameMemory::new)
            .snapshots
            .push(MemorySnapshot { frame_step, data });
    }

    /// 追加增量内存补丁
    pub fn push_patch(&mut self, context_id: u16, frame_step: u32, dst_offset: u32, data: Vec<u8>) {
        self.frame_memories
            .entry(context_id)
            .or_insert_with(FrameMemory::new)
            .patches
            .push(MemoryPatch { frame_step, dst_offset, data });
    }

    /// 计算指定 frame 在指定 frame_step 时的完整内存
    pub fn compute_memory_at_step(&self, context_id: u16, target_frame_step: u32) -> Vec<u8> {
        let fm = match self.frame_memories.get(&context_id) {
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
            return snapshot.data.clone();
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

        // 计算所需最大内存大小
        let mut max_size = snapshot.data.len();
        for i in patch_start..patch_end {
            let end = patches[i].dst_offset as usize + patches[i].data.len();
            if end > max_size {
                max_size = end;
            }
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
        let context_id = current.context_id;
        let indices = self.step_index.get(&context_id)?;
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
pub struct DebugSessionState(pub Arc<Mutex<Option<DebugSession>>>);
