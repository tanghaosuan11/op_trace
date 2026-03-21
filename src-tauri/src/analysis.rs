use std::collections::HashSet;
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


fn inject_trace(ctx: &Ctx<'_>, session: &DebugSession, opcode_filter: Option<&HashSet<u8>>) -> rquickjs::Result<()> {
    let arr = rquickjs::Array::new(ctx.clone())?;

    for (i, step) in session.trace.iter().enumerate() {
        if let Some(filter) = opcode_filter {
            if !filter.contains(&step.opcode) {
                continue;
            }
        }

        let obj = Object::new(ctx.clone())?;
        obj.set("index", i as u32)?;
        obj.set("contextId", step.context_id as u32)?;
        obj.set("frameStep", step.frame_step)?;
        obj.set("pc", step.pc)?;
        let opcode_name = revm::bytecode::opcode::OpCode::new(step.opcode)
            .map(|op| op.as_str())
            .unwrap_or("UNKNOWN");
        obj.set("opcode", opcode_name)?;
        obj.set("opcodeNum", step.opcode as u32)?;
        let mut hex_buf = [0u8; 4]; // "0x" + 2 hex digits
        hex_buf[0] = b'0';
        hex_buf[1] = b'x';
        hex_buf[2] = HEX[(step.opcode >> 4) as usize];
        hex_buf[3] = HEX[(step.opcode & 0x0f) as usize];
        obj.set("opcodeHex", unsafe { std::str::from_utf8_unchecked(&hex_buf) })?;
        obj.set("gasCost", step.gas_cost as f64)?;
        obj.set("gasRemaining", step.gas_remaining as f64)?;

        let stack = rquickjs::Array::new(ctx.clone())?;
        for (j, v) in step.stack.iter().enumerate() {
            stack.set(j, u256_to_hex(v))?;
        }
        obj.set("stack", stack)?;

        arr.set(i, obj)?;
    }

    let g = ctx.globals();
    g.set("trace", arr.clone())?;
    g.set("steps", arr)?;
    Ok(())
}


pub fn run_analysis(
    session: &DebugSession,
    script: &str,
    opcodes: Option<&[String]>,
    cancelled: Arc<AtomicBool>,
) -> Result<serde_json::Value, String> {
    let opcode_filter: Option<HashSet<u8>> = opcodes.and_then(|list| {
        if list.is_empty() {
            return None;
        }
        let mut set = HashSet::new();
        for s in list {
            let s = s.trim().to_uppercase();
            if s.starts_with("0X") {
                if let Ok(v) = u8::from_str_radix(&s[2..], 16) {
                    set.insert(v);
                }
            } else {
                for op_num in 0u8..=255 {
                    if let Some(op) = revm::bytecode::opcode::OpCode::new(op_num) {
                        if op.as_str() == s {
                            set.insert(op_num);
                            break;
                        }
                    }
                }
            }
        }
        if set.is_empty() { None } else { Some(set) }
    });
    if cancelled.load(Ordering::Relaxed) {
        return Err("Cancelled before start".into());
    }

    let t0 = std::time::Instant::now();

    let rt = Runtime::new().map_err(|e| format!("Runtime: {e}"))?;

    rt.set_memory_limit(2 * 1024 * 1024 * 1024);   // 2 GB JS 堆
    rt.set_max_stack_size(2 * 1024 * 1024);   // 2 MB JS 调用栈

    let deadline = Instant::now() + Duration::from_secs(30);
    let cancelled_int = Arc::clone(&cancelled);
    rt.set_interrupt_handler(Some(Box::new(move || {
        cancelled_int.load(Ordering::Relaxed) || Instant::now() > deadline
    })));

    let ctx = Context::full(&rt).map_err(|e| format!("Context: {e}"))?;

    ctx.with(|ctx: Ctx| -> Result<serde_json::Value, String> {
        let t1 = std::time::Instant::now();
        inject_trace(&ctx, session, opcode_filter.as_ref()).map_err(|e| format!("inject: {e}"))?;
        let inject_ms = t1.elapsed().as_secs_f64() * 1000.0;

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
