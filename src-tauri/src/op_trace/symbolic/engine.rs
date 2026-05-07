//! 符号执行引擎，与影子栈(ShadowState)完全独立。

use std::collections::HashMap;
use revm::primitives::U256;

use super::{SymConfig, solver::PathConstraint};
use super::expr::Expr;

/// U256 → 64-char lowercase hex (used as sym_storage key)
#[inline]
fn slot_hex(v: U256) -> String {
    let bytes = v.to_be_bytes::<32>();
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 去掉前导 0 的 slot 短名（"0000..0a" → "a"，全 0 → "0"）
#[inline]
fn slot_short(v: U256) -> String {
    let h = slot_hex(v);
    let t = h.trim_start_matches('0');
    if t.is_empty() { "0".into() } else { t.to_string() }
}

/// 反编译模式下生成环境符号：根帧使用 `name`，子帧加深度后缀 `name@d{depth}`
#[inline]
fn env_sym(name: &str, depth: usize) -> Expr {
    if depth == 0 {
        Expr::Sym(name.to_string())
    } else {
        Expr::Sym(format!("{}@d{}", name, depth))
    }
}

/// 计算 Expr 树深度，最多递归到 `limit` 层（超过即返回 limit，用于早退）。
/// 用于 binary() 中防止循环体内表达式树无限增长导致 to_pseudo() 栈溢出。
fn expr_depth_limit(e: &Expr, limit: usize) -> usize {
    if limit == 0 {
        return 0;
    }
    match e {
        Expr::Const(_) | Expr::Sym(_) => 1,
        Expr::Not(a) | Expr::Iszero(a) => 1 + expr_depth_limit(a, limit - 1),
        Expr::Add(a, b) | Expr::Sub(a, b) | Expr::Mul(a, b) | Expr::Div(a, b)
        | Expr::Sdiv(a, b) | Expr::Urem(a, b) | Expr::Srem(a, b) | Expr::Exp(a, b)
        | Expr::Signext(a, b) | Expr::And(a, b) | Expr::Or(a, b) | Expr::Xor(a, b)
        | Expr::Shl(a, b) | Expr::Shr(a, b) | Expr::Sar(a, b) | Expr::Byteop(a, b)
        | Expr::Lt(a, b) | Expr::Gt(a, b) | Expr::Slt(a, b) | Expr::Sgt(a, b)
        | Expr::Eq(a, b) => {
            let da = expr_depth_limit(a, limit - 1);
            let db = expr_depth_limit(b, limit - 1);
            1 + da.max(db)
        }
        Expr::Addmod(a, b, c) | Expr::Mulmod(a, b, c) => {
            let da = expr_depth_limit(a, limit - 1);
            let db = expr_depth_limit(b, limit - 1);
            let dc = expr_depth_limit(c, limit - 1);
            1 + da.max(db).max(dc)
        }
        Expr::Keccak(_, children) => {
            1 + children.iter().map(|c| expr_depth_limit(c, limit - 1)).max().unwrap_or(0)
        }
    }
}

/// 帧的调用方式
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    Normal,
    Delegate,
}

struct SymFrame {
    /// 影子栈：与 EVM 栈一一对应，None = 具体值，Some = 含符号
    sym_stack: Vec<Option<Expr>>,
    /// 内存符号追踪：key = 精确字节偏移
    sym_mem: HashMap<usize, Option<Expr>>,
    /// calldata 符号映射：key = CALLDATALOAD 偏移量
    calldata_sym: HashMap<usize, Option<Expr>>,
    /// 存储符号追踪：key = slot hex
    sym_storage: HashMap<String, Option<Expr>>,
    /// transient storage 符号追踪
    sym_transient: HashMap<String, Option<Expr>>,
    /// 为下一次 CALL 准备的内层 calldata 符号
    pending_call_cdata: Option<HashMap<usize, Option<Expr>>>,
    /// 子帧 RETURN 后暂存的返回数据符号
    pending_return_data: Vec<(usize, Option<Expr>)>,
    /// 帧类型
    kind: FrameKind,
}

impl SymFrame {
    fn new(calldata_sym: HashMap<usize, Option<Expr>>, kind: FrameKind) -> Self {
        Self {
            sym_stack: Vec::new(),
            sym_mem: HashMap::new(),
            calldata_sym,
            sym_storage: HashMap::new(),
            sym_transient: HashMap::new(),
            pending_call_cdata: None,
            pending_return_data: Vec::new(),
            kind,
        }
    }
}


/// 符号执行引擎，不依赖 ShadowState 和 Inspector
pub struct SymbolicEngine {
    frames: Vec<SymFrame>,
    pub path_constraints: Vec<PathConstraint>,
    config: SymConfig,
    keccak_counter: u32,
}

impl SymbolicEngine {
    pub fn new(config: SymConfig) -> Self {
        Self {
            frames: Vec::new(),
            path_constraints: Vec::new(),
            config,
            keccak_counter: 0,
        }
    }


    pub fn push_frame(&mut self, _calldata: &[u8], frame_depth: usize) {
        let calldata_sym = if frame_depth == 0 {
            self.build_root_calldata_sym()
        } else {
            self.frames.last_mut()
                .and_then(|f| f.pending_call_cdata.take())
                .unwrap_or_default()
        };
        self.frames.push(SymFrame::new(calldata_sym, FrameKind::Normal));
    }

    /// 仅用 pending_call_cdata 推入内层帧（离线重放时调用）
    pub fn push_inner_frame(&mut self, kind: FrameKind) {
        let calldata_sym = self.frames.last_mut()
            .and_then(|f| f.pending_call_cdata.take())
            .unwrap_or_default();
        let mut frame = SymFrame::new(calldata_sym, kind);
        // DELEGATECALL: 子帧共享父帧的 storage 和 transient storage
        if kind == FrameKind::Delegate {
            if let Some(parent) = self.frames.last() {
                frame.sym_storage = parent.sym_storage.clone();
                frame.sym_transient = parent.sym_transient.clone();
            }
        }
        self.frames.push(frame);
    }

    /// 弹出内层帧，将 CALL 结果（concrete None）推入父帧栈顶
    pub fn pop_frame(&mut self) {
        if let Some(child) = self.frames.pop() {
            if let Some(parent) = self.frames.last_mut() {
                // DELEGATECALL: 把子帧修改过的 storage/transient 合并回父帧
                if child.kind == FrameKind::Delegate {
                    parent.sym_storage = child.sym_storage;
                    parent.sym_transient = child.sym_transient;
                }
                // 暂存子帧的 return data 符号，供 RETURNDATACOPY 使用
                parent.pending_return_data = child.pending_return_data;
                // CALL/CREATE 的成功标志是具体值（0 或 1），不参与符号化
                parent.sym_stack.push(None);
            }
        }
    }


    #[inline]
    fn pop_sym(&mut self) -> Option<Expr> {
        self.frames.last_mut()?.sym_stack.pop().unwrap_or(None)
    }

    #[inline]
    fn push_sym(&mut self, e: Option<Expr>) {
        if let Some(f) = self.frames.last_mut() {
            f.sym_stack.push(e);
        }
    }

    /// 二元运算通用：弹 a(top), b(second)，根据是否含符号构建表达式后压栈
    /// 若任一操作数的表达式树深度超过 MAX_EXPR_DEPTH，折叠为 None（防止循环体内树无限增长 → to_pseudo 栈溢出）
    fn binary<F>(&mut self, sv0: U256, sv1: U256, make: F)
    where
        F: FnOnce(Box<Expr>, Box<Expr>) -> Expr,
    {
        const MAX_EXPR_DEPTH: usize = 12;
        let a = self.pop_sym();
        let b = self.pop_sym();
        let result = match (a, b) {
            (None, None) => None,
            (a, b) => {
                // 超过深度上限则折叠为 None，避免大型循环中树爆炸
                let a_deep = a.as_ref().map_or(false, |e| expr_depth_limit(e, MAX_EXPR_DEPTH + 1) > MAX_EXPR_DEPTH);
                let b_deep = b.as_ref().map_or(false, |e| expr_depth_limit(e, MAX_EXPR_DEPTH + 1) > MAX_EXPR_DEPTH);
                if a_deep || b_deep {
                    None
                } else {
                    let ea = a.map(Box::new).unwrap_or_else(|| Box::new(Expr::konst(sv0.to_be_bytes())));
                    let eb = b.map(Box::new).unwrap_or_else(|| Box::new(Expr::konst(sv1.to_be_bytes())));
                    Some(make(ea, eb))
                }
            }
        };
        self.push_sym(result);
    }

    /// 一元运算通用（有 Some 才传播）
    fn unary<F>(&mut self, make: F)
    where
        F: FnOnce(Box<Expr>) -> Expr,
    {
        let a = self.pop_sym();
        let result = a.map(|e| make(Box::new(e)));
        self.push_sym(result);
    }


    fn build_root_calldata_sym(&self) -> HashMap<usize, Option<Expr>> {
        let mut map = HashMap::new();
        for (offset, name) in &self.config.calldata_symbols {
            map.insert(*offset, Some(Expr::Sym(name.clone())));
        }
        map
    }

    /// 在 CALL/STATICCALL 时，根据 argsOffset/argsSize 从 sym_mem 构建内层 calldata
    fn prepare_inner_calldata(&mut self, args_offset: usize, args_size: usize) {
        let mut inner = HashMap::new();
        if let Some(frame) = self.frames.last() {
            let end = args_offset.saturating_add(args_size);
            // 扫描 sym_mem 中所有落在 [args_offset, end) 范围内的条目
            for (&mem_off, val) in &frame.sym_mem {
                if mem_off >= args_offset && mem_off < end {
                    inner.insert(mem_off - args_offset, val.clone());
                }
            }
        }
        if let Some(frame) = self.frames.last_mut() {
            frame.pending_call_cdata = Some(inner);
        }
    }


    fn mem_write(&mut self, offset: usize, expr: Option<Expr>) {
        if offset < 4 * 1024 * 1024 {
            if let Some(f) = self.frames.last_mut() {
                f.sym_mem.insert(offset, expr);
            }
        }
    }

    /// 清空内存区间 [start, end) 内所有符号条目（用于 MSTORE/COPY 前的陈旧符号清理）
    fn mem_clear_range(&mut self, start: usize, end: usize) {
        if let Some(f) = self.frames.last_mut() {
            f.sym_mem.retain(|&k, _| k < start || k >= end);
        }
    }

    fn mem_read(&self, offset: usize) -> Option<Expr> {
        self.frames.last()?.sym_mem.get(&offset)?.clone()
    }


    /// 每步调用一次（opcode 执行前），`stack` 为执行前 EVM 栈（bottom..top）
    pub fn on_step(
        &mut self,
        opcode: u8,
        pc: usize,
        global_step: usize,
        transaction_id: u32,
        stack: &[U256],
        frame_depth: usize,
    ) {
        if self.frames.is_empty() {
            return;
        }

        let slen = stack.len();
        // 读取执行前栈顶的具体值辅助函数（从 top 往下数）
        let sv = |i: usize| -> U256 {
            if i < slen { stack[slen - 1 - i] } else { U256::ZERO }
        };

        match opcode {

            0x00 | 0x5b | 0xfe => {}


            0x5f | 0x60..=0x7f => self.push_sym(None),


            0x50 => { self.pop_sym(); }

            // DUP1-DUP16
            0x80..=0x8f => {
                let n = (opcode - 0x7f) as usize; // DUP1→1, …, DUP16→16
                let sym_len = self.frames.last().map(|f| f.sym_stack.len()).unwrap_or(0);
                let idx = sym_len.saturating_sub(n);
                let val = self.frames.last().and_then(|f| f.sym_stack.get(idx)).cloned().unwrap_or(None);
                self.push_sym(val);
            }

            // SWAP1-SWAP16
            0x90..=0x9f => {
                let n = (opcode - 0x8f) as usize; // SWAP1→1, …, SWAP16→16
                if let Some(f) = self.frames.last_mut() {
                    let slen2 = f.sym_stack.len();
                    if slen2 >= n + 1 {
                        f.sym_stack.swap(slen2 - 1, slen2 - 1 - n);
                    }
                }
            }

            // arithmetic binary (pop 2, push 1)
            0x01 => self.binary(sv(0), sv(1), Expr::Add),  // ADD
            0x02 => self.binary(sv(0), sv(1), Expr::Mul),  // MUL
            0x03 => self.binary(sv(0), sv(1), Expr::Sub),  // SUB
            0x04 => self.binary(sv(0), sv(1), Expr::Div),  // DIV
            0x05 => self.binary(sv(0), sv(1), Expr::Sdiv), // SDIV
            0x06 => self.binary(sv(0), sv(1), Expr::Urem), // MOD
            0x07 => self.binary(sv(0), sv(1), Expr::Srem), // SMOD
            0x0a => self.binary(sv(0), sv(1), Expr::Exp),  // EXP
            0x0b => self.binary(sv(0), sv(1), Expr::Signext), // SIGNEXTEND

            // ternary (pop 3, push 1)
            0x08 => { // ADDMOD
                let a = self.pop_sym(); let b = self.pop_sym(); let c = self.pop_sym();
                let (sv0, sv1, sv2) = (sv(0), sv(1), sv(2));
                let result = match (&a, &b, &c) {
                    (None, None, None) => None,
                    _ => {
                        let ea = a.map(Box::new).unwrap_or_else(|| Box::new(Expr::konst(sv0.to_be_bytes())));
                        let eb = b.map(Box::new).unwrap_or_else(|| Box::new(Expr::konst(sv1.to_be_bytes())));
                        let ec = c.map(Box::new).unwrap_or_else(|| Box::new(Expr::konst(sv2.to_be_bytes())));
                        Some(Expr::Addmod(ea, eb, ec))
                    }
                };
                self.push_sym(result);
            }
            0x09 => { // MULMOD
                let a = self.pop_sym(); let b = self.pop_sym(); let c = self.pop_sym();
                let (sv0, sv1, sv2) = (sv(0), sv(1), sv(2));
                let result = match (&a, &b, &c) {
                    (None, None, None) => None,
                    _ => {
                        let ea = a.map(Box::new).unwrap_or_else(|| Box::new(Expr::konst(sv0.to_be_bytes())));
                        let eb = b.map(Box::new).unwrap_or_else(|| Box::new(Expr::konst(sv1.to_be_bytes())));
                        let ec = c.map(Box::new).unwrap_or_else(|| Box::new(Expr::konst(sv2.to_be_bytes())));
                        Some(Expr::Mulmod(ea, eb, ec))
                    }
                };
                self.push_sym(result);
            }

            // unary (pop 1, push 1)
            0x15 => self.unary(Expr::Iszero),  // ISZERO
            0x19 => self.unary(Expr::Not),      // NOT

            // comparison binary
            0x10 => self.binary(sv(0), sv(1), Expr::Lt),  // LT
            0x11 => self.binary(sv(0), sv(1), Expr::Gt),  // GT
            0x12 => self.binary(sv(0), sv(1), Expr::Slt), // SLT
            0x13 => self.binary(sv(0), sv(1), Expr::Sgt), // SGT
            0x14 => self.binary(sv(0), sv(1), Expr::Eq),  // EQ

            // bitwise binary
            0x16 => self.binary(sv(0), sv(1), Expr::And),    // AND
            0x17 => self.binary(sv(0), sv(1), Expr::Or),     // OR
            0x18 => self.binary(sv(0), sv(1), Expr::Xor),    // XOR
            0x1a => self.binary(sv(0), sv(1), Expr::Byteop), // BYTE
            0x1b => self.binary(sv(0), sv(1), Expr::Shl),    // SHL
            0x1c => self.binary(sv(0), sv(1), Expr::Shr),    // SHR
            0x1d => self.binary(sv(0), sv(1), Expr::Sar),    // SAR

            // KECCAK256 (pop 2, push 1)
            0x20 => {
                let offset = sv(0).as_limbs()[0] as usize;
                let size   = sv(1).as_limbs()[0] as usize;
                self.pop_sym(); // offset
                self.pop_sym(); // size
                let mut inputs: Vec<(usize, Expr)> = Vec::new();
                if let Some(frame) = self.frames.last() {
                    let end = offset.saturating_add(size);
                    // 扫描所有落在 [offset, end) 范围内的符号内存条目
                    for (&mem_off, val) in &frame.sym_mem {
                        if mem_off >= offset && mem_off < end {
                            if let Some(e) = val {
                                inputs.push((mem_off, e.clone()));
                            }
                        }
                    }
                    inputs.sort_by_key(|(off, _)| *off);
                }
                let result = if inputs.is_empty() {
                    None
                } else {
                    let uid = self.keccak_counter;
                    self.keccak_counter += 1;
                    Some(Expr::Keccak(uid, inputs.into_iter().map(|(_, e)| e).collect()))
                };
                self.push_sym(result);
            }

            // environment constants (pop 0, push 1)
            // 反编译模式下全部合成为自由符号，使其参与后续表达式传播
            0x30 => {                       // ADDRESS
                let e = if self.config.decompile_mode { Some(env_sym("address", frame_depth)) } else { None };
                self.push_sym(e);
            }
            0x32 => {                       // ORIGIN
                let e = if self.config.origin_sym
                    || self.config.decompile_mode
                {
                    Some(env_sym("origin", frame_depth))
                } else { None };
                self.push_sym(e);
            }
            0x33 => {                       // CALLER
                let e = if self.config.caller_sym || self.config.decompile_mode {
                    Some(env_sym("caller", frame_depth))
                } else { None };
                self.push_sym(e);
            }
            0x34 => {                       // CALLVALUE
                let e = if self.config.callvalue_sym || self.config.decompile_mode {
                    Some(env_sym("callvalue", frame_depth))
                } else { None };
                self.push_sym(e);
            }
            0x36 => {                       // CALLDATASIZE
                let e = if self.config.decompile_mode { Some(env_sym("calldatasize", frame_depth)) } else { None };
                self.push_sym(e);
            }
            0x38 => {                       // CODESIZE
                let e = if self.config.decompile_mode { Some(env_sym("codesize", frame_depth)) } else { None };
                self.push_sym(e);
            }
            0x3a => {                       // GASPRICE
                let e = if self.config.decompile_mode { Some(Expr::Sym("gasprice".into())) } else { None };
                self.push_sym(e);
            }
            0x3d => {                       // RETURNDATASIZE
                let e = if self.config.decompile_mode { Some(env_sym("returndatasize", frame_depth)) } else { None };
                self.push_sym(e);
            }
            0x41 => {                       // COINBASE
                let e = if self.config.decompile_mode { Some(Expr::Sym("coinbase".into())) } else { None };
                self.push_sym(e);
            }
            0x42 => {                       // TIMESTAMP
                let e = if self.config.timestamp_sym || self.config.decompile_mode {
                    Some(Expr::Sym("timestamp".into()))
                } else { None };
                self.push_sym(e);
            }
            0x43 => {                       // NUMBER
                let e = if self.config.block_number_sym || self.config.decompile_mode {
                    Some(Expr::Sym("blocknumber".into()))
                } else { None };
                self.push_sym(e);
            }
            0x44 => {                       // PREVRANDAO
                let e = if self.config.decompile_mode { Some(Expr::Sym("prevrandao".into())) } else { None };
                self.push_sym(e);
            }
            0x45 => {                       // GASLIMIT
                let e = if self.config.decompile_mode { Some(Expr::Sym("gaslimit".into())) } else { None };
                self.push_sym(e);
            }
            0x46 => {                       // CHAINID
                let e = if self.config.decompile_mode { Some(Expr::Sym("chainid".into())) } else { None };
                self.push_sym(e);
            }
            0x47 => {                       // SELFBALANCE
                let e = if self.config.decompile_mode { Some(env_sym("selfbalance", frame_depth)) } else { None };
                self.push_sym(e);
            }
            0x48 => {                       // BASEFEE
                let e = if self.config.decompile_mode { Some(Expr::Sym("basefee".into())) } else { None };
                self.push_sym(e);
            }
            0x4a => {                       // BLOBBASEFEE
                let e = if self.config.decompile_mode { Some(Expr::Sym("blobbasefee".into())) } else { None };
                self.push_sym(e);
            }
            0x58 => self.push_sym(None),   // PC (实际就是具体值)
            0x59 => {                       // MSIZE
                let e = if self.config.decompile_mode { Some(env_sym("msize", frame_depth)) } else { None };
                self.push_sym(e);
            }
            0x5a => {                       // GAS
                let e = if self.config.decompile_mode { Some(env_sym("gas", frame_depth)) } else { None };
                self.push_sym(e);
            }

            // environment reads (pop 1, push 1) — 把参数包在符号名里，保留 “查谁的” 语义
            0x31 => {                       // BALANCE
                let a = self.pop_sym();
                let e = if self.config.decompile_mode {
                    let arg = a.map(|e| e.to_pseudo()).unwrap_or_else(|| format!("0x{:x}", sv(0)));
                    Some(Expr::Sym(format!("balance({})", arg)))
                } else { None };
                self.push_sym(e);
            }
            0x3b => {                       // EXTCODESIZE
                let a = self.pop_sym();
                let e = if self.config.decompile_mode {
                    let arg = a.map(|e| e.to_pseudo()).unwrap_or_else(|| format!("0x{:x}", sv(0)));
                    Some(Expr::Sym(format!("extcodesize({})", arg)))
                } else { None };
                self.push_sym(e);
            }
            0x3f => {                       // EXTCODEHASH
                let a = self.pop_sym();
                let e = if self.config.decompile_mode {
                    let arg = a.map(|e| e.to_pseudo()).unwrap_or_else(|| format!("0x{:x}", sv(0)));
                    Some(Expr::Sym(format!("extcodehash({})", arg)))
                } else { None };
                self.push_sym(e);
            }
            0x40 => {                       // BLOCKHASH
                let a = self.pop_sym();
                let e = if self.config.decompile_mode {
                    let arg = a.map(|e| e.to_pseudo()).unwrap_or_else(|| format!("0x{:x}", sv(0)));
                    Some(Expr::Sym(format!("blockhash({})", arg)))
                } else { None };
                self.push_sym(e);
            }
            0x49 => {                       // BLOBHASH
                let a = self.pop_sym();
                let e = if self.config.decompile_mode {
                    let arg = a.map(|e| e.to_pseudo()).unwrap_or_else(|| format!("0x{:x}", sv(0)));
                    Some(Expr::Sym(format!("blobhash({})", arg)))
                } else { None };
                self.push_sym(e);
            }

            // CALLDATALOAD (pop 1, push 1)
            0x35 => {
                let offset = sv(0).as_limbs()[0] as usize;
                self.pop_sym(); // offset sym
                let mut result = self.frames.last()
                    .and_then(|f| f.calldata_sym.get(&offset))
                    .cloned()
                    .unwrap_or(None);
                // 反编译模式：子帧没命中 → 合成 cd@d{depth}_{off}
                if result.is_none() && self.config.decompile_mode && frame_depth > 0 {
                    result = Some(Expr::Sym(format!("cd@d{}_{}", frame_depth, offset)));
                }
                self.push_sym(result);
            }

            // CALLDATACOPY (pop 3, push 0)
            0x37 => {
                let dest       = sv(0).as_limbs()[0] as usize;
                let cd_offset  = sv(1).as_limbs()[0] as usize;
                let size       = sv(2).as_limbs()[0] as usize;
                self.pop_sym(); self.pop_sym(); self.pop_sym();
                // 先清空目标区间的陈旧符号
                let dst_end = dest.saturating_add(size);
                self.mem_clear_range(dest, dst_end);
                // 扫描 calldata_sym 中落在 [cd_offset, cd_offset+size) 范围内的所有条目
                let mut to_write = Vec::new();
                if let Some(frame) = self.frames.last() {
                    let end = cd_offset.saturating_add(size);
                    for (&off, val) in &frame.calldata_sym {
                        if off >= cd_offset && off < end {
                            to_write.push((dest + (off - cd_offset), val.clone()));
                        }
                    }
                }
                for (dst_off, sym) in to_write {
                    self.mem_write(dst_off, sym);
                }
            }

            // CODECOPY (pop 3, push 0) — code 为具体字节，清空目标区间的陈旧符号
            0x39 => {
                let dest = sv(0).as_limbs()[0] as usize;
                let size = sv(2).as_limbs()[0] as usize;
                self.pop_sym(); self.pop_sym(); self.pop_sym();
                let dst_end = dest.saturating_add(size);
                self.mem_clear_range(dest, dst_end);
            }

            // RETURNDATACOPY (pop 3, push 0) — 从子帧的 return data 恢复符号
            0x3e => {
                let dest_offset = sv(0).as_limbs()[0] as usize;
                let ret_offset  = sv(1).as_limbs()[0] as usize;
                let size        = sv(2).as_limbs()[0] as usize;
                self.pop_sym(); self.pop_sym(); self.pop_sym();
                // 先清空目标区间
                let dst_end = dest_offset.saturating_add(size);
                self.mem_clear_range(dest_offset, dst_end);
                let end = ret_offset.saturating_add(size);
                let mut to_write = Vec::new();
                if let Some(frame) = self.frames.last() {
                    // 扫描 pending_return_data 中落在 [ret_offset, end) 范围内的所有条目
                    for (off, sym) in &frame.pending_return_data {
                        if *off >= ret_offset && *off < end {
                            to_write.push((dest_offset + (*off - ret_offset), sym.clone()));
                        }
                    }
                }
                for (dst, sym) in to_write {
                    self.mem_write(dst, sym);
                }
            }

            // EXTCODECOPY (pop 4, push 0) — 外部代码为具体字节，清空目标区间
            0x3c => {
                // stack: addr(0), destOffset(1), offset(2), size(3)
                let dest = sv(1).as_limbs()[0] as usize;
                let size = sv(3).as_limbs()[0] as usize;
                self.pop_sym(); self.pop_sym(); self.pop_sym(); self.pop_sym();
                let dst_end = dest.saturating_add(size);
                self.mem_clear_range(dest, dst_end);
            }

            // MLOAD (pop 1, push 1) — 扫描 [offset, offset+32) 范围内的所有符号
            0x51 => {
                let offset = sv(0).as_limbs()[0] as usize;
                self.pop_sym();
                // 优先精确匹配（绝大多数 MLOAD 对应同偏移的 MSTORE）
                let result = if let Some(exact) = self.mem_read(offset) {
                    Some(exact)
                } else {
                    // 回退：扫描 [offset, offset+32) 中最近的符号条目（处理 MSTORE8 等非对齐写入）
                    self.frames.last().and_then(|f| {
                        let end = offset + 32;
                        f.sym_mem.iter()
                            .filter(|(&k, v)| k > offset && k < end && v.is_some())
                            .min_by_key(|(&k, _)| k)
                            .and_then(|(_, v)| v.clone())
                    })
                };
                self.push_sym(result);
            }

            // MSTORE (pop 2, push 0)
            0x52 => {
                let offset = sv(0).as_limbs()[0] as usize;
                self.pop_sym(); // offset
                let val_sym = self.pop_sym();
                // 先清空 [offset, offset+32) 内的所有陈旧符号，再写入新值
                self.mem_clear_range(offset, offset.saturating_add(32));
                self.mem_write(offset, val_sym);
            }

            // MSTORE8 (pop 2, push 0)
            // 真实 EVM：memory[offset] = value & 0xFF（单字节写入）
            // 近似策略：在精确字节偏移处记录符号，MLOAD 会扫描 32 字节范围来发现它
            0x53 => {
                let offset = sv(0).as_limbs()[0] as usize;
                self.pop_sym(); // offset
                let val_sym = self.pop_sym();
                // 不管是否含符号，都必须更新该字节偏移（具体写入也要清掉陈旧符号）
                let truncated = val_sym.map(|e| Expr::And(
                    Box::new(e),
                    Box::new(Expr::konst({
                        let mut b = [0u8; 32];
                        b[31] = 0xff;
                        b
                    })),
                ));
                self.mem_write(offset, truncated);
            }

            // SLOAD (pop 1, push 1)
            0x54 => {
                let slot_u = sv(0);
                let slot_key = slot_hex(slot_u);
                self.pop_sym();
                // 优先检查 sym_storage：key 存在即表示该 slot 已被 SSTORE 写入，
                // 无论 value 是 Some(符号) 还是 None(具体值) 都不应回退到 storage_symbols
                let has_in_storage = self.frames.last()
                    .map(|f| f.sym_storage.contains_key(&slot_key))
                    .unwrap_or(false);
                let result = if has_in_storage {
                    self.frames.last()
                        .and_then(|f| f.sym_storage.get(&slot_key))
                        .cloned()
                        .unwrap_or(None)
                } else if let Some(name) = self.config.storage_symbols.iter()
                    .find(|(slot, _)| *slot == slot_key)
                    .map(|(_, n)| n.clone())
                {
                    Some(Expr::Sym(name))
                } else if self.config.decompile_mode {
                    // 未被 SSTORE 且 config 未显式声明 → 合成 sload_{short_slot}
                    Some(Expr::Sym(format!("sload_{}", slot_short(slot_u))))
                } else {
                    None
                };
                self.push_sym(result);
            }

            // SSTORE (pop 2, push 0)
            0x55 => {
                let slot_key = slot_hex(sv(0));
                self.pop_sym(); // slot
                let val_sym = self.pop_sym();
                // 只有含符号的 value 才写入（None 表示具体值，写入会覆盖之前的符号）
                if let Some(f) = self.frames.last_mut() {
                    f.sym_storage.insert(slot_key, val_sym);
                }
            }

            // TLOAD (pop 1, push 1)
            0x5c => {
                let slot_u = sv(0);
                let slot_key = slot_hex(slot_u);
                self.pop_sym();
                let has_in_tstore = self.frames.last()
                    .map(|f| f.sym_transient.contains_key(&slot_key))
                    .unwrap_or(false);
                let result = if has_in_tstore {
                    self.frames.last()
                        .and_then(|f| f.sym_transient.get(&slot_key))
                        .cloned()
                        .unwrap_or(None)
                } else if self.config.decompile_mode {
                    Some(Expr::Sym(format!("tload_{}", slot_short(slot_u))))
                } else {
                    None
                };
                self.push_sym(result);
            }

            // TSTORE (pop 2, push 0)
            0x5d => {
                let slot_key = slot_hex(sv(0));
                self.pop_sym();
                let val_sym = self.pop_sym();
                if let Some(f) = self.frames.last_mut() {
                    f.sym_transient.insert(slot_key, val_sym);
                }
            }

            // MCOPY (pop 3, push 0)
            0x5e => {
                let dst  = sv(0).as_limbs()[0] as usize;
                let src  = sv(1).as_limbs()[0] as usize;
                let size = sv(2).as_limbs()[0] as usize;
                self.pop_sym(); self.pop_sym(); self.pop_sym();
                // 先抓快照，再清空目标区间，最后写入
                let src_end = src.saturating_add(size);
                let mut to_write: Vec<(usize, Option<Expr>)> = Vec::new();
                if let Some(frame) = self.frames.last() {
                    // 扫描 sym_mem 中所有落在 [src, src+size) 范围内的条目
                    for (&mem_off, val) in &frame.sym_mem {
                        if mem_off >= src && mem_off < src_end {
                            to_write.push((dst + (mem_off - src), val.clone()));
                        }
                    }
                }
                self.mem_clear_range(dst, dst.saturating_add(size));
                for (off, sym) in to_write {
                    self.mem_write(off, sym);
                }
            }

            // JUMP (pop 1, push 0)
            0x56 => { self.pop_sym(); }

            // JUMPI (pop 2, push 0) — collect path constraint
            0x57 => {
                self.pop_sym(); // dest
                let cond_sym = self.pop_sym();
                let cond_concrete = sv(1); // condition is second from top (before both pops)
                if let Some(expr) = cond_sym {
                    // 只有含符号变量的约束才有意义
                    if !expr.is_concrete() {
                        let taken = cond_concrete != U256::ZERO;
                        self.path_constraints.push(PathConstraint {
                            step: global_step as u32,
                            transaction_id,
                            pc: pc as u32,
                            condition: expr,
                            taken,
                        });
                    }
                }
            }

            // RETURN (pop 2, push 0) — 捕获 return data 中的符号
            0xf3 => {
                let offset = sv(0).as_limbs()[0] as usize;
                let size   = sv(1).as_limbs()[0] as usize;
                self.pop_sym(); // offset
                self.pop_sym(); // size
                // 把返回数据范围 [offset..offset+size) 内的符号暂存，供父帧 RETURNDATACOPY 使用
                let mut ret_syms = Vec::new();
                if let Some(frame) = self.frames.last() {
                    let end = offset.saturating_add(size);
                    for (&mem_off, val) in &frame.sym_mem {
                        if mem_off >= offset && mem_off < end {
                            ret_syms.push((mem_off - offset, val.clone()));
                        }
                    }
                    ret_syms.sort_by_key(|(off, _)| *off);
                }
                if let Some(frame) = self.frames.last_mut() {
                    frame.pending_return_data = ret_syms;
                }
            }

            // REVERT (pop 2, push 0) — 同样捕获返回数据符号，供父帧 RETURNDATACOPY 使用
            0xfd => {
                let offset = sv(0).as_limbs()[0] as usize;
                let size   = sv(1).as_limbs()[0] as usize;
                self.pop_sym();
                self.pop_sym();
                let mut ret_syms = Vec::new();
                if let Some(frame) = self.frames.last() {
                    let end = offset.saturating_add(size);
                    for (&mem_off, val) in &frame.sym_mem {
                        if mem_off >= offset && mem_off < end {
                            ret_syms.push((mem_off - offset, val.clone()));
                        }
                    }
                    ret_syms.sort_by_key(|(off, _)| *off);
                }
                if let Some(frame) = self.frames.last_mut() {
                    frame.pending_return_data = ret_syms;
                }
            }

            // SELFDESTRUCT (pop 1)
            0xff => { self.pop_sym(); }

            // LOG0-LOG4
            0xa0 => { self.pop_sym(); self.pop_sym(); }
            0xa1 => { for _ in 0..3 { self.pop_sym(); } }
            0xa2 => { for _ in 0..4 { self.pop_sym(); } }
            0xa3 => { for _ in 0..5 { self.pop_sym(); } }
            0xa4 => { for _ in 0..6 { self.pop_sym(); } }

            // CALL / CALLCODE (pop 7, push 1 deferred via pop_frame)
            0xf1 | 0xf2 => {
                // stack top-to-bottom: gas(0), addr(1), value(2), argsOff(3), argsSz(4), retOff(5), retSz(6)
                let args_offset = sv(3).as_limbs()[0] as usize;
                let args_size   = sv(4).as_limbs()[0] as usize;
                for _ in 0..7 { self.pop_sym(); }
                self.prepare_inner_calldata(args_offset, args_size);
                // 不 push success flag：由 pop_frame() 推入
            }

            // DELEGATECALL / STATICCALL (pop 6, push 1 deferred)
            0xf4 | 0xfa => {
                // gas(0), addr(1), argsOff(2), argsSz(3), retOff(4), retSz(5)
                let args_offset = sv(2).as_limbs()[0] as usize;
                let args_size   = sv(3).as_limbs()[0] as usize;
                for _ in 0..6 { self.pop_sym(); }
                self.prepare_inner_calldata(args_offset, args_size);
            }

            // CREATE: pop 3 (deferred push via pop_frame)
            0xf0 => {
                for _ in 0..3 { self.pop_sym(); }
                // 不 push 新地址：由 pop_frame() 推入 None
            }

            // CREATE2 (pop 4, push 1 deferred)
            0xf5 => {
                for _ in 0..4 { self.pop_sym(); }
            }

            // fallback: maintain stack alignment using effect table
            _ => {
                let (pops, pushes) = opcode_stack_effect(opcode);
                for _ in 0..pops   { self.pop_sym(); }
                for _ in 0..pushes { self.push_sym(None); }
            }
        }
    }

    /// 公开访问已收集的路径约束
    pub fn constraints(&self) -> &[PathConstraint] {
        &self.path_constraints
    }

    /// 反编译专用：读取当前帧栈顶第 `from_top` 槽的符号表达式（0 = 栈顶）
    pub fn peek_sym(&self, from_top: usize) -> Option<Expr> {
        let f = self.frames.last()?;
        let n = f.sym_stack.len();
        if from_top >= n {
            return None;
        }
        f.sym_stack.get(n - 1 - from_top).cloned().flatten()
    }

    /// 反编译专用：读取当前帧栈深
    pub fn sym_stack_len(&self) -> usize {
        self.frames.last().map(|f| f.sym_stack.len()).unwrap_or(0)
    }

    /// 反编译专用：重置所有帧（多交易边界）
    pub fn reset_frames(&mut self) {
        self.frames.clear();
    }

    /// 反编译专用：扫描当前帧内存 [off, off+size) 内的首个符号条目
    pub fn peek_mem_sym(&self, offset: usize, size: usize) -> Option<Expr> {
        let f = self.frames.last()?;
        if size == 32 {
            if let Some(Some(e)) = f.sym_mem.get(&offset) {
                return Some(e.clone());
            }
        }
        let end = offset.saturating_add(size);
        f.sym_mem
            .iter()
            .filter(|(&k, v)| k >= offset && k < end && v.is_some())
            .min_by_key(|(&k, _)| k)
            .and_then(|(_, v)| v.clone())
    }

}

/// 从 DebugSession 中已有的 trace + step_frame_depths 离线重放符号引擎
pub fn replay_from_trace(
    trace: &[crate::op_trace::debug_session::TraceStep],
    frame_depths: &HashMap<u32, usize>,
    root_calldata: &[u8],
    calldata_by_tx: &HashMap<u32, Vec<u8>>,
    config: SymConfig,
) -> SymbolicEngine {
    let mut engine = SymbolicEngine::new(config);
    engine.push_frame(root_calldata, 0); // 初始化根帧（fallback）
    let mut prev_depth: usize = 0;
    let mut prev_tx: Option<u32> = None;

    for (i, step) in trace.iter().enumerate() {
        let gs = i as u32;
        let cur_depth = *frame_depths.get(&gs).unwrap_or(&0);
        let cur_tx = step.transaction_id;

        // 多 tx：交易切换时重置根帧，避免符号状态跨交易污染
        if prev_tx != Some(cur_tx) {
            let root_cd = calldata_by_tx
                .get(&cur_tx)
                .map(|v| v.as_slice())
                .unwrap_or(root_calldata);
            engine.frames.clear();
            engine.push_frame(root_cd, 0);
            prev_depth = 0;
            prev_tx = Some(cur_tx);
        }

        // 帧深度升高 → CALL/CREATE 发生了（在上一步 on_step 时 pending_call_cdata 已准备好）
        while cur_depth > prev_depth {
            // 判断是否为 DELEGATECALL：前一步的 opcode 为 0xf4 且只升一层
            let kind = if i > 0 && trace[i - 1].opcode == 0xf4 && cur_depth == prev_depth + 1 {
                FrameKind::Delegate
            } else {
                FrameKind::Normal
            };
            engine.push_inner_frame(kind);
            prev_depth += 1;
        }
        // 帧深度降低 → RETURN/REVERT 发生了
        while cur_depth < prev_depth {
            engine.pop_frame();
            prev_depth -= 1;
        }

        engine.on_step(
            step.opcode,
            step.pc as usize,
            i,
            step.transaction_id,
            &step.stack,
            cur_depth,
        );
    }

    engine
}

// stack effect table (fallback for unhandled opcodes)
fn opcode_stack_effect(op: u8) -> (usize, usize) {
    match op {
        0x00 | 0x5b | 0xfe => (0, 0),
        0x01..=0x07 | 0x0a | 0x0b
        | 0x10..=0x14
        | 0x16..=0x18 | 0x1a..=0x1d => (2, 1),
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
        0xf0 => (3, 0), // CREATE — success 由 pop_frame 推入
        0xf1 | 0xf2 => (7, 0),
        0xf4 | 0xfa => (6, 0),
        0xf5 => (4, 0),
        _ => (0, 0),
    }
}
