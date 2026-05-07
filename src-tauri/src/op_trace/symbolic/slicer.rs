//! 符号源自动发现 — 前向污点传播
//!
//! 对已有 trace 做一遍轻量的"前向污点传播"，无需 SMT。
//! 每个栈槽上挂一个 `HashSet<SymSource>`（影响它的所有叶子输入来源）。
//! 到达目标 JUMPI 时，读取条件槽的 provenance，即为需要符号化的输入集合。

use std::collections::{HashMap, HashSet};
use revm::primitives::U256;

use crate::op_trace::debug_session::TraceStep;
use super::engine::FrameKind;

/// 叶子符号来源
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum SymSource {
    /// CALLDATALOAD(offset)，所在交易
    Calldata { tx_id: u32, offset: usize },
    /// CALLVALUE
    Callvalue { tx_id: u32 },
    /// CALLER
    Caller { tx_id: u32 },
    /// ORIGIN
    Origin { tx_id: u32 },
    /// TIMESTAMP
    Timestamp,
    /// NUMBER
    BlockNumber,
    /// SLOAD(slot) — 该 slot 在当前 trace 中尚未被 SSTORE，视为链上初始值
    StorageInitial { tx_id: u32, slot: String },
}

/// 每个栈槽的来源集合
type Prov = HashSet<SymSource>;

#[inline]
fn union(a: Prov, b: Prov) -> Prov {
    a.into_iter().chain(b).collect()
}

#[inline]
fn union3(a: Prov, b: Prov, c: Prov) -> Prov {
    a.into_iter().chain(b).chain(c).collect()
}

#[inline]
fn slot_hex(v: U256) -> String {
    let bytes = v.to_be_bytes::<32>();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

struct ProvFrame {
    stack: Vec<Prov>,
    mem: HashMap<usize, Prov>,
    calldata: HashMap<usize, Prov>,
    storage: HashMap<String, Prov>,
    transient: HashMap<String, Prov>,
    return_data: Vec<(usize, Prov)>,
    pending_cdata: Option<HashMap<usize, Prov>>,
    kind: FrameKind,
}

impl ProvFrame {
    fn new(calldata: HashMap<usize, Prov>, kind: FrameKind) -> Self {
        Self {
            stack: Vec::new(),
            mem: HashMap::new(),
            calldata,
            storage: HashMap::new(),
            transient: HashMap::new(),
            return_data: Vec::new(),
            pending_cdata: None,
            kind,
        }
    }

    fn pop(&mut self) -> Prov {
        self.stack.pop().unwrap_or_default()
    }

    fn push(&mut self, p: Prov) {
        self.stack.push(p);
    }

    fn push_concrete(&mut self) {
        self.stack.push(Prov::new());
    }
}

struct Slicer {
    frames: Vec<ProvFrame>,
}

impl Slicer {
    fn new() -> Self {
        Self { frames: Vec::new() }
    }

    fn push_frame(&mut self, kind: FrameKind) {
        let calldata = self.frames.last_mut()
            .and_then(|f| f.pending_cdata.take())
            .unwrap_or_default();
        let mut frame = ProvFrame::new(calldata, kind);
        if kind == FrameKind::Delegate {
            if let Some(parent) = self.frames.last() {
                frame.storage = parent.storage.clone();
                frame.transient = parent.transient.clone();
            }
        }
        self.frames.push(frame);
    }

    fn pop_frame(&mut self) {
        if let Some(child) = self.frames.pop() {
            if let Some(parent) = self.frames.last_mut() {
                if child.kind == FrameKind::Delegate {
                    parent.storage = child.storage;
                    parent.transient = child.transient;
                }
                parent.return_data = child.return_data;
                parent.stack.push(Prov::new()); // success flag = concrete
            }
        }
    }

    fn pop(&mut self) -> Prov {
        self.frames.last_mut().map(|f| f.pop()).unwrap_or_default()
    }

    fn push(&mut self, p: Prov) {
        if let Some(f) = self.frames.last_mut() {
            f.push(p);
        }
    }

    fn push_concrete(&mut self) {
        self.push(Prov::new());
    }

    fn binary(&mut self) -> Prov {
        let a = self.pop();
        let b = self.pop();
        union(a, b)
    }

    fn ternary(&mut self) -> Prov {
        let a = self.pop();
        let b = self.pop();
        let c = self.pop();
        union3(a, b, c)
    }

    fn mem_write(&mut self, offset: usize, prov: Prov) {
        if offset < 4 * 1024 * 1024 {
            if let Some(f) = self.frames.last_mut() {
                f.mem.insert(offset, prov);
            }
        }
    }

    /// 清空 [start, end) 内的所有污点条目（用于 MSTORE/COPY 前的区间清理）
    fn mem_clear_range(&mut self, start: usize, end: usize) {
        if let Some(f) = self.frames.last_mut() {
            f.mem.retain(|&k, _| k < start || k >= end);
        }
    }

    fn mem_read(&self, offset: usize) -> Prov {
        self.frames.last()
            .and_then(|f| f.mem.get(&offset))
            .cloned()
            .unwrap_or_default()
    }

    fn mem_read_range(&self, offset: usize, size: usize) -> Prov {
        let mut result = Prov::new();
        if let Some(f) = self.frames.last() {
            let end = offset.saturating_add(size);
            for (&k, v) in &f.mem {
                if k >= offset && k < end {
                    result.extend(v.iter().cloned());
                }
            }
        }
        result
    }

    fn prepare_inner_calldata(&mut self, args_offset: usize, args_size: usize) {
        let mut inner = HashMap::new();
        if let Some(f) = self.frames.last() {
            let end = args_offset.saturating_add(args_size);
            for (&k, v) in &f.mem {
                if k >= args_offset && k < end {
                    inner.insert(k - args_offset, v.clone());
                }
            }
        }
        if let Some(f) = self.frames.last_mut() {
            f.pending_cdata = Some(inner);
        }
    }

    /// 到达目标 JUMPI 时，返回栈顶第 1 个槽（条件）的 provenance
    fn jumpi_condition_prov(&self) -> Prov {
        self.frames.last().and_then(|f| {
            // stack top=0 is dest, top=1 is condition
            let len = f.stack.len();
            if len >= 2 { Some(f.stack[len - 2].clone()) } else { None }
        }).unwrap_or_default()
    }

    fn step(&mut self, opcode: u8, sv: impl Fn(usize) -> U256, cur_tx: u32, frame_depth: usize) {
        match opcode {
            0x00 | 0x5b | 0xfe => {}

            // PUSH
            0x5f | 0x60..=0x7f => self.push_concrete(),

            // POP
            0x50 => { self.pop(); }

            // DUP
            0x80..=0x8f => {
                let n = (opcode - 0x7f) as usize;
                let p = self.frames.last().and_then(|f| {
                    let len = f.stack.len();
                    if len >= n { Some(f.stack[len - n].clone()) } else { None }
                }).unwrap_or_default();
                self.push(p);
            }

            // SWAP
            0x90..=0x9f => {
                let n = (opcode - 0x8f) as usize;
                if let Some(f) = self.frames.last_mut() {
                    let len = f.stack.len();
                    if len >= n + 1 {
                        f.stack.swap(len - 1, len - 1 - n);
                    }
                }
            }

            // binary arithmetic / comparison / bitwise
            // 注意：0x08/0x09 (ADDMOD/MULMOD) 是三元运算，0x15 (ISZERO)/0x19 (NOT) 是一元运算
            0x01..=0x07 | 0x0a | 0x0b | 0x10..=0x14 | 0x16..=0x18 | 0x1a..=0x1d => {
                let p = self.binary();
                self.push(p);
            }

            // ADDMOD / MULMOD (ternary)
            0x08 | 0x09 => {
                let p = self.ternary();
                self.push(p);
            }

            // unary: ISZERO, NOT
            0x15 | 0x19 => {
                let p = self.pop();
                self.push(p);
            }

            // KECCAK256 — pop 2 (offset, size), scan mem range
            0x20 => {
                let offset = sv(0).as_limbs()[0] as usize;
                let size   = sv(1).as_limbs()[0] as usize;
                self.pop(); self.pop();
                let p = self.mem_read_range(offset, size);
                self.push(p);
            }

            // ADDRESS, CODESIZE, GASPRICE, RETURNDATASIZE,
            // COINBASE, PREVRANDAO, GASLIMIT, CHAINID, SELFBALANCE, BASEFEE, BLOBBASEFEE,
            // PC, MSIZE, GAS
            0x30 | 0x38 | 0x3a | 0x3d | 0x41 | 0x44 | 0x45 | 0x46 | 0x47 | 0x48
            | 0x4a | 0x58 | 0x59 | 0x5a => self.push_concrete(),

            // ORIGIN
            0x32 => {
                let p = if frame_depth == 0 {
                    HashSet::from([SymSource::Origin { tx_id: cur_tx }])
                } else { Prov::new() };
                self.push(p);
            }

            // CALLER
            0x33 => {
                let p = if frame_depth == 0 {
                    HashSet::from([SymSource::Caller { tx_id: cur_tx }])
                } else { Prov::new() };
                self.push(p);
            }

            // CALLVALUE
            0x34 => {
                let p = if frame_depth == 0 {
                    HashSet::from([SymSource::Callvalue { tx_id: cur_tx }])
                } else { Prov::new() };
                self.push(p);
            }

            // CALLDATASIZE
            0x36 => self.push_concrete(),

            // TIMESTAMP
            0x42 => self.push(HashSet::from([SymSource::Timestamp])),

            // NUMBER
            0x43 => self.push(HashSet::from([SymSource::BlockNumber])),

            // environment reads (pop 1, push 1 concrete)
            0x31 | 0x3b | 0x3f | 0x40 | 0x49 => { self.pop(); self.push_concrete(); }

            // CALLDATALOAD
            0x35 => {
                let offset = sv(0).as_limbs()[0] as usize;
                self.pop();
                // 内层帧：从 frame.calldata 读取（父帧内存传播来的污点）
                // 根帧：标记为叶子 SymSource::Calldata
                let p = if let Some(f) = self.frames.last() {
                    if let Some(cd_prov) = f.calldata.get(&offset) {
                        cd_prov.clone()
                    } else if f.kind == FrameKind::Normal && self.frames.len() == 1 {
                        // 根帧且 calldata 中无该偏移的污点 → 叶子来源
                        HashSet::from([SymSource::Calldata { tx_id: cur_tx, offset }])
                    } else {
                        // 内层帧且该偏移没有父帧传入的污点 → 具体值
                        Prov::new()
                    }
                } else {
                    HashSet::from([SymSource::Calldata { tx_id: cur_tx, offset }])
                };
                self.push(p);
            }

            // CALLDATACOPY (pop 3, write mem)
            0x37 => {
                let dest      = sv(0).as_limbs()[0] as usize;
                let cd_offset = sv(1).as_limbs()[0] as usize;
                let size      = sv(2).as_limbs()[0] as usize;
                self.pop(); self.pop(); self.pop();
                self.mem_clear_range(dest, dest.saturating_add(size));
                let end = cd_offset.saturating_add(size);
                let mut to_write = Vec::new();
                if let Some(f) = self.frames.last() {
                    for (&off, prov) in &f.calldata {
                        if off >= cd_offset && off < end {
                            to_write.push((dest + (off - cd_offset), prov.clone()));
                        }
                    }
                }
                for (dst, p) in to_write {
                    self.mem_write(dst, p);
                }
            }

            // CODECOPY — 清空目标区间（code 具体，无污点来源）
            0x39 => {
                let dest = sv(0).as_limbs()[0] as usize;
                let size = sv(2).as_limbs()[0] as usize;
                self.pop(); self.pop(); self.pop();
                self.mem_clear_range(dest, dest.saturating_add(size));
            }

            // RETURNDATACOPY
            0x3e => {
                let dest      = sv(0).as_limbs()[0] as usize;
                let ret_off   = sv(1).as_limbs()[0] as usize;
                let size      = sv(2).as_limbs()[0] as usize;
                self.pop(); self.pop(); self.pop();
                self.mem_clear_range(dest, dest.saturating_add(size));
                let end = ret_off.saturating_add(size);
                let mut to_write = Vec::new();
                if let Some(f) = self.frames.last() {
                    for (off, prov) in &f.return_data {
                        if *off >= ret_off && *off < end {
                            to_write.push((dest + (*off - ret_off), prov.clone()));
                        }
                    }
                }
                for (dst, p) in to_write {
                    self.mem_write(dst, p);
                }
            }

            // EXTCODECOPY — 外部代码具体，清空目标区间
            0x3c => {
                let dest = sv(1).as_limbs()[0] as usize;
                let size = sv(3).as_limbs()[0] as usize;
                self.pop(); self.pop(); self.pop(); self.pop();
                self.mem_clear_range(dest, dest.saturating_add(size));
            }

            // MLOAD — exact match then range scan
            0x51 => {
                let offset = sv(0).as_limbs()[0] as usize;
                self.pop();
                let p = {
                    let exact = self.mem_read(offset);
                    if !exact.is_empty() {
                        exact
                    } else {
                        self.mem_read_range(offset + 1, 31)
                    }
                };
                self.push(p);
            }

            // MSTORE
            0x52 => {
                let offset = sv(0).as_limbs()[0] as usize;
                self.pop();
                let val = self.pop();
                // 清空 [offset, offset+32) 内的陈旧污点后再写入
                self.mem_clear_range(offset, offset.saturating_add(32));
                self.mem_write(offset, val);
            }

            // MSTORE8
            0x53 => {
                let offset = sv(0).as_limbs()[0] as usize;
                self.pop();
                let val = self.pop();
                self.mem_write(offset, val);
            }

            // SLOAD
            0x54 => {
                let slot = slot_hex(sv(0));
                self.pop();
                let p = if let Some(stored) = self.frames.last().and_then(|f| f.storage.get(&slot)) {
                    stored.clone()
                } else {
                    HashSet::from([SymSource::StorageInitial { tx_id: cur_tx, slot }])
                };
                self.push(p);
            }

            // SSTORE
            0x55 => {
                let slot = slot_hex(sv(0));
                self.pop();
                let val = self.pop();
                if let Some(f) = self.frames.last_mut() {
                    f.storage.insert(slot, val);
                }
            }

            // TLOAD
            0x5c => {
                let slot = slot_hex(sv(0));
                self.pop();
                let p = self.frames.last()
                    .and_then(|f| f.transient.get(&slot)).cloned()
                    .unwrap_or_default();
                self.push(p);
            }

            // TSTORE
            0x5d => {
                let slot = slot_hex(sv(0));
                self.pop();
                let val = self.pop();
                if let Some(f) = self.frames.last_mut() {
                    f.transient.insert(slot, val);
                }
            }

            // MCOPY
            0x5e => {
                let dst  = sv(0).as_limbs()[0] as usize;
                let src  = sv(1).as_limbs()[0] as usize;
                let size = sv(2).as_limbs()[0] as usize;
                self.pop(); self.pop(); self.pop();
                let src_end = src.saturating_add(size);
                let mut to_write = Vec::new();
                if let Some(f) = self.frames.last() {
                    for (&k, v) in &f.mem {
                        if k >= src && k < src_end {
                            to_write.push((dst + (k - src), v.clone()));
                        }
                    }
                }
                self.mem_clear_range(dst, dst.saturating_add(size));
                for (off, p) in to_write {
                    self.mem_write(off, p);
                }
            }

            // JUMP
            0x56 => { self.pop(); }

            // JUMPI — reach here only if step < target; pop normally
            0x57 => { self.pop(); self.pop(); }

            // RETURN (capture return data provenance)
            0xf3 => {
                let offset = sv(0).as_limbs()[0] as usize;
                let size   = sv(1).as_limbs()[0] as usize;
                self.pop(); self.pop();
                let mut ret = Vec::new();
                if let Some(f) = self.frames.last() {
                    let end = offset.saturating_add(size);
                    for (&k, v) in &f.mem {
                        if k >= offset && k < end {
                            ret.push((k - offset, v.clone()));
                        }
                    }
                    ret.sort_by_key(|(off, _)| *off);
                }
                if let Some(f) = self.frames.last_mut() {
                    f.return_data = ret;
                }
            }

            // REVERT
            0xfd => {
                let offset = sv(0).as_limbs()[0] as usize;
                let size   = sv(1).as_limbs()[0] as usize;
                self.pop(); self.pop();
                let mut ret = Vec::new();
                if let Some(f) = self.frames.last() {
                    let end = offset.saturating_add(size);
                    for (&k, v) in &f.mem {
                        if k >= offset && k < end {
                            ret.push((k - offset, v.clone()));
                        }
                    }
                    ret.sort_by_key(|(off, _)| *off);
                }
                if let Some(f) = self.frames.last_mut() {
                    f.return_data = ret;
                }
            }

            // SELFDESTRUCT
            0xff => { self.pop(); }

            // LOG0-LOG4
            0xa0 => { self.pop(); self.pop(); }
            0xa1 => { for _ in 0..3 { self.pop(); } }
            0xa2 => { for _ in 0..4 { self.pop(); } }
            0xa3 => { for _ in 0..5 { self.pop(); } }
            0xa4 => { for _ in 0..6 { self.pop(); } }

            // CALL / CALLCODE
            0xf1 | 0xf2 => {
                let args_offset = sv(3).as_limbs()[0] as usize;
                let args_size   = sv(4).as_limbs()[0] as usize;
                for _ in 0..7 { self.pop(); }
                self.prepare_inner_calldata(args_offset, args_size);
            }

            // DELEGATECALL / STATICCALL
            0xf4 | 0xfa => {
                let args_offset = sv(2).as_limbs()[0] as usize;
                let args_size   = sv(3).as_limbs()[0] as usize;
                for _ in 0..6 { self.pop(); }
                self.prepare_inner_calldata(args_offset, args_size);
            }

            // CREATE
            0xf0 => { for _ in 0..3 { self.pop(); } }

            // CREATE2
            0xf5 => { for _ in 0..4 { self.pop(); } }

            _ => {
                let (pops, pushes) = opcode_stack_effect(opcode);
                for _ in 0..pops { self.pop(); }
                for _ in 0..pushes { self.push_concrete(); }
            }
        }
    }
}

/// 对目标 JUMPI（target_step）进行前向污点传播，返回所有影响其条件的符号来源。
///
/// 算法：单遍前向遍历 trace[0..=target_step]，用 `HashSet<SymSource>` 代替
/// `Option<Expr>` 做传播。到达 target_step 时读取 JUMPI 条件槽的 provenance。
pub fn slice_for_jumpi(
    trace: &[TraceStep],
    frame_depths: &HashMap<u32, usize>,
    target_step: u32,
) -> HashSet<SymSource> {
    let mut slicer = Slicer::new();
    slicer.frames.push(ProvFrame::new(HashMap::new(), FrameKind::Normal));

    let mut prev_depth: usize = 0;
    let mut prev_tx: Option<u32> = None;

    for (i, step) in trace.iter().enumerate() {
        if i as u32 > target_step { break; }

        let cur_depth = *frame_depths.get(&(i as u32)).unwrap_or(&0);
        let cur_tx = step.transaction_id;

        // 交易切换 → 重置帧
        if prev_tx != Some(cur_tx) {
            slicer.frames.clear();
            slicer.frames.push(ProvFrame::new(HashMap::new(), FrameKind::Normal));
            prev_depth = 0;
            prev_tx = Some(cur_tx);
        }

        // 帧深度变化处理
        while cur_depth > prev_depth {
            let kind = if i > 0 && trace[i - 1].opcode == 0xf4 && cur_depth == prev_depth + 1 {
                FrameKind::Delegate
            } else {
                FrameKind::Normal
            };
            slicer.push_frame(kind);
            prev_depth += 1;
        }
        while cur_depth < prev_depth {
            slicer.pop_frame();
            prev_depth -= 1;
        }

        // 到达目标步骤 — 在执行前读取条件
        if i as u32 == target_step {
            return slicer.jumpi_condition_prov();
        }

        let slen = step.stack.len();
        let sv = |idx: usize| -> U256 {
            if idx < slen { step.stack[slen - 1 - idx] } else { U256::ZERO }
        };
        slicer.step(step.opcode, sv, cur_tx, cur_depth);
    }

    HashSet::new()
}

fn opcode_stack_effect(op: u8) -> (usize, usize) {
    match op {
        0x00 | 0x5b | 0xfe => (0, 0),
        // binary: 排除 0x08/0x09 (ternary) 和 0x15/0x19 (unary)
        0x01..=0x07 | 0x0a | 0x0b
        | 0x10..=0x14 | 0x16..=0x18 | 0x1a..=0x1d => (2, 1),
        0x08 | 0x09 => (3, 1),
        0x15 | 0x19 => (1, 1),
        0x20 => (2, 1),
        0x30 | 0x32..=0x34 | 0x36 | 0x38 | 0x3a | 0x3d
        | 0x41..=0x48 | 0x4a | 0x58..=0x5a => (0, 1),
        0x5f | 0x60..=0x7f => (0, 1),
        0x31 | 0x3b | 0x3f | 0x40 | 0x49 => (1, 1),
        0x35 | 0x51 | 0x54 | 0x5c => (1, 1),
        0x37 | 0x39 | 0x3e | 0x5e => (3, 0),
        0x3c => (4, 0),
        0x50 | 0x56 | 0xff => (1, 0),
        0x52 | 0x53 | 0x55 | 0x5d | 0xf3 | 0xfd => (2, 0),
        0x57 => (2, 0),
        0x80..=0x8f => (0, 1),
        0x90..=0x9f => (0, 0),
        0xa0 => (2, 0), 0xa1 => (3, 0), 0xa2 => (4, 0),
        0xa3 => (5, 0), 0xa4 => (6, 0),
        0xf0 => (3, 0),
        0xf1 | 0xf2 => (7, 0),
        0xf4 | 0xfa => (6, 0),
        0xf5 => (4, 0),
        _ => (0, 0),
    }
}
