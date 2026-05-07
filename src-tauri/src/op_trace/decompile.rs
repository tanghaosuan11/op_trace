//! Trace 反编译 — 从单个已执行 frame 的 trace 生成可读伪代码。
//!
//! 设计要点：
//! - 不做静态 CFG 分析，仅线性扫描本帧已执行步。
//! - 复用 `symbolic::SymbolicEngine` 得到栈槽/内存/存储的表达式。
//! - 子 CALL/CREATE 帧视作"黑盒"调用，只打印入口与结果。
//! - Keccak 结果若能在 `keccak_ops` 中匹配到原始字节，则还原 mapping key。

use revm::primitives::{Address, U256};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

use super::debug_session::{DebugSession, FrameScopeKey, KeccakRecord, TraceStep};
use super::symbolic::engine::{FrameKind, SymbolicEngine};
use super::symbolic::expr::Expr;
use super::symbolic::SymConfig;

/// 反编译输出的单条伪代码
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Stmt {
    /// 函数入口（首帧）
    FunctionEntry {
        step: u32,
        selector: Option<String>,
        caller: String,
        target: String,
        kind: String,
        value: String,
    },
    /// SLOAD → let vN = storage[slot]
    SLoad {
        step: u32,
        var: String,
        slot: String,
        slot_raw: String,
        value: String,
    },
    /// SSTORE → storage[slot] = value
    SStore {
        step: u32,
        slot: String,
        slot_raw: String,
        value: String,
        value_raw: String,
        old_value: String,
    },
    TLoad {
        step: u32,
        var: String,
        slot: String,
        slot_raw: String,
    },
    TStore {
        step: u32,
        slot: String,
        value: String,
    },
    /// JUMPI 已执行分支
    Branch {
        step: u32,
        cond: String,
        taken: bool,
        target_pc: u32,
        fallthrough_pc: u32,
    },
    /// require 模式（JUMPI skip → REVERT）
    Require { step: u32, cond: String },
    /// LOG0..LOG4
    Log {
        step: u32,
        n_topics: usize,
        topics: Vec<String>,
        data: String,
    },
    /// CALL/STATICCALL/DELEGATECALL/CALLCODE
    Call {
        step: u32,
        kind: String,
        target: String,
        value: Option<String>,
        args: String,
        selector: Option<String>,
    },
    /// CREATE/CREATE2
    Create {
        step: u32,
        kind: String,
        value: String,
        init_code_hint: String,
        deployed: Option<String>,
    },
    Return { step: u32, data: String },
    Revert { step: u32, data: String, reason: Option<String> },
    SelfDestruct { step: u32, beneficiary: String },
    /// 循环：最外层重复访问同一基本块时折叠而成
    Loop {
        header_pc: u32,
        iterations: u32,
        body: Vec<Stmt>,
        first_step: u32,
        last_step: u32,
    },
    /// 一段被省略的低价值步（纯算术/栈/跳转），供 UI 展示"此处省略 N 步"
    Elided {
        first_step: u32,
        last_step: u32,
        step_count: u32,
        summary: String,
    },
    /// 函数分发器：连续的 `msg.sig == 0x?? → goto` 分支折叠成 switch
    Dispatcher {
        first_step: u32,
        last_step: u32,
        cases: Vec<DispatcherCase>,
        fallback_pc: Option<u32>,
    },
    /// 帧退出汇总
    FrameExit { success: bool, gas_used: u64 },
}

#[derive(Debug, Clone, Serialize)]
pub struct DispatcherCase {
    pub selector: String,
    pub target_pc: u32,
    pub taken: bool,
    pub step: u32,
}

/// 反编译结果
#[derive(Debug, Serialize)]
pub struct DecompileResult {
    pub transaction_id: u32,
    pub frame_id: u16,
    pub address: String,
    pub caller: String,
    pub kind: String,
    pub success: bool,
    pub step_count: usize,
    pub stmts: Vec<Stmt>,
    /// 渲染好的多行伪代码
    pub pseudocode: String,
}

/// 反编译行为开关 — 供 UI 调优时关闭易失真的后处理
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(default)]
pub struct DecompileOptions {
    /// 启用循环折叠（默认：启用；但仅当两轮迭代的"副作用"等价时才折叠）
    pub fold_loops: bool,
    /// 启用函数分发器折叠（默认：启用）
    pub fold_dispatcher: bool,
    /// 两条有效 Stmt 之间跨越多少步才插入 Elided 注释（0 = 不插入）
    pub elide_gap_threshold: u32,
    /// 仅保留符号 JUMPI（默认：false → 保留全部，与旧版语义相反）
    pub symbolic_branch_only: bool,
}

impl Default for DecompileOptions {
    fn default() -> Self {
        Self {
            fold_loops: true,
            fold_dispatcher: true,
            elide_gap_threshold: 100,
            symbolic_branch_only: false,
        }
    }
}

/// 从 `DebugSession` 对指定 (tx, frame) 生成伪代码
pub fn decompile_frame(
    session: &DebugSession,
    transaction_id: u32,
    frame_id: u16,
    root_calldata: &[u8],
    calldata_by_tx: &HashMap<u32, Vec<u8>>,
    options: &DecompileOptions,
) -> Result<DecompileResult, String> {
    let scope: FrameScopeKey = (transaction_id, frame_id);
    let frame_rec = session
        .frame_map
        .get(&scope)
        .ok_or_else(|| format!("frame {}:{} 不存在", transaction_id, frame_id))?;

    let shadow = session
        .shadow
        .as_ref()
        .ok_or_else(|| "shadow 未启用 (需 enable_shadow=true)".to_string())?;
    let frame_depths = shadow.step_frame_depths();

    // 预扫描：收集本帧出现过的所有 CALLDATALOAD offset，生成 SymConfig
    let cd_offsets = collect_calldata_offsets(&session.trace, transaction_id, frame_id);
    // 预扫描 SLOAD 的 slot，将初始存储状态符号化 —— 这是让后续 JUMPI 条件符号化的关键
    let sload_slots = collect_sload_slots(&session.trace, transaction_id, frame_id);
    let sym_config = SymConfig {
        calldata_symbols: cd_offsets
            .iter()
            .map(|&off| (off, format!("cd_{}", off)))
            .collect(),
        callvalue_sym: true,
        caller_sym: true,
        origin_sym: true,
        timestamp_sym: true,
        block_number_sym: true,
        storage_symbols: sload_slots
            .iter()
            .map(|hex| (hex.clone(), format!("sload_{}", short_hex_name(hex))))
            .collect(),
        decompile_mode: true,
    };

    // 构造 keccak hash → record 的映射（供 slot 反查 mapping key）
    let keccak_by_hash: HashMap<[u8; 32], &KeccakRecord> = session
        .keccak_ops
        .iter()
        .map(|r| (r.hash, r))
        .collect();

    let mut engine = SymbolicEngine::new(sym_config);
    engine.push_frame(root_calldata, 0);

    let mut stmts: Vec<Stmt> = Vec::new();
    // 与 `stmts` 对齐：每条语句所在基本块入口 pc（最近一次 JUMPDEST 或 frame 入口 0）
    let mut block_pcs: Vec<u32> = Vec::new();
    let mut cur_block_pc: u32 = 0;
    let mut var_counter: u32 = 0;

    // 入口 selector：delegatecall 也继承父帧 calldata
    let selector_hex = if root_calldata.len() >= 4 {
        Some(format!(
            "0x{}",
            root_calldata[..4]
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect::<String>()
        ))
    } else {
        None
    };
    if let Some(entry_step) = first_step_of_frame(&session.trace, transaction_id, frame_id) {
        stmts.push(Stmt::FunctionEntry {
            step: entry_step,
            selector: selector_hex,
            caller: format!("{:?}", frame_rec.caller),
            target: format!("{:?}", frame_rec.target_address),
            kind: frame_rec.kind.clone(),
            value: "0".into(),
        });
        block_pcs.push(0);
    }

    let mut prev_depth: usize = 0;
    let mut prev_tx: Option<u32> = None;
    // 最近一次真正产出 Stmt 的 trace 下标（用于 Elided gap 判定）
    let mut last_emitted_step: Option<usize> = None;
    let trace = &session.trace;

    for (i, step) in trace.iter().enumerate() {
        let gs = i as u32;
        let cur_depth = *frame_depths.get(&gs).unwrap_or(&0);
        let cur_tx = step.transaction_id;

        // 多 tx 交易切换 → 重置根帧（与 replay_from_trace 保持一致）
        if prev_tx != Some(cur_tx) {
            let cd = calldata_by_tx
                .get(&cur_tx)
                .map(|v| v.as_slice())
                .unwrap_or(root_calldata);
            engine.reset_frames();
            engine.push_frame(cd, 0);
            prev_depth = 0;
            prev_tx = Some(cur_tx);
        }

        // 帧深度跟踪
        while cur_depth > prev_depth {
            let kind = if i > 0 && trace[i - 1].opcode == 0xf4 && cur_depth == prev_depth + 1 {
                FrameKind::Delegate
            } else {
                FrameKind::Normal
            };
            engine.push_inner_frame(kind);
            prev_depth += 1;
        }
        while cur_depth < prev_depth {
            engine.pop_frame();
            prev_depth -= 1;
        }

        // 是否属于本帧？（相同 tx + 相同 context_id）
        let in_target_frame = step.transaction_id == transaction_id && step.context_id == frame_id;

        if in_target_frame {
            if step.opcode == 0x5b {
                cur_block_pc = step.pc;
            }
            let before = stmts.len();
            emit_stmt_for_step(
                step,
                &mut engine,
                &mut stmts,
                &mut var_counter,
                session,
                &keccak_by_hash,
                i,
                options,
            );
            // 如果这一步确实产出了 Stmt，且与上一条输出之间跨越了很多"沉默步"，
            // 在它前面插入一条 Elided 说明（跳过算术/栈/无条件跳转等低价值步）
            if stmts.len() > before {
                if let Some(prev) = last_emitted_step {
                    let gap = i.saturating_sub(prev) as u32;
                    if options.elide_gap_threshold > 0 && gap > options.elide_gap_threshold {
                        let elided = Stmt::Elided {
                            first_step: (prev as u32) + 1,
                            last_step: (i as u32).saturating_sub(1),
                            step_count: gap.saturating_sub(1),
                            summary: "arith/mem/jumps".into(),
                        };
                        stmts.insert(before, elided);
                        block_pcs.push(cur_block_pc);
                    }
                }
                last_emitted_step = Some(i);
            }
            for _ in before..stmts.len() {
                if block_pcs.len() < stmts.len() {
                    block_pcs.push(cur_block_pc);
                }
            }
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

    stmts.push(Stmt::FrameExit {
        success: frame_rec.success,
        gas_used: frame_rec.gas_used,
    });
    block_pcs.push(u32::MAX);

    // 折叠循环（连续重复的基本块归约为一次迭代）
    let stmts = if options.fold_loops {
        fold_loops(stmts, &block_pcs)
    } else {
        stmts
    };
    // 折叠 dispatcher：连续的 `msg.sig == 0x?? → goto` 分支合并为一个 switch
    let stmts = if options.fold_dispatcher {
        fold_dispatcher(stmts)
    } else {
        stmts
    };

    let pseudocode = render_stmts(&stmts, 0);

    Ok(DecompileResult {
        transaction_id,
        frame_id,
        address: format!("{:?}", frame_rec.address),
        caller: format!("{:?}", frame_rec.caller),
        kind: frame_rec.kind.clone(),
        success: frame_rec.success,
        step_count: frame_rec.step_count,
        stmts,
        pseudocode,
    })
}

// ───────────────────────────────────────────────
// 辅助函数
// ───────────────────────────────────────────────

fn collect_calldata_offsets(trace: &[TraceStep], tx: u32, frame: u16) -> Vec<usize> {
    let mut set: HashSet<usize> = HashSet::new();
    for s in trace.iter() {
        if s.transaction_id != tx || s.context_id != frame {
            continue;
        }
        match s.opcode {
            0x35 => {
                // CALLDATALOAD: stack top = offset
                if let Some(v) = s.stack.last() {
                    let off = v.as_limbs()[0] as usize;
                    if off < 64 * 1024 {
                        set.insert(off);
                    }
                }
            }
            0x37 => {
                // CALLDATACOPY: destOffset, offset, size
                let n = s.stack.len();
                if n >= 3 {
                    let cd_offset = s.stack[n - 2].as_limbs()[0] as usize;
                    let size = s.stack[n - 3].as_limbs()[0] as usize;
                    let size = size.min(1024);
                    // 粒度 32 字节
                    let mut off = cd_offset;
                    let end = cd_offset.saturating_add(size);
                    while off < end {
                        set.insert(off);
                        off = off.saturating_add(32);
                    }
                }
            }
            _ => {}
        }
    }
    // 加上常用入口 selector (off=0) 即使未出现也无害
    set.insert(0);
    let mut v: Vec<usize> = set.into_iter().collect();
    v.sort();
    v
}

fn first_step_of_frame(trace: &[TraceStep], tx: u32, frame: u16) -> Option<u32> {
    trace
        .iter()
        .enumerate()
        .find(|(_, s)| s.transaction_id == tx && s.context_id == frame)
        .map(|(i, _)| i as u32)
}

/// 预扫描：收集本帧所有出现过的 SLOAD slot（64 字符 lowercase hex）。
fn collect_sload_slots(trace: &[TraceStep], tx: u32, frame: u16) -> Vec<String> {
    let mut set: HashSet<String> = HashSet::new();
    for s in trace {
        if s.transaction_id != tx || s.context_id != frame {
            continue;
        }
        if s.opcode == 0x54 {
            // SLOAD: stack top = slot
            if let Some(v) = s.stack.last() {
                let bytes = v.to_be_bytes::<32>();
                set.insert(bytes.iter().map(|b| format!("{:02x}", b)).collect());
            }
        }
    }
    set.into_iter().collect()
}

/// 把 64 字符 hex slot 压缩成可读符号名片段（去前导零）。
fn short_hex_name(h: &str) -> String {
    let t = h.trim_start_matches('0');
    if t.is_empty() { "0".into() } else { t.to_string() }
}

/// 读取 (tx, frame, trace_index) 对应步骤时的完整内存（依赖已启用的 shadow/memory 追踪）。
fn read_concrete_memory(
    session: &DebugSession,
    tx: u32,
    frame: u16,
    trace_index: usize,
) -> Option<Vec<u8>> {
    let step = session.trace.get(trace_index)?;
    if step.transaction_id != tx || step.context_id != frame {
        return None;
    }
    let mem = session.compute_memory_at_step(tx, frame, step.frame_step);
    if mem.is_empty() { None } else { Some(mem) }
}

/// 从具体内存中读出一段字节；不足部分补零。
fn slice_concrete_mem(mem: &[u8], offset: usize, size: usize) -> Vec<u8> {
    let mut out = vec![0u8; size];
    if offset >= mem.len() {
        return out;
    }
    let end = (offset + size).min(mem.len());
    out[..end - offset].copy_from_slice(&mem[offset..end]);
    out
}

fn stack_u256(stack: &[U256], from_top: usize) -> U256 {
    let n = stack.len();
    if from_top < n {
        stack[n - 1 - from_top]
    } else {
        U256::ZERO
    }
}

fn u256_hex(v: U256) -> String {
    let s = format!("{:x}", v);
    if s.is_empty() {
        "0x0".into()
    } else {
        format!("0x{}", s)
    }
}

/// 把 20 字节 Address 从 U256 里提取出来（低 20 字节）
fn u256_to_address(v: U256) -> Address {
    let bytes = v.to_be_bytes::<32>();
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&bytes[12..32]);
    Address::from(addr)
}

/// 把 Expr 或具体 U256 值转 pseudo 字符串
fn expr_or_const(sym: &Option<Expr>, concrete: U256) -> String {
    match sym {
        Some(e) if !e.is_concrete() => e.to_pseudo(),
        _ => u256_hex(concrete),
    }
}

/// 尝试把 slot 表达式（Keccak(_, [key, slot_const]) 等）还原成 mapping[key]。
/// 返回 (friendly, raw_pseudo)
fn render_slot(
    sym: &Option<Expr>,
    concrete: U256,
    session: &DebugSession,
    keccak_by_hash: &HashMap<[u8; 32], &KeccakRecord>,
) -> (String, String) {
    let raw = expr_or_const(sym, concrete);
    let friendly = render_slot_friendly(sym, concrete, session, keccak_by_hash).unwrap_or_else(|| raw.clone());
    (friendly, raw)
}

fn render_slot_friendly(
    sym: &Option<Expr>,
    concrete: U256,
    session: &DebugSession,
    keccak_by_hash: &HashMap<[u8; 32], &KeccakRecord>,
) -> Option<String> {
    // 情况1：slot 符号表达式可用 — 从 Keccak 模式反推
    if let Some(e) = sym.as_ref() {
        if !e.is_concrete() {
            if let Some(s) = render_keccak_slot_expr(e) {
                return Some(s);
            }
        }
    }
    // 情况2：具体 slot 值 — 从 keccak_by_hash 反查 input
    let slot_bytes = concrete.to_be_bytes::<32>();
    if let Some(rec) = keccak_by_hash.get(&slot_bytes) {
        if let Some(s) = describe_keccak_input(rec, session, keccak_by_hash, 0) {
            return Some(s);
        }
    }
    None
}

/// 递归解析 `Keccak(uid, [k, s])` 等已知 mapping 模式表达式
fn render_keccak_slot_expr(e: &Expr) -> Option<String> {
    match e {
        Expr::Keccak(_, children) => match children.as_slice() {
            // 单参数 keccak（通常是 abi.encodePacked(key) + 32 字节，常见于 length=32 的数组索引）
            [a] => Some(format!("mapping[{}]", a.to_pseudo())),
            // 两参数 → 典型 mapping(key => V) at slot S  （abi.encode(key, slot)）
            [k, s] => Some(format!(
                "storage[mapping[{}] at slot {}]",
                k.to_pseudo(),
                s.to_pseudo()
            )),
            _ => None,
        },
        Expr::Add(a, b) => {
            // keccak(..) + offset → 结构体字段
            if let Expr::Keccak(_, children) = a.as_ref() {
                if let Expr::Const(h) = b.as_ref() {
                    let trimmed = h.trim_start_matches('0');
                    let off_str = if trimmed.is_empty() { "0".into() } else { trimmed.to_string() };
                    if children.len() == 2 {
                        return Some(format!(
                            "storage[mapping[{}] at slot {}].field[+0x{}]",
                            children[0].to_pseudo(),
                            children[1].to_pseudo(),
                            off_str
                        ));
                    }
                    return Some(format!("storage[keccak_base + 0x{}]", off_str));
                }
            }
            None
        }
        _ => None,
    }
}

/// 对已记录 keccak 输入字节做启发式解读
fn describe_keccak_input(
    rec: &KeccakRecord,
    session: &DebugSession,
    keccak_by_hash: &HashMap<[u8; 32], &KeccakRecord>,
    depth: usize,
) -> Option<String> {
    if depth > 3 {
        return None;
    }
    let input = &rec.input;
    // mapping(key => V): input.len() == 64，input[..32]=key, input[32..]=slot
    if input.len() == 64 {
        let key_bytes: [u8; 32] = input[..32].try_into().ok()?;
        let slot_bytes: [u8; 32] = input[32..].try_into().ok()?;
        let key_u = U256::from_be_bytes(key_bytes);
        let slot_u = U256::from_be_bytes(slot_bytes);
        // key 可能本身也是 keccak（嵌套 mapping）
        let key_str = if let Some(inner) = keccak_by_hash.get(&key_bytes) {
            describe_keccak_input(inner, session, keccak_by_hash, depth + 1)
                .unwrap_or_else(|| u256_hex(key_u))
        } else {
            decode_key(&key_bytes).unwrap_or_else(|| u256_hex(key_u))
        };
        return Some(format!(
            "storage[mapping[{}] at slot {}]",
            key_str,
            u256_hex(slot_u)
        ));
    }
    // 动态数组数据区：input.len() == 32 时 keccak(slot) 作为数据起点
    if input.len() == 32 {
        let slot_bytes: [u8; 32] = input[..32].try_into().ok()?;
        // 嵌套：当前 slot 本身也是某个 keccak 的结果（mapping-of-array 等）
        if let Some(inner) = keccak_by_hash.get(&slot_bytes) {
            if let Some(desc) = describe_keccak_input(inner, session, keccak_by_hash, depth + 1) {
                return Some(format!("{}.array_data", desc));
            }
        }
        let slot_u = U256::from_be_bytes(slot_bytes);
        return Some(format!("storage[array_data(slot={})]", u256_hex(slot_u)));
    }
    None
}

/// key_bytes 可能是地址（前 12 字节全 0）
fn decode_key(key_bytes: &[u8; 32]) -> Option<String> {
    if key_bytes[..12].iter().all(|&b| b == 0) {
        let addr = Address::from_slice(&key_bytes[12..32]);
        return Some(format!("{:?}", addr));
    }
    None
}

/// 处理一个 step：发出 0 或 1 条 Stmt
fn emit_stmt_for_step(
    step: &TraceStep,
    engine: &mut SymbolicEngine,
    stmts: &mut Vec<Stmt>,
    var_counter: &mut u32,
    session: &DebugSession,
    keccak_by_hash: &HashMap<[u8; 32], &KeccakRecord>,
    global_step: usize,
    options: &DecompileOptions,
) {
    let gs = global_step as u32;
    let opcode = step.opcode;
    let stack = &step.stack;
    let n = stack.len();

    match opcode {
        // SLOAD
        0x54 => {
            let slot_concrete = stack_u256(stack, 0);
            let slot_sym = engine.peek_sym(0);
            let (slot_p, slot_raw) = render_slot(&slot_sym, slot_concrete, session, keccak_by_hash);
            let value = find_sload_value(session, transaction_and_frame(step), global_step)
                .map(u256_hex)
                .unwrap_or_else(|| "?".into());
            *var_counter += 1;
            stmts.push(Stmt::SLoad {
                step: gs,
                var: format!("v{}", *var_counter),
                slot: slot_p,
                slot_raw,
                value,
            });
        }
        // SSTORE
        0x55 => {
            let slot_concrete = stack_u256(stack, 0);
            let slot_sym = engine.peek_sym(0);
            let val_concrete = stack_u256(stack, 1);
            let val_sym = engine.peek_sym(1);
            let (slot_p, slot_raw) = render_slot(&slot_sym, slot_concrete, session, keccak_by_hash);
            let value_p = expr_or_const(&val_sym, val_concrete);
            let value_raw = u256_hex(val_concrete);
            let old_value = find_sstore_old(session, transaction_and_frame(step), global_step)
                .map(u256_hex)
                .unwrap_or_else(|| "?".into());
            stmts.push(Stmt::SStore {
                step: gs,
                slot: slot_p,
                slot_raw,
                value: value_p,
                value_raw,
                old_value,
            });
        }
        // TLOAD
        0x5c => {
            let slot_concrete = stack_u256(stack, 0);
            let slot_sym = engine.peek_sym(0);
            let (slot_p, slot_raw) = render_slot(&slot_sym, slot_concrete, session, keccak_by_hash);
            *var_counter += 1;
            stmts.push(Stmt::TLoad {
                step: gs,
                var: format!("t{}", *var_counter),
                slot: slot_p,
                slot_raw,
            });
        }
        // TSTORE
        0x5d => {
            let slot_concrete = stack_u256(stack, 0);
            let slot_sym = engine.peek_sym(0);
            let val_concrete = stack_u256(stack, 1);
            let val_sym = engine.peek_sym(1);
            let (slot_p, _) = render_slot(&slot_sym, slot_concrete, session, keccak_by_hash);
            stmts.push(Stmt::TStore {
                step: gs,
                slot: slot_p,
                value: expr_or_const(&val_sym, val_concrete),
            });
        }
        // JUMPI
        0x57 => {
            let target_pc = stack_u256(stack, 0).as_limbs()[0] as u32;
            let cond_concrete = stack_u256(stack, 1);
            let cond_sym = engine.peek_sym(1);
            let cond_is_symbolic = cond_sym.as_ref().map(|e| !e.is_concrete()).unwrap_or(false);
            // 旧行为：只保留符号 JUMPI + require 模式（可通过 options 回退）
            if options.symbolic_branch_only && !cond_is_symbolic {
                let next_is_revert = session
                    .trace
                    .get(global_step + 1)
                    .map(|s| s.opcode == 0xfd)
                    .unwrap_or(false);
                if !next_is_revert {
                    return;
                }
            }
            let taken = cond_concrete != U256::ZERO;
            let cond_p = expr_or_const(&cond_sym, cond_concrete);
            stmts.push(Stmt::Branch {
                step: gs,
                cond: cond_p,
                taken,
                target_pc,
                fallthrough_pc: step.pc + 1,
            });
        }
        // LOG0-LOG4
        0xa0..=0xa4 => {
            let n_topics = (opcode - 0xa0) as usize;
            let mem_offset = stack_u256(stack, 0).as_limbs()[0] as usize;
            let mem_size = stack_u256(stack, 1).as_limbs()[0] as usize;
            let mut topics: Vec<String> = Vec::with_capacity(n_topics);
            for i in 0..n_topics {
                let c = stack_u256(stack, 2 + i);
                let sym = engine.peek_sym(2 + i);
                topics.push(expr_or_const(&sym, c));
            }
            let data = describe_memory(
                engine, session, step.transaction_id, step.context_id,
                global_step, mem_offset, mem_size,
            );
            stmts.push(Stmt::Log {
                step: gs,
                n_topics,
                topics,
                data,
            });
        }
        // CALL / CALLCODE
        0xf1 | 0xf2 => {
            let kind = if opcode == 0xf1 { "call" } else { "callcode" };
            let addr_u = stack_u256(stack, 1);
            let addr_sym = engine.peek_sym(1);
            let value_u = stack_u256(stack, 2);
            let value_sym = engine.peek_sym(2);
            let args_off = stack_u256(stack, 3).as_limbs()[0] as usize;
            let args_size = stack_u256(stack, 4).as_limbs()[0] as usize;
            let args = describe_memory(
                engine, session, step.transaction_id, step.context_id,
                global_step, args_off, args_size,
            );
            let selector = extract_selector(
                engine, session, step.transaction_id, step.context_id,
                global_step, args_off, args_size,
            );
            let target = match addr_sym {
                Some(e) if !e.is_concrete() => e.to_pseudo(),
                _ => format!("{:?}", u256_to_address(addr_u)),
            };
            stmts.push(Stmt::Call {
                step: gs,
                kind: kind.into(),
                target,
                value: Some(expr_or_const(&value_sym, value_u)),
                args,
                selector,
            });
        }
        // DELEGATECALL / STATICCALL
        0xf4 | 0xfa => {
            let kind = if opcode == 0xf4 { "delegatecall" } else { "staticcall" };
            let addr_u = stack_u256(stack, 1);
            let addr_sym = engine.peek_sym(1);
            let args_off = stack_u256(stack, 2).as_limbs()[0] as usize;
            let args_size = stack_u256(stack, 3).as_limbs()[0] as usize;
            let args = describe_memory(
                engine, session, step.transaction_id, step.context_id,
                global_step, args_off, args_size,
            );
            let selector = extract_selector(
                engine, session, step.transaction_id, step.context_id,
                global_step, args_off, args_size,
            );
            let target = match addr_sym {
                Some(e) if !e.is_concrete() => e.to_pseudo(),
                _ => format!("{:?}", u256_to_address(addr_u)),
            };
            stmts.push(Stmt::Call {
                step: gs,
                kind: kind.into(),
                target,
                value: None,
                args,
                selector,
            });
        }
        // CREATE / CREATE2
        0xf0 | 0xf5 => {
            let kind = if opcode == 0xf0 { "create" } else { "create2" };
            let val_u = stack_u256(stack, 0);
            let val_sym = engine.peek_sym(0);
            let size = stack_u256(stack, 2).as_limbs()[0] as usize;
            // 回填部署地址：查找父帧中 CREATE 之后第一个 (tx, frame) 步骤的栈顶
            let deployed = find_create_deployed_address(
                session, step.transaction_id, step.context_id, global_step,
            );
            stmts.push(Stmt::Create {
                step: gs,
                kind: kind.into(),
                value: expr_or_const(&val_sym, val_u),
                init_code_hint: format!("<{} bytes>", size),
                deployed,
            });
        }
        // RETURN
        0xf3 => {
            let off = stack_u256(stack, 0).as_limbs()[0] as usize;
            let size = stack_u256(stack, 1).as_limbs()[0] as usize;
            let data = describe_memory(
                engine, session, step.transaction_id, step.context_id,
                global_step, off, size,
            );
            stmts.push(Stmt::Return { step: gs, data });
        }
        // REVERT
        0xfd => {
            let off = stack_u256(stack, 0).as_limbs()[0] as usize;
            let size = stack_u256(stack, 1).as_limbs()[0] as usize;
            let data = describe_memory(
                engine, session, step.transaction_id, step.context_id,
                global_step, off, size,
            );
            // 尝试解 Error(string) / Panic(uint256)
            let reason = try_decode_revert_reason(
                session, step.transaction_id, step.context_id,
                global_step, off, size,
            );
            stmts.push(Stmt::Revert {
                step: gs,
                data,
                reason,
            });
        }
        0xff => {
            let b = stack_u256(stack, 0);
            stmts.push(Stmt::SelfDestruct {
                step: gs,
                beneficiary: format!("{:?}", u256_to_address(b)),
            });
        }
        _ => {}
    }
    let _ = n;
}

fn transaction_and_frame(step: &TraceStep) -> FrameScopeKey {
    (step.transaction_id, step.context_id)
}

fn find_sload_value(session: &DebugSession, scope: FrameScopeKey, step_idx: usize) -> Option<U256> {
    // storage_changes.step_index 约定是 1-indexed 的 step_end 计数，
    // 对应 trace 的全局下标关系为 step_index == step_idx + 1。
    // 只做精确匹配——失败就返回 None（让伪代码渲染 "?"），避免错配到邻近 SLOAD。
    let (tx, frame) = scope;
    let expected = step_idx + 1;
    session
        .storage_changes
        .iter()
        .find(|c| {
            c.is_read
                && !c.is_transient
                && c.transaction_id == tx
                && c.frame_id == frame
                && c.step_index == expected
        })
        .map(|c| c.new_value)
}

fn find_sstore_old(session: &DebugSession, scope: FrameScopeKey, step_idx: usize) -> Option<U256> {
    let (tx, frame) = scope;
    let expected = step_idx + 1;
    session
        .storage_changes
        .iter()
        .find(|c| {
            !c.is_read
                && !c.is_transient
                && c.transaction_id == tx
                && c.frame_id == frame
                && c.step_index == expected
        })
        .map(|c| c.old_value)
}

/// CREATE/CREATE2 之后，EVM 会在父帧 push 新合约地址或 0（失败）。
/// 方法：从 trace[create_step + 1 ..] 中，在同一 (tx, frame) 里找到第一个步骤，
/// 其栈顶比本步少 2（CREATE pop 3 push 1 → 净 -2），新栈顶即部署地址。
fn find_create_deployed_address(
    session: &DebugSession,
    tx: u32,
    frame: u16,
    create_step: usize,
) -> Option<String> {
    let create = session.trace.get(create_step)?;
    let expected_stack_len = create.stack.len().checked_sub(2)?;
    for s in session.trace.iter().skip(create_step + 1) {
        if s.transaction_id != tx || s.context_id != frame {
            continue;
        }
        if s.stack.len() == expected_stack_len {
            if let Some(top) = s.stack.last() {
                if *top == U256::ZERO {
                    return Some("0x0 (failed)".into());
                }
                return Some(format!("{:?}", u256_to_address(*top)));
            }
        }
        break;
    }
    None
}

/// 将一段内存区间尝试描述成伪代码字符串
///
/// 优先级：符号 > 具体十六进制 > 位置占位
fn describe_memory(
    engine: &SymbolicEngine,
    session: &DebugSession,
    tx: u32,
    frame: u16,
    trace_index: usize,
    offset: usize,
    size: usize,
) -> String {
    if size == 0 {
        return "".into();
    }
    if let Some(e) = engine.peek_mem_sym(offset, size) {
        if !e.is_concrete() {
            return format!("<{} bytes: {}>", size, e.to_pseudo());
        }
    }
    // 读具体字节
    if let Some(mem) = read_concrete_memory(session, tx, frame, trace_index) {
        let bytes = slice_concrete_mem(&mem, offset, size);
        return format_call_bytes(&bytes);
    }
    format!("memory[{}..{}]", offset, offset + size)
}

/// 将具体字节格式化为 selector+args（若像 ABI 调用）或 hex dump
fn format_call_bytes(bytes: &[u8]) -> String {
    let n = bytes.len();
    if n == 0 {
        return "0x".into();
    }
    // 疑似 ABI 编码：长度 >= 4，且尾部是 32 字节对齐
    if n >= 4 && (n - 4) % 32 == 0 && n <= 4 + 32 * 16 {
        let selector = format!(
            "0x{}",
            bytes[..4].iter().map(|b| format!("{:02x}", b)).collect::<String>()
        );
        let arg_count = (n - 4) / 32;
        if arg_count == 0 {
            return format!("selector={}", selector);
        }
        let args: Vec<String> = (0..arg_count)
            .map(|i| {
                let start = 4 + i * 32;
                let word = &bytes[start..start + 32];
                let trimmed: String = word
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<String>()
                    .trim_start_matches('0')
                    .to_string();
                let arg_hex = if trimmed.is_empty() { "0x0".into() } else { format!("0x{}", trimmed) };
                format!("arg{}={}", i, arg_hex)
            })
            .collect();
        return format!("selector={}, {}", selector, args.join(", "));
    }
    // 短字节直接 hex
    if n <= 64 {
        let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
        return format!("0x{}", hex);
    }
    // 长字节只显示首尾
    let head: String = bytes[..16].iter().map(|b| format!("{:02x}", b)).collect();
    let tail: String = bytes[n - 16..].iter().map(|b| format!("{:02x}", b)).collect();
    format!("0x{}..{}({} bytes)", head, tail, n)
}

fn extract_selector(
    engine: &SymbolicEngine,
    session: &DebugSession,
    tx: u32,
    frame: u16,
    trace_index: usize,
    offset: usize,
    size: usize,
) -> Option<String> {
    if size < 4 {
        return None;
    }
    // 优先：符号表达式（如 `cd_0 >> 224`）
    if let Some(e) = engine.peek_mem_sym(offset, 32) {
        if !e.is_concrete() {
            return Some(format!("sig={}", e.to_pseudo()));
        }
    }
    // 回退：从具体内存读前 4 字节
    if let Some(mem) = read_concrete_memory(session, tx, frame, trace_index) {
        if offset + 4 <= mem.len() {
            let sel: String = mem[offset..offset + 4].iter().map(|b| format!("{:02x}", b)).collect();
            return Some(format!("selector=0x{}", sel));
        }
    }
    None
}

/// Error(string) / Panic(uint256) 解码
fn try_decode_revert_reason(
    session: &DebugSession,
    tx: u32,
    frame: u16,
    trace_index: usize,
    offset: usize,
    size: usize,
) -> Option<String> {
    if size < 4 {
        return None;
    }
    let mem = read_concrete_memory(session, tx, frame, trace_index)?;
    let bytes = slice_concrete_mem(&mem, offset, size);
    if bytes.len() < 4 {
        return None;
    }
    let selector = &bytes[..4];
    // Error(string) = 0x08c379a0
    if selector == [0x08, 0xc3, 0x79, 0xa0] && bytes.len() >= 4 + 64 {
        // bytes[4..36] = offset (=0x20), bytes[36..68] = length, bytes[68..] = data
        let str_len_bytes = &bytes[36..68];
        let str_len = u64::from_be_bytes(str_len_bytes[24..32].try_into().ok()?) as usize;
        if 68 + str_len <= bytes.len() {
            if let Ok(s) = std::str::from_utf8(&bytes[68..68 + str_len]) {
                return Some(s.replace('"', "'"));
            }
        }
    }
    // Panic(uint256) = 0x4e487b71
    if selector == [0x4e, 0x48, 0x7b, 0x71] && bytes.len() >= 4 + 32 {
        let code = u64::from_be_bytes(bytes[4 + 24..4 + 32].try_into().ok()?);
        let desc = match code {
            0x01 => "assert failed",
            0x11 => "arithmetic overflow/underflow",
            0x12 => "division by zero",
            0x21 => "invalid enum",
            0x22 => "invalid storage byte array",
            0x31 => "pop empty array",
            0x32 => "array out of bounds",
            0x41 => "out of memory",
            0x51 => "invalid internal function",
            _ => "panic",
        };
        return Some(format!("Panic(0x{:x}): {}", code, desc));
    }
    None
}

// ───────────────────────────────────────────────
// 循环识别：连续重复访问同一基本块 → 折叠为 Loop
// ───────────────────────────────────────────────

/// 为一条 Stmt 计算"副作用指纹"——仅包含会被读者关心的语义位（操作类型 + 槽位/目标标识），
/// 具体数值/step 号被排除。只要两轮迭代指纹序列一致，就视为可折叠。
fn stmt_fingerprint(s: &Stmt) -> String {
    match s {
        Stmt::FunctionEntry { .. } => "ENTRY".into(),
        Stmt::SLoad { slot_raw, .. } => format!("SLOAD:{}", slot_raw),
        Stmt::SStore { slot_raw, .. } => format!("SSTORE:{}", slot_raw),
        Stmt::TLoad { slot_raw, .. } => format!("TLOAD:{}", slot_raw),
        Stmt::TStore { slot, .. } => format!("TSTORE:{}", slot),
        Stmt::Branch { target_pc, fallthrough_pc, taken, .. } => {
            format!("BR:{}:{}:{}", target_pc, fallthrough_pc, taken)
        }
        Stmt::Require { cond, .. } => format!("REQ:{}", cond),
        Stmt::Log { n_topics, .. } => format!("LOG{}", n_topics),
        Stmt::Call { kind, target, selector, .. } => {
            format!("CALL:{}:{}:{}", kind, target, selector.clone().unwrap_or_default())
        }
        Stmt::Create { kind, .. } => format!("CREATE:{}", kind),
        Stmt::Return { .. } => "RET".into(),
        Stmt::Revert { reason, .. } => format!("REV:{}", reason.clone().unwrap_or_default()),
        Stmt::SelfDestruct { beneficiary, .. } => format!("SUICIDE:{}", beneficiary),
        Stmt::Loop { header_pc, iterations, .. } => format!("LOOP:{}:{}", header_pc, iterations),
        Stmt::Elided { step_count, .. } => format!("ELID:{}", step_count),
        Stmt::Dispatcher { cases, .. } => format!("DISP:{}", cases.len()),
        Stmt::FrameExit { .. } => "EXIT".into(),
    }
}

/// 检查 stmts[start..] 上 iters 轮 body_len 段的副作用指纹是否逐轮一致。
/// 若不一致则说明模式匹配只是"PC 重复"，并不是真正意义上的重复迭代 → 拒绝折叠。
fn loop_iterations_equivalent(
    stmts: &[Stmt],
    start: usize,
    body_len: usize,
    iters: u32,
) -> bool {
    if iters < 2 || body_len == 0 {
        return false;
    }
    let first: Vec<String> = stmts[start..start + body_len]
        .iter()
        .map(stmt_fingerprint)
        .collect();
    for k in 1..iters as usize {
        let off = start + k * body_len;
        if off + body_len > stmts.len() {
            return false;
        }
        let cur: Vec<String> = stmts[off..off + body_len]
            .iter()
            .map(stmt_fingerprint)
            .collect();
        if cur != first {
            return false;
        }
    }
    true
}

/// 基于 block_pcs 数组在线性 stmts 序列里检测最外层重复模式。
///
/// 算法：
/// 1. 扫描到第一个在后文仍出现的 block_pc 值 H（即潜在循环头）。
/// 2. 取 H 第二次出现的位置作为一次迭代结束；body = stmts[first..second]。
/// 3. 贪心继续匹配后续相同长度的重复段，统计 `iterations`。
/// 4. 折叠为 `Stmt::Loop`；对 body 内部递归折叠（嵌套循环）。
/// 5. 对未被折叠的部分继续向后扫描。
fn fold_loops(stmts: Vec<Stmt>, block_pcs: &[u32]) -> Vec<Stmt> {
    assert_eq!(stmts.len(), block_pcs.len());
    let n = stmts.len();
    let mut out: Vec<Stmt> = Vec::with_capacity(n);
    let mut i = 0usize;

    // 标记"是否为块边界语句"：只在 block_pc 发生变化或 i=0 时才算作一个循环头候选
    let is_block_header = |idx: usize| -> bool {
        if idx == 0 {
            return true;
        }
        block_pcs[idx] != block_pcs[idx - 1] && block_pcs[idx] != 0 && block_pcs[idx] != u32::MAX
    };

    while i < n {
        // 仅当当前位置是一个基本块入口、且该块 pc 在后文还会出现时，才启动循环检测
        if is_block_header(i) {
            let header_pc = block_pcs[i];
            // 找下一次 header_pc 出现（同样要求是块头）
            let mut next = None;
            let mut j = i + 1;
            while j < n {
                if block_pcs[j] == header_pc && is_block_header(j) {
                    next = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(j0) = next {
                let body_len = j0 - i;
                if body_len >= 1 {
                    // 尝试向后贪心匹配相同 pc 序列
                    let body_pcs = &block_pcs[i..j0];
                    let mut iters: u32 = 1;
                    let mut cursor = j0;
                    while cursor + body_len <= n
                        && &block_pcs[cursor..cursor + body_len] == body_pcs
                        && is_block_header(cursor)
                    {
                        iters += 1;
                        cursor += body_len;
                    }
                    if iters >= 2 {
                        // 等价性校验：两轮迭代的"副作用指纹"必须一致，否则拒绝折叠
                        // （避免 dispatcher 重入 / 同 PC 不同语义的误折叠）
                        let fingerprint_ok = loop_iterations_equivalent(&stmts, i, body_len, iters);
                        if !fingerprint_ok {
                            // 不折叠：当作普通语句处理（后续 while 循环会独立展开每轮副作用）
                            out.push(stmts[i].clone());
                            i += 1;
                            continue;
                        }
                        // 收集 body stmts（一次迭代即可），提取首末 step
                        let body_slice: Vec<Stmt> = stmts[i..j0].iter().cloned().collect();
                        let body_block_pcs: Vec<u32> = block_pcs[i..j0].to_vec();
                        // 递归：body 内可能还有更短周期的嵌套循环
                        let folded_body = fold_loops(body_slice, &body_block_pcs);
                        // 如果 body 折叠后是空的（纯算术/跳转循环，无任何可观察副作用），
                        // 用一条 Elided 注释代替 `loop {}`，避免出现空循环块。
                        if folded_body.is_empty() {
                            let last_idx = (cursor - 1).min(n - 1);
                            let first_step = step_of_single(&stmts[i]).unwrap_or(0);
                            let last_step = step_of_single(&stmts[last_idx]).unwrap_or(first_step);
                            out.push(Stmt::Elided {
                                first_step,
                                last_step,
                                step_count: (cursor - i) as u32,
                                summary: format!("loop @0x{:x} iters={} (no side effects)", header_pc, iters),
                            });
                            i = cursor;
                            continue;
                        }
                        let first_step = step_of(&folded_body).unwrap_or(0);
                        let last_step = last_step_of(&folded_body).unwrap_or(first_step);
                        out.push(Stmt::Loop {
                            header_pc,
                            iterations: iters,
                            body: folded_body,
                            first_step,
                            last_step,
                        });
                        i = cursor;
                        continue;
                    }
                }
            }
        }
        out.push(stmts[i].clone());
        i += 1;
    }
    out
}

fn step_of_single(s: &Stmt) -> Option<u32> {
    match s {
        Stmt::FunctionEntry { step, .. }
        | Stmt::SLoad { step, .. }
        | Stmt::SStore { step, .. }
        | Stmt::TLoad { step, .. }
        | Stmt::TStore { step, .. }
        | Stmt::Branch { step, .. }
        | Stmt::Require { step, .. }
        | Stmt::Log { step, .. }
        | Stmt::Call { step, .. }
        | Stmt::Create { step, .. }
        | Stmt::Return { step, .. }
        | Stmt::Revert { step, .. }
        | Stmt::SelfDestruct { step, .. } => Some(*step),
        Stmt::Loop { first_step, .. } => Some(*first_step),
        Stmt::Elided { first_step, .. } => Some(*first_step),
        Stmt::Dispatcher { first_step, .. } => Some(*first_step),
        Stmt::FrameExit { .. } => None,
    }
}

fn step_of(stmts: &[Stmt]) -> Option<u32> {
    stmts.iter().find_map(step_of_single)
}

fn last_step_of(stmts: &[Stmt]) -> Option<u32> {
    stmts.iter().rev().find_map(|s| match s {
        Stmt::FunctionEntry { step, .. }
        | Stmt::SLoad { step, .. }
        | Stmt::SStore { step, .. }
        | Stmt::TLoad { step, .. }
        | Stmt::TStore { step, .. }
        | Stmt::Branch { step, .. }
        | Stmt::Require { step, .. }
        | Stmt::Log { step, .. }
        | Stmt::Call { step, .. }
        | Stmt::Create { step, .. }
        | Stmt::Return { step, .. }
        | Stmt::Revert { step, .. }
        | Stmt::SelfDestruct { step, .. } => Some(*step),
        Stmt::Loop { last_step, .. } => Some(*last_step),
        Stmt::Elided { last_step, .. } => Some(*last_step),
        Stmt::Dispatcher { last_step, .. } => Some(*last_step),
        Stmt::FrameExit { .. } => None,
    })
}

// ───────────────────────────────────────────────
// Dispatcher 折叠：把连续的 `if (msg.sig == 0x??) goto 0x??` 合并为 switch
// ───────────────────────────────────────────────

/// 从 Branch 条件字符串里抽出 selector（匹配 `(msg.sig == 0x????????)` 等形式）。
fn extract_msg_sig_selector(cond: &str) -> Option<String> {
    // pseudo 形式：`(msg.sig == 0xabcdef12)` 或 `(msg.sig == 0x...)`
    let c = cond.trim();
    let inner = c.strip_prefix('(').and_then(|s| s.strip_suffix(')')).unwrap_or(c);
    let parts: Vec<&str> = inner.splitn(2, "==").collect();
    if parts.len() != 2 {
        return None;
    }
    let lhs = parts[0].trim();
    let rhs = parts[1].trim();
    let (sel_str, other) = if lhs == "msg.sig" {
        (rhs, lhs)
    } else if rhs == "msg.sig" {
        (lhs, rhs)
    } else {
        return None;
    };
    let _ = other;
    // 接受 0x + 偶数个十六进制
    if !sel_str.starts_with("0x") {
        return None;
    }
    let hex = &sel_str[2..];
    if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    // 归一化到 8 位十六进制
    let padded = format!("{:0>8}", hex);
    Some(format!("0x{}", padded))
}

fn fold_dispatcher(stmts: Vec<Stmt>) -> Vec<Stmt> {
    let mut out: Vec<Stmt> = Vec::with_capacity(stmts.len());
    let mut i = 0usize;
    while i < stmts.len() {
        // 找连续的 msg.sig Branch 段
        let mut j = i;
        let mut cases: Vec<DispatcherCase> = Vec::new();
        while j < stmts.len() {
            if let Stmt::Branch { step, cond, taken, target_pc, .. } = &stmts[j] {
                if let Some(sel) = extract_msg_sig_selector(cond) {
                    cases.push(DispatcherCase {
                        selector: sel,
                        target_pc: *target_pc,
                        taken: *taken,
                        step: *step,
                    });
                    j += 1;
                    continue;
                }
            }
            break;
        }
        // 至少 2 条才视为 dispatcher
        if cases.len() >= 2 {
            let first_step = cases.first().map(|c| c.step).unwrap_or(0);
            let last_step = cases.last().map(|c| c.step).unwrap_or(first_step);
            // fallback_pc：段末尾后第一条 Branch 的 fallthrough_pc（若存在）
            let fallback_pc = stmts.get(j).and_then(|s| match s {
                Stmt::Branch { fallthrough_pc, .. } => Some(*fallthrough_pc),
                _ => None,
            });
            out.push(Stmt::Dispatcher {
                first_step,
                last_step,
                cases,
                fallback_pc,
            });
            i = j;
            continue;
        }
        // 不是 dispatcher：对嵌套 Loop 递归
        match stmts[i].clone() {
            Stmt::Loop { header_pc, iterations, body, first_step, last_step } => {
                out.push(Stmt::Loop {
                    header_pc,
                    iterations,
                    body: fold_dispatcher(body),
                    first_step,
                    last_step,
                });
            }
            other => out.push(other),
        }
        i += 1;
    }
    out
}

// ───────────────────────────────────────────────
// 渲染：把 Stmt 列表变成多行伪代码字符串
// ───────────────────────────────────────────────

fn render_stmts(stmts: &[Stmt], depth: usize) -> String {
    let mut out = String::new();
    let pad = "    ".repeat(depth + 1);
    let mut i = 0;
    while i < stmts.len() {
        // require 折叠：Branch(cond, taken) + 紧接 Revert → require(...)
        if let Stmt::Branch {
            cond,
            taken,
            target_pc: _,
            fallthrough_pc: _,
            step,
        } = &stmts[i]
        {
            if i + 1 < stmts.len() {
                if let Stmt::Revert { data: _, reason, .. } = &stmts[i + 1] {
                    let eff_cond = if *taken {
                        cond.clone()
                    } else {
                        format!("!({})", cond)
                    };
                    match reason {
                        Some(r) => out.push_str(&format!(
                            "{pad}require({}, \"{}\"); // step {}\n",
                            eff_cond, r, step
                        )),
                        None => out.push_str(&format!(
                            "{pad}require({}); // step {}\n",
                            eff_cond, step
                        )),
                    }
                    i += 2;
                    continue;
                }
            }
        }

        match &stmts[i] {
            Stmt::FunctionEntry {
                step,
                selector,
                caller,
                target,
                kind,
                value,
            } => {
                out.push_str(&format!(
                    "// ─── entry {} → {} (kind={}, selector={}) value={} step={}\n",
                    caller,
                    target,
                    kind,
                    selector.clone().unwrap_or_else(|| "n/a".into()),
                    value,
                    step,
                ));
                out.push_str("function() {\n");
            }
            Stmt::SLoad { step, var, slot, value, .. } => {
                out.push_str(&format!(
                    "{pad}{} = {};  // sload => {}  [step {}]\n",
                    var, slot, value, step
                ));
            }
            Stmt::SStore { step, slot, value, old_value, .. } => {
                out.push_str(&format!(
                    "{pad}{} = {};  // was {}  [step {}]\n",
                    slot, value, old_value, step
                ));
            }
            Stmt::TLoad { step, var, slot, .. } => {
                out.push_str(&format!(
                    "{pad}{} = tload({});  // [step {}]\n",
                    var, slot, step
                ));
            }
            Stmt::TStore { step, slot, value } => {
                out.push_str(&format!(
                    "{pad}tstore({}, {});  // [step {}]\n",
                    slot, value, step
                ));
            }
            Stmt::Branch { step, cond, taken, target_pc, fallthrough_pc } => {
                if *taken {
                    out.push_str(&format!(
                        "{pad}if ({}) goto 0x{:x};  // taken [step {}]\n",
                        cond, target_pc, step
                    ));
                } else {
                    out.push_str(&format!(
                        "{pad}if !({}) continue 0x{:x};  // not taken [step {}]\n",
                        cond, fallthrough_pc, step
                    ));
                }
            }
            Stmt::Require { step, cond } => {
                out.push_str(&format!("{pad}require({}); // [step {}]\n", cond, step));
            }
            Stmt::Log { step, n_topics, topics, data } => {
                let topic0 = topics.first().cloned().unwrap_or_default();
                out.push_str(&format!(
                    "{pad}emit Log{}(topic0={}, topics=[{}], data={}); // [step {}]\n",
                    n_topics,
                    topic0,
                    topics.iter().skip(1).cloned().collect::<Vec<_>>().join(", "),
                    data,
                    step
                ));
            }
            Stmt::Call { step, kind, target, value, args, selector } => {
                let val = value.clone().unwrap_or_default();
                out.push_str(&format!(
                    "{pad}{}({}, value={}, args={}, sig={}); // [step {}]\n",
                    kind,
                    target,
                    val,
                    args,
                    selector.clone().unwrap_or_else(|| "?".into()),
                    step
                ));
            }
            Stmt::Create { step, kind, value, init_code_hint, deployed } => {
                out.push_str(&format!(
                    "{pad}{}(value={}, init={}) -> {}; // [step {}]\n",
                    kind,
                    value,
                    init_code_hint,
                    deployed.clone().unwrap_or_else(|| "?".into()),
                    step
                ));
            }
            Stmt::Return { step, data } => {
                out.push_str(&format!("{pad}return {}; // [step {}]\n", data, step));
            }
            Stmt::Revert { step, data, reason } => match reason {
                Some(r) => out.push_str(&format!(
                    "{pad}revert(\"{}\", {}); // [step {}]\n",
                    r, data, step
                )),
                None => out.push_str(&format!("{pad}revert({}); // [step {}]\n", data, step)),
            },
            Stmt::SelfDestruct { step, beneficiary } => {
                out.push_str(&format!(
                    "{pad}selfdestruct({}); // [step {}]\n",
                    beneficiary, step
                ));
            }
            Stmt::Loop { header_pc, iterations, body, first_step, last_step } => {
                out.push_str(&format!(
                    "{pad}loop @0x{:x} iters={} {{  // [steps {}..{}]\n",
                    header_pc, iterations, first_step, last_step
                ));
                out.push_str(&render_stmts(body, depth + 1));
                out.push_str(&format!("{pad}}}\n"));
            }
            Stmt::Elided { first_step, last_step, step_count, summary } => {
                out.push_str(&format!(
                    "{pad}// ... elided {} steps [{}..{}] ({})\n",
                    step_count, first_step, last_step, summary
                ));
            }
            Stmt::Dispatcher { first_step, last_step, cases, fallback_pc } => {
                out.push_str(&format!(
                    "{pad}switch (msg.sig) {{  // dispatcher [steps {}..{}]\n",
                    first_step, last_step
                ));
                let case_pad = "    ".repeat(depth + 2);
                for c in cases {
                    let note = if c.taken { "" } else { " (not taken)" };
                    out.push_str(&format!(
                        "{case_pad}case {}: goto 0x{:x};{} // [step {}]\n",
                        c.selector, c.target_pc, note, c.step
                    ));
                }
                if let Some(pc) = fallback_pc {
                    out.push_str(&format!("{case_pad}default: continue 0x{:x};\n", pc));
                }
                out.push_str(&format!("{pad}}}\n"));
            }
            Stmt::FrameExit { success, gas_used } => {
                out.push_str(&format!(
                    "}} // exit success={} gas_used={}\n",
                    success, gas_used
                ));
            }
        }
        i += 1;
    }
    out
}
