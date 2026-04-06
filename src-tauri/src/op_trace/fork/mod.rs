// What-If Fork 模块：补丁类型与校验（`op_trace` 里实际执行走 `evm_runner` + `Cheatcodes::set_patches`）。

use revm::primitives::{hex::FromHex, Address, U256};

#[derive(Clone, Debug, serde::Deserialize)]
pub struct StatePatch {
    pub step_index: usize,
    pub stack_patches: Vec<(usize, String)>,  // (stack_pos, hex_value)
    pub memory_patches: Vec<(usize, String)>, // (byte_offset, hex_data)
    /// (address hex, slot hex, value hex)，与 SSTORE 一致：写入当前执行上下文的合约存储
    #[serde(default)]
    pub storage_patches: Vec<(String, String, String)>,
    /// (address hex, absolute balance wei hex)：执行时先读当前余额，再 balance_incr / transfer 调到目标
    #[serde(default)]
    pub balance_patches: Vec<(String, String)>,
}

pub(crate) fn parse_address_hex(s: &str) -> Result<Address, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("Address is required".into());
    }
    Address::from_hex(s).map_err(|e| format!("Invalid address: {e}"))
}

pub(crate) fn parse_u256_hex(s: &str) -> Result<U256, String> {
    let t = s.trim();
    if t.starts_with('-') {
        return Err("Value cannot be negative".into());
    }
    let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    if t.is_empty() {
        return Err("Value is required".into());
    }
    U256::from_str_radix(t, 16).map_err(|_| "Invalid hex (U256)".to_string())
}

fn hex_payload_byte_len(hex: &str) -> Result<usize, String> {
    let t = hex.trim();
    let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    if t.is_empty() {
        return Ok(0);
    }
    if t.len() % 2 != 0 {
        return Err("Memory data hex must have an even number of digits".into());
    }
    if !t.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Memory data hex contains invalid characters".into());
    }
    Ok(t.len() / 2)
}

fn parse_pc_u32(s: &str) -> Result<u32, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("PC is required".into());
    }
    if s.starts_with("0x") || s.starts_with("0X") {
        u32::from_str_radix(s.trim_start_matches("0x").trim_start_matches("0X"), 16)
            .map_err(|_| "Invalid PC hex".into())
    } else {
        s.parse::<u32>().map_err(|_| "Invalid PC".into())
    }
}

fn validate_value_wei_hex(s: &str) -> Result<(), String> {
    let t = s.trim();
    if t.starts_with('-') {
        return Err("Value cannot be negative".into());
    }
    let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    if t.is_empty() {
        return Err("Value is required".into());
    }
    U256::from_str_radix(t, 16).map_err(|_| "Invalid value hex".to_string())?;
    Ok(())
}

/// 根据 DebugSession 中的完整 trace 校验 Fork 补丁是否合法（与前端 1-based step 对应：传入 0-based `step_index`）。
pub fn validate_fork_patch_impl(
    session: &super::debug_session::DebugSession,
    step_index: usize,
    kind: &str,
    stack_pos: Option<usize>,
    mem_offset: Option<usize>,
    mem_hex: Option<&str>,
    pc_hex: Option<&str>,
    value_hex: Option<&str>,
    storage_address_hex: Option<&str>,
    storage_slot_hex: Option<&str>,
    storage_value_hex: Option<&str>,
    balance_address_hex: Option<&str>,
) -> Result<(), String> {
    let total = session.trace.len();
    if total == 0 {
        return Err("Trace is empty".into());
    }
    if step_index >= total {
        return Err(format!(
            "Step out of range: trace has {} steps (valid 1-based step field: 1..={})",
            total, total
        ));
    }

    let step = &session.trace[step_index];
    let tid = step.transaction_id;
    let ctx_id = step.context_id;
    let key = (tid, ctx_id);

    match kind {
        "stack" => {
            let pos = stack_pos.ok_or_else(|| "stackPos is required".to_string())?;
            let depth = step.stack.len();
            if pos >= depth {
                return Err(format!(
                    "Stack depth at this step is {} (pos 0 = top); pos {} is out of range",
                    depth, pos
                ));
            }
        }
        "memory" => {
            let off = mem_offset.ok_or_else(|| "memOffset is required".to_string())?;
            let hex = mem_hex.ok_or_else(|| "memHex is required".to_string())?;
            let nbytes = hex_payload_byte_len(hex)?;
            if nbytes == 0 {
                return Err("Memory data length must be non-zero".into());
            }
            let mem = session.compute_memory_at_step(tid, ctx_id, step.frame_step);
            if off + nbytes > mem.len() {
                return Err(format!(
                    "Memory write out of range: memory length is {} bytes; offset {} + {} exceeds",
                    mem.len(),
                    off,
                    nbytes
                ));
            }
        }
        "pc" => {
            let raw = pc_hex.ok_or_else(|| "pcHex is required".to_string())?;
            let pc_val = parse_pc_u32(raw)?;
            let code_len = session
                .frame_bytecodes
                .get(&key)
                .map(|b| b.len())
                .unwrap_or(0);
            if code_len == 0 {
                return Err("No bytecode for this frame; cannot validate PC".into());
            }
            if (pc_val as usize) >= code_len {
                return Err(format!(
                    "PC out of range: bytecode is {} bytes; valid PC is 0..{}",
                    code_len,
                    code_len.saturating_sub(1)
                ));
            }
        }
        "value" => {
            let addr_s =
                balance_address_hex.ok_or_else(|| "Balance address is required".to_string())?;
            let raw = value_hex.ok_or_else(|| "Balance (wei hex) is required".to_string())?;
            parse_address_hex(addr_s)?;
            validate_value_wei_hex(raw)?;
        }
        "storage" => {
            let addr_s =
                storage_address_hex.ok_or_else(|| "Storage address is required".to_string())?;
            let slot_s = storage_slot_hex.ok_or_else(|| "Storage slot is required".to_string())?;
            let val_s = storage_value_hex.ok_or_else(|| "Storage value is required".to_string())?;
            let addr = parse_address_hex(addr_s)?;
            let _slot = parse_u256_hex(slot_s)?;
            let _val = parse_u256_hex(val_s)?;
            if addr != step.call_target {
                return Err(format!(
                    "Storage patch address must match this step's contract context (call target): expected {:?}, got {:?}",
                    step.call_target, addr
                ));
            }
        }
        _ => return Err(format!("Unknown patch kind: {}", kind)),
    }
    Ok(())
}
