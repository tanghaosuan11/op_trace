use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rquickjs::{CatchResultExt, Context, Ctx, Function, Object, Runtime, Value};

use crate::op_trace::debug_session::DebugSession;
use revm::primitives::U256;


const HEX: &[u8; 16] = b"0123456789abcdef";

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut buf = Vec::with_capacity(2 + bytes.len() * 2);
    buf.extend_from_slice(b"0x");
    for &b in bytes {
        buf.push(HEX[(b >> 4) as usize]);
        buf.push(HEX[(b & 0x0f) as usize]);
    }
    unsafe { String::from_utf8_unchecked(buf) }
}

#[inline]
fn u256_to_hex(v: &U256) -> String {
    bytes_to_hex(&v.to_be_bytes::<32>())
}

/// opcode 名称（大写）→ 字节值。接受 "SSTORE" 或 "0x55" 两种格式。
fn opcode_name_to_byte(s: &str) -> Option<u8> {
    let s = s.trim().to_uppercase();
    if s.starts_with("0X") {
        return u8::from_str_radix(&s[2..], 16).ok();
    }
    for op_num in 0u8..=255 {
        if let Some(op) = revm::bytecode::opcode::OpCode::new(op_num) {
            if op.as_str() == s { return Some(op_num); }
        }
    }
    None
}

/// 字节值 → opcode 名称字符串（&'static str）
#[inline]
fn opcode_name(op: u8) -> &'static str {
    revm::bytecode::opcode::OpCode::new(op)
        .map(|o| o.as_str())
        .unwrap_or("UNKNOWN")
}

/// 地址规范化：去掉 0x 前缀，转小写，20 字节
fn parse_address(s: &str) -> Option<[u8; 20]> {
    let s = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    if s.len() != 40 { return None; }
    let mut out = [0u8; 20];
    for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
        let hi = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
        out[i] = hi;
    }
    Some(out)
}

/// 所有可选过滤条件
#[derive(Default)]
pub struct AnalysisFilters {
    pub opcodes:    Option<HashSet<u8>>,
    pub contracts:  Option<HashSet<[u8; 20]>>,
    pub targets:    Option<HashSet<[u8; 20]>>,
    pub frames:     Option<HashSet<u16>>,
    /// 全局步骤下标范围 [from, to]（含两端）
    pub step_range: Option<(usize, usize)>,
}

impl AnalysisFilters {
    pub fn from_raw(raw: RawFilters) -> Self {
        let opcodes = Self::parse_opcodes(raw.opcodes);
        let contracts = Self::parse_addresses(raw.contracts);
        let targets = Self::parse_addresses(raw.targets);
        let frames: Option<HashSet<u16>> = raw.frames.and_then(|v| {
            if v.is_empty() { return None; }
            Some(v.into_iter().collect())
        });
        let step_range = raw.step_range.and_then(|v| {
            if v.len() == 2 { Some((v[0], v[1])) } else { None }
        });
        AnalysisFilters { opcodes, contracts, targets, frames, step_range }
    }

    fn parse_opcodes(list: Option<Vec<String>>) -> Option<HashSet<u8>> {
        let list = list?;
        if list.is_empty() { return None; }
        let mut set = HashSet::new();
        for s in &list {
            let s = s.trim().to_uppercase();
            if s.starts_with("0X") {
                if let Ok(v) = u8::from_str_radix(&s[2..], 16) { set.insert(v); }
            } else {
                for op_num in 0u8..=255 {
                    if let Some(op) = revm::bytecode::opcode::OpCode::new(op_num) {
                        if op.as_str() == s { set.insert(op_num); break; }
                    }
                }
            }
        }
        if set.is_empty() { None } else { Some(set) }
    }

    fn parse_addresses(list: Option<Vec<String>>) -> Option<HashSet<[u8; 20]>> {
        let list = list?;
        if list.is_empty() { return None; }
        let set: HashSet<_> = list.iter().filter_map(|s| parse_address(s)).collect();
        if set.is_empty() { None } else { Some(set) }
    }
}

/// 向 QuickJS 全局注册按需查询函数。
/// 所有函数通过裸指针直接访问 DebugSession，session 生命周期长于 JS 运行时，安全。
/// 带 Raw 后缀的是 Rust 侧实现，JS 侧包一层再暴露给脚本。
fn register_query_fns(
    ctx: &Ctx<'_>,
    session_ptr: usize,
    app_data_dir: &str,
    chain_id: &str,
) -> rquickjs::Result<()> {
    let g = ctx.globals();

    // findStepIndicesRaw(opcode, from, to) → number[]
    // 返回匹配 opcode 的全局步骤下标列表，from/to = -1 表示不限范围
    {
        let p = session_ptr;
        g.set("findStepIndicesRaw", Function::new(ctx.clone(), move |opcode: String, from: i64, to: i64| -> Vec<u32> {
            let sess = unsafe { &*(p as *const DebugSession) };
            let Some(op_byte) = opcode_name_to_byte(&opcode) else { return vec![]; };
            let from_idx = if from < 0 { 0usize } else { from as usize };
            let to_idx   = if to < 0   { usize::MAX } else { to as usize };
            sess.trace.iter().enumerate()
                .filter(|(i, s)| *i >= from_idx && *i <= to_idx && s.opcode == op_byte)
                .map(|(i, _)| i as u32)
                .collect()
        })?)?;
    }

    // firstStepRaw(opcode, from) → number，-1 表示未找到
    {
        let p = session_ptr;
        g.set("firstStepRaw", Function::new(ctx.clone(), move |opcode: String, from: i64| -> i64 {
            let sess = unsafe { &*(p as *const DebugSession) };
            let Some(op_byte) = opcode_name_to_byte(&opcode) else { return -1; };
            let from_idx = if from < 0 { 0usize } else { from as usize };
            for (i, s) in sess.trace.iter().enumerate() {
                if i >= from_idx && s.opcode == op_byte { return i as i64; }
            }
            -1
        })?)?;
    }

    // countStepsRaw(opcode, from, to) → number
    {
        let p = session_ptr;
        g.set("countStepsRaw", Function::new(ctx.clone(), move |opcode: String, from: i64, to: i64| -> u32 {
            let sess = unsafe { &*(p as *const DebugSession) };
            let Some(op_byte) = opcode_name_to_byte(&opcode) else { return 0; };
            let from_idx = if from < 0 { 0usize } else { from as usize };
            let to_idx   = if to < 0   { usize::MAX } else { to as usize };
            sess.trace.iter().enumerate()
                .filter(|(i, s)| *i >= from_idx && *i <= to_idx && s.opcode == op_byte)
                .count() as u32
        })?)?;
    }

    // totalSteps() → number
    {
        let p = session_ptr;
        g.set("totalSteps", Function::new(ctx.clone(), move || -> u32 {
            let sess = unsafe { &*(p as *const DebugSession) };
            sess.trace.len() as u32
        })?)?;
    }

    // getStepRaw(i) → JSON 字符串，按下标取单步数据
    {
        let p = session_ptr;
        g.set("getStepRaw", Function::new(ctx.clone(), move |i: u32| -> String {
            let sess = unsafe { &*(p as *const DebugSession) };
            let idx = i as usize;
            if idx >= sess.trace.len() { return "null".into(); }
            let step = &sess.trace[idx];
            let stack: Vec<String> = step.stack.iter().map(|v| u256_to_hex(v)).collect();
            serde_json::json!({
                "stepIndex": idx as u32,
                "index":     idx as u32,
                "contextId": step.context_id,
                "frameStep": step.frame_step,
                "pc":        step.pc,
                "opcode":    opcode_name(step.opcode),
                "opcodeNum": step.opcode,
                "opcodeHex": format!("0x{:02x}", step.opcode),
                "gasCost":       step.gas_cost,
                "gasRemaining":  step.gas_remaining,
                "contract": bytes_to_hex(step.contract_address.as_ref()),
                "target":   bytes_to_hex(step.call_target.as_ref()),
                "stack":    stack,
            }).to_string()
        })?)?;
    }

    // aggregateByOpcodeRaw(from, to) → JSON 字符串
    // Rust 端聚合，返回 [{opcode, count, totalGas}]，按 totalGas 降序
    {
        let p = session_ptr;
        g.set("aggregateByOpcodeRaw", Function::new(ctx.clone(), move |from: i64, to: i64| -> String {
            let sess = unsafe { &*(p as *const DebugSession) };
            let from_idx = if from < 0 { 0usize } else { from as usize };
            let to_idx   = if to < 0   { usize::MAX } else { to as usize };
            let mut map: HashMap<&'static str, (u64, u64)> = HashMap::new();
            for (i, step) in sess.trace.iter().enumerate() {
                if i < from_idx || i > to_idx { continue; }
                let e = map.entry(opcode_name(step.opcode)).or_insert((0, 0));
                e.0 += 1;
                e.1 += step.gas_cost;
            }
            let mut entries: Vec<_> = map.into_iter()
                .map(|(op, (count, gas))| serde_json::json!({"opcode": op, "count": count, "totalGas": gas}))
                .collect();
            entries.sort_by(|a, b| {
                b["totalGas"].as_u64().unwrap_or(0).cmp(&a["totalGas"].as_u64().unwrap_or(0))
            });
            serde_json::Value::Array(entries).to_string()
        })?)?;
    }

    // countByFrameRaw() → JSON 字符串
    // 直接读 step_index map，无需扫描，返回 [{contextId, stepCount}]，按 stepCount 降序
    {
        let p = session_ptr;
        g.set("countByFrameRaw", Function::new(ctx.clone(), move || -> String {
            let sess = unsafe { &*(p as *const DebugSession) };
            let mut entries: Vec<_> = sess.step_index.iter()
                .map(|(&cid, indices)| serde_json::json!({"contextId": cid, "stepCount": indices.len()}))
                .collect();
            entries.sort_by(|a, b| {
                b["stepCount"].as_u64().unwrap_or(0).cmp(&a["stepCount"].as_u64().unwrap_or(0))
            });
            serde_json::Value::Array(entries).to_string()
        })?)?;
    }

    // getContractStatsRaw(addr) → JSON 字符串
    // 统计指定合约的步数、gas 消耗和 opcode 分布
    {
        let p = session_ptr;
        g.set("getContractStatsRaw", Function::new(ctx.clone(), move |addr: String| -> String {
            let sess = unsafe { &*(p as *const DebugSession) };
            let Some(target) = parse_address(&addr) else {
                return r#"{"error":"invalid address"}"#.into();
            };
            let mut step_count: u64 = 0;
            let mut total_gas:  u64 = 0;
            let mut opcode_map: HashMap<&'static str, u64> = HashMap::new();
            for step in &sess.trace {
                let addr_bytes: &[u8; 20] = step.contract_address.as_ref();
                if *addr_bytes != target { continue; }
                step_count += 1;
                total_gas  += step.gas_cost;
                *opcode_map.entry(opcode_name(step.opcode)).or_insert(0) += 1;
            }
            serde_json::json!({
                "stepCount": step_count,
                "totalGas":  total_gas,
                "opcodes":   opcode_map,
            }).to_string()
        })?)?;
    }

    // getSlotHistoryRaw(slot) → JSON 字符串
    // 返回指定存储槽的所有写操作（含 oldValue/newValue），从 storage_changes 中取，不扫描 trace
    {
        let p = session_ptr;
        g.set("getSlotHistoryRaw", Function::new(ctx.clone(), move |slot: String| -> String {
            let sess = unsafe { &*(p as *const DebugSession) };
            let raw = slot.trim().trim_start_matches("0x").trim_start_matches("0X");
            let normalized = format!("{:0>64}", raw.to_lowercase());
            let results: Vec<_> = sess.storage_changes.iter()
                .filter(|c| {
                    if c.is_read { return false; }
                    let key_hex = &u256_to_hex(&c.key)[2..];
                    key_hex == normalized
                })
                .map(|c| serde_json::json!({
                    "stepIndex":   c.step_index as u32,
                    "frameId":     c.frame_id,
                    "isTransient": c.is_transient,
                    "contract":    bytes_to_hex(c.address.as_ref()),
                    "key":         u256_to_hex(&c.key),
                    "oldValue":    u256_to_hex(&c.old_value),
                    "newValue":    u256_to_hex(&c.new_value),
                }))
                .collect();
            serde_json::Value::Array(results).to_string()
        })?)?;
    }

    // getFrameInfoRaw(frameId) → JSON 字符串
    // 按 frame id 取调用帧元数据（caller/kind/gas 等），找不到返回 "null"
    {
        let p = session_ptr;
        g.set("getFrameInfoRaw", Function::new(ctx.clone(), move |frame_id: u32| -> String {
            let sess = unsafe { &*(p as *const DebugSession) };
            match sess.frame_map.get(&(frame_id as u16)) {
                None => "null".into(),
                Some(f) => serde_json::json!({
                    "frameId":   f.frame_id,
                    "parentId":  f.parent_id,
                    "depth":     f.depth,
                    "address":   bytes_to_hex(f.address.as_ref()),
                    "caller":    bytes_to_hex(f.caller.as_ref()),
                    "target":    bytes_to_hex(f.target_address.as_ref()),
                    "kind":      f.kind,
                    "gasLimit":  f.gas_limit,
                    "gasUsed":   f.gas_used,
                    "stepCount": f.step_count,
                    "success":   f.success,
                }).to_string(),
            }
        })?)?;
    }

    // getStorageChangesRaw(addr, from, to) → JSON 字符串
    // addr 为空/"all" 时不过滤合约，from/to = -1 时不限范围，读写均包含
    {
        let p = session_ptr;
        g.set("getStorageChangesRaw", Function::new(ctx.clone(), move |addr: String, from: i64, to: i64| -> String {
            let sess = unsafe { &*(p as *const DebugSession) };
            let filter_addr = if addr.trim().is_empty() || addr == "all" {
                None
            } else {
                parse_address(&addr)
            };
            let from_idx = if from < 0 { 0usize } else { from as usize };
            let to_idx   = if to < 0   { usize::MAX } else { to as usize };
            let results: Vec<_> = sess.storage_changes.iter()
                .filter(|c| {
                    if c.step_index < from_idx || c.step_index > to_idx { return false; }
                    if let Some(target) = filter_addr {
                        let addr_bytes: &[u8; 20] = c.address.as_ref();
                        if *addr_bytes != target { return false; }
                    }
                    true
                })
                .map(|c| serde_json::json!({
                    "stepIndex":   c.step_index as u32,
                    "frameId":     c.frame_id,
                    "isTransient": c.is_transient,
                    "isRead":      c.is_read,
                    "contract":    bytes_to_hex(c.address.as_ref()),
                    "key":         u256_to_hex(&c.key),
                    "oldValue":    u256_to_hex(&c.old_value),
                    "newValue":    u256_to_hex(&c.new_value),
                }))
                .collect();
            serde_json::Value::Array(results).to_string()
        })?)?;
    }

    // saveDataRaw(filename, content) → 实际写入路径，失败返回 "ERROR:..."
    {
        let data_dir = app_data_dir.to_owned();
        let cid = chain_id.to_owned();
        g.set("saveDataRaw", Function::new(ctx.clone(), move |filename: String, content: String| -> String {
            use std::time::{SystemTime, UNIX_EPOCH};
            if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
                return "ERROR:Invalid filename".into();
            }
            let dir = std::path::Path::new(&data_dir).join("save_data").join(&cid);
            if let Err(e) = std::fs::create_dir_all(&dir) {
                return format!("ERROR:{e}");
            }
            let target = dir.join(&filename);
            let final_path = if target.exists() {
                let ts = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                let stem = std::path::Path::new(&filename)
                    .file_stem().and_then(|s| s.to_str()).unwrap_or(&filename);
                let ext = std::path::Path::new(&filename)
                    .extension().and_then(|s| s.to_str());
                let new_name = match ext {
                    Some(e) => format!("{}_{}.{}", stem, ts, e),
                    None    => format!("{}.{}", stem, ts),
                };
                dir.join(new_name)
            } else {
                target
            };
            match std::fs::write(&final_path, content.as_bytes()) {
                Ok(_)  => final_path.to_str().unwrap_or("").to_string(),
                Err(e) => format!("ERROR:{e}"),
            }
        })?)?;
    }

    Ok(())
}

fn inject_trace(ctx: &Ctx<'_>, session: &DebugSession, filters: &AnalysisFilters) -> rquickjs::Result<()> {
    let arr = rquickjs::Array::new(ctx.clone())?;
    let mut out_idx: u32 = 0;

    for (i, step) in session.trace.iter().enumerate() {
        if let Some((from, to)) = filters.step_range {
            if i < from || i > to { continue; }
        }
        if let Some(ref f) = filters.opcodes {
            if !f.contains(&step.opcode) { continue; }
        }
        if let Some(ref f) = filters.frames {
            if !f.contains(&step.context_id) { continue; }
        }
        if let Some(ref f) = filters.contracts {
            let addr: &[u8; 20] = step.contract_address.as_ref();
            if !f.contains(addr) { continue; }
        }
        if let Some(ref f) = filters.targets {
            let addr: &[u8; 20] = step.call_target.as_ref();
            if !f.contains(addr) { continue; }
        }

        let obj = Object::new(ctx.clone())?;
        obj.set("stepIndex", i as u32)?;   // 全局步骤下标（可点击跳转）
        obj.set("index", i as u32)?;        // 兼容旧脚本
        obj.set("contextId", step.context_id as u32)?;
        obj.set("frameStep", step.frame_step)?;
        obj.set("pc", step.pc)?;
        let opcode_name = revm::bytecode::opcode::OpCode::new(step.opcode)
            .map(|op| op.as_str())
            .unwrap_or("UNKNOWN");
        obj.set("opcode", opcode_name)?;
        obj.set("opcodeNum", step.opcode as u32)?;
        let mut hex_buf = [0u8; 4];
        hex_buf[0] = b'0';
        hex_buf[1] = b'x';
        hex_buf[2] = HEX[(step.opcode >> 4) as usize];
        hex_buf[3] = HEX[(step.opcode & 0x0f) as usize];
        obj.set("opcodeHex", unsafe { std::str::from_utf8_unchecked(&hex_buf) })?;
        obj.set("gasCost", step.gas_cost as f64)?;
        obj.set("gasRemaining", step.gas_remaining as f64)?;
        obj.set("contract", bytes_to_hex(step.contract_address.as_ref()))?;
        obj.set("target",   bytes_to_hex(step.call_target.as_ref()))?;

        let stack = rquickjs::Array::new(ctx.clone())?;
        for (j, v) in step.stack.iter().enumerate() {
            stack.set(j, u256_to_hex(v))?;
        }
        obj.set("stack", stack)?;

        arr.set(out_idx as usize, obj)?;
        out_idx += 1;
    }

    let g = ctx.globals();
    g.set("trace", arr.clone())?;
    g.set("steps", arr)?;
    Ok(())
}

/// Tauri 命令层传入的原始过滤参数（由前端 @filter 注释解析而来）
#[derive(serde::Deserialize, Default)]
pub struct RawFilters {
    pub opcodes:    Option<Vec<String>>,
    pub contracts:  Option<Vec<String>>,
    pub targets:    Option<Vec<String>>,
    pub frames:     Option<Vec<u16>>,
    /// [from, to] 两元素数组，全局步骤下标范围（含两端）
    pub step_range: Option<Vec<usize>>,
    /// 懒加载模式：跳过 inject_trace，trace/steps 为空数组，全靠 query API 按需取数据
    pub lazy:       Option<bool>,
}

pub fn run_analysis(
    session: &DebugSession,
    script: &str,
    raw_filters: RawFilters,
    cancelled: Arc<AtomicBool>,
    app_data_dir: String,
    chain_id: String,
) -> Result<serde_json::Value, String> {
    let lazy = raw_filters.lazy.unwrap_or(false);
    let filters = AnalysisFilters::from_raw(raw_filters);
    if cancelled.load(Ordering::Relaxed) {
        return Err("Cancelled before start".into());
    }

    let t0 = std::time::Instant::now();

    let rt = Runtime::new().map_err(|e| format!("Runtime: {e}"))?;

    rt.set_memory_limit(4 * 1024 * 1024 * 1024);   // 4 GB 堆上限
    rt.set_max_stack_size(5 * 1024 * 1024);         // 5 MB 栈上限

    let deadline = Instant::now() + Duration::from_secs(30);
    let cancelled_int = Arc::clone(&cancelled);
    rt.set_interrupt_handler(Some(Box::new(move || {
        cancelled_int.load(Ordering::Relaxed) || Instant::now() > deadline
    })));

    let ctx = Context::full(&rt).map_err(|e| format!("Context: {e}"))?;

    ctx.with(|ctx: Ctx| -> Result<serde_json::Value, String> {
        let inject_ms;
        if lazy {
            // 懒加载模式：注入空数组占位，脚本通过 query API 按需取数据
            let empty = rquickjs::Array::new(ctx.clone()).map_err(|e| format!("inject: {e}"))?;
            let g = ctx.globals();
            g.set("trace", empty.clone()).map_err(|e| format!("inject: {e}"))?;
            g.set("steps", empty).map_err(|e| format!("inject: {e}"))?;
            inject_ms = 0.0;
        } else {
            let t1 = std::time::Instant::now();
            inject_trace(&ctx, session, &filters).map_err(|e| format!("inject: {e}"))?;
            inject_ms = t1.elapsed().as_secs_f64() * 1000.0;
        }

        if cancelled.load(Ordering::Relaxed) {
            return Err("Cancelled after injection".into());
        }

        
        let session_ptr = session as *const DebugSession as usize;
        ctx.globals()
            .set(
                "getMemory",
                Function::new(ctx.clone(), move |index: i32| -> String {
                    let sess: &DebugSession =
                        unsafe { &*(session_ptr as *const DebugSession) };
                    let idx = index as usize;
                    if idx >= sess.trace.len() {
                        return String::new();
                    }
                    let step = &sess.trace[idx];
                    let mem =
                        sess.compute_memory_at_step(step.context_id, step.frame_step);
                    bytes_to_hex(&mem)
                })
                .map_err(|e| format!("getMemory fn: {e}"))?,
            )
            .map_err(|e| format!("register getMemory: {e}"))?;

        register_query_fns(&ctx, session_ptr, &app_data_dir, &chain_id)
            .map_err(|e| format!("query fns: {e}"))?;

        ctx.eval::<Value, _>(
            r#"
            function hexToNumber(hex) {
                if (typeof hex === 'string' && hex.startsWith('0x')) hex = hex.slice(2);
                return parseInt(hex, 16);
            }
            function readMemory(stepOrIndex, offset, size) {
                var mem = typeof stepOrIndex === 'number'
                    ? getMemory(stepOrIndex)
                    : getMemory(stepOrIndex.index);
                if (!mem || mem === '0x') return '0x';
                var h = mem.slice(2);
                return '0x' + h.slice(offset * 2, offset * 2 + size * 2);
            }
            // JS 侧包装，处理 undefined/null 参数，屏蔽底层 Raw 函数
            function findStepIndices(opcode, from, to) {
                return findStepIndicesRaw(opcode,
                    from !== undefined && from !== null ? from : -1,
                    to   !== undefined && to   !== null ? to   : -1);
            }
            function firstStep(opcode, from) {
                var r = firstStepRaw(opcode, from !== undefined && from !== null ? from : -1);
                return r < 0 ? null : r;
            }
            function countSteps(opcode, from, to) {
                return countStepsRaw(opcode,
                    from !== undefined && from !== null ? from : -1,
                    to   !== undefined && to   !== null ? to   : -1);
            }
            function getStep(i) {
                var r = getStepRaw(i);
                return (r === 'null' || !r) ? null : JSON.parse(r);
            }
            function aggregateByOpcode(from, to) {
                return JSON.parse(aggregateByOpcodeRaw(
                    from !== undefined && from !== null ? from : -1,
                    to   !== undefined && to   !== null ? to   : -1));
            }
            function countByFrame() {
                return JSON.parse(countByFrameRaw());
            }
            function getContractStats(addr) {
                return JSON.parse(getContractStatsRaw(addr));
            }
            function getSlotHistory(slot) {
                return JSON.parse(getSlotHistoryRaw(slot));
            }
            function getFrameInfo(frameId) {
                var r = getFrameInfoRaw(frameId);
                return (r === 'null' || !r) ? null : JSON.parse(r);
            }
            function getStorageChanges(addr, from, to) {
                return JSON.parse(getStorageChangesRaw(
                    addr || '',
                    from !== undefined && from !== null ? from : -1,
                    to   !== undefined && to   !== null ? to   : -1));
            }
            // saveData(filename, content) → 写入路径字符串，失败抛出异常
            function saveData(filename, content) {
                var result = saveDataRaw(
                    filename,
                    typeof content === 'string' ? content : JSON.stringify(content, null, 2)
                );
                if (typeof result === 'string' && result.startsWith('ERROR:')) {
                    throw new Error(result.slice(6));
                }
                return result;
            }
            "#,
        )
        .catch(&ctx)
        .map_err(|e| format!("helpers: {e}"))?;

        if cancelled.load(Ordering::Relaxed) {
            return Err("Cancelled before script".into());
        }

        let t2 = std::time::Instant::now();
        let result: Value =
            ctx.eval(script).catch(&ctx).map_err(|e| format!("Script error: {e}"))?;
        let exec_ms = t2.elapsed().as_secs_f64() * 1000.0;

        let json = if result.is_undefined() || result.is_null() {
            serde_json::Value::Null
        } else {
            let json_obj: Object =
                ctx.globals().get("JSON").map_err(|e| format!("get JSON: {e}"))?;
            let stringify: Function =
                json_obj.get("stringify").map_err(|e| format!("get stringify: {e}"))?;
            match stringify.call::<_, String>((result,)) {
                Ok(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::Null),
                Err(_) => serde_json::Value::Null,
            }
        };

        println!(
            "[analysis] {} steps | inject {:.0}ms, exec {:.0}ms, total {:.0}ms",
            session.trace.len(),
            inject_ms,
            exec_ms,
            t0.elapsed().as_secs_f64() * 1000.0,
        );

        Ok(json)
    })
}
