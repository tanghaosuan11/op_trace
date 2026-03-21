//! 条件断点全量扫描
//!
//! 对 trace 进行并行扫描，返回命中条件组的步骤列表。

use super::debug_session;
use revm::primitives::U256;
use serde::{Deserialize, Serialize};

// ── 扫描类型 ──────────────────────────────────────────────────────────────────

/// 单条条件断点
#[derive(Deserialize)]
pub struct ScanCondition {
    pub id: String,
    #[serde(rename = "type")]
    pub cond_type: String, // "sstore_slot" | "sload_slot" | "call_address" | "call_selector" | "log_topic" | "contract_address" | "target_address"
    pub value: String,     // hex string
}

/// 条件组（组内 AND/OR，组间 OR）
#[derive(Deserialize)]
pub struct ConditionGroup {
    pub id: String,
    /// "AND" | "OR"
    pub logic: String,
    pub conditions: Vec<ScanCondition>,
}

/// 单条命中结果
#[derive(Serialize)]
pub struct ScanHit {
    pub step_index: usize,
    pub context_id: u16,
    pub pc: u32,
    pub opcode: u8,
    pub description: String,
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/// 规范化 hex：去 0x、小写、不补齐
fn normalize_hex(s: &str) -> String {
    s.trim_start_matches("0x")
        .trim_start_matches("0X")
        .to_ascii_lowercase()
}

/// U256 → 64 char hex（无 0x 前缀）
fn u256_to_hex64(v: &U256) -> String {
    format!("{:064x}", v)
}

/// 预处理后的单条条件（避免在循环内重复搬运字符串）
struct PreparedCond {
    cond_type: String,
    target: String,
    target_padded64: String,
}

impl PreparedCond {
    fn from(c: &ScanCondition) -> Self {
        let target = normalize_hex(&c.value);
        let target_padded64 = format!("{:0>64}", &target);
        PreparedCond {
            cond_type: c.cond_type.clone(),
            target,
            target_padded64,
        }
    }
}

/// 检测单条条件是否命中当前步骤，返回命中描述或 None
fn check_single(
    step: &debug_session::TraceStep,
    pc: &PreparedCond,
    mem_cache: &mut std::collections::HashMap<(u16, u32), Vec<u8>>,
    session: &debug_session::DebugSession,
) -> Option<String> {
    let op = step.opcode;
    match pc.cond_type.as_str() {
        "sstore_slot" => {
            if op != 0x55 || step.stack.is_empty() {
                return None;
            }
            let slot = u256_to_hex64(step.stack.last().unwrap());
            if slot == pc.target_padded64 {
                Some(format!("SSTORE slot 0x{}", pc.target))
            } else {
                None
            }
        }
        "sload_slot" => {
            if op != 0x54 || step.stack.is_empty() {
                return None;
            }
            let slot = u256_to_hex64(step.stack.last().unwrap());
            if slot == pc.target_padded64 {
                Some(format!("SLOAD slot 0x{}", pc.target))
            } else {
                None
            }
        }
        "call_address" => {
            if op != 0xf1 && op != 0xfa && op != 0xf4 {
                return None;
            }
            if step.stack.len() < 2 {
                return None;
            }
            let addr = u256_to_hex64(&step.stack[step.stack.len() - 2]);
            let addr_low = &addr[24..];
            let target_trimmed = pc.target.trim_start_matches('0');
            if addr_low.ends_with(target_trimmed) || addr_low == &pc.target_padded64[24..] {
                let op_name = match op {
                    0xf1 => "CALL",
                    0xfa => "STATICCALL",
                    _ => "DELEGATECALL",
                };
                Some(format!("{} → 0x{}", op_name, pc.target))
            } else {
                None
            }
        }
        "call_selector" => {
            if op != 0xf1 && op != 0xfa && op != 0xf4 {
                return None;
            }
            let (offset_idx, size_idx) = if op == 0xf1 {
                if step.stack.len() < 5 {
                    return None;
                }
                (step.stack.len() - 4, step.stack.len() - 5)
            } else {
                if step.stack.len() < 4 {
                    return None;
                }
                (step.stack.len() - 3, step.stack.len() - 4)
            };
            let args_offset: usize = step.stack[offset_idx].try_into().unwrap_or(usize::MAX);
            let args_size: usize = step.stack[size_idx].try_into().unwrap_or(0);
            if args_size < 4 {
                return None;
            }
            let mem = mem_cache
                .entry((step.context_id, step.frame_step))
                .or_insert_with(|| {
                    session.compute_memory_at_step(step.context_id, step.frame_step)
                });
            if args_offset + 4 > mem.len() {
                return None;
            }
            let selector = format!(
                "{:02x}{:02x}{:02x}{:02x}",
                mem[args_offset],
                mem[args_offset + 1],
                mem[args_offset + 2],
                mem[args_offset + 3],
            );
            let target_sel = if pc.target.len() >= 8 {
                &pc.target[..8]
            } else {
                &pc.target
            };
            if selector == target_sel {
                let op_name = match op {
                    0xf1 => "CALL",
                    0xfa => "STATICCALL",
                    _ => "DELEGATECALL",
                };
                Some(format!("{} selector 0x{}", op_name, target_sel))
            } else {
                None
            }
        }
        "log_topic" => {
            if op < 0xa1 || op > 0xa4 || step.stack.len() < 3 {
                return None;
            }
            let topic = u256_to_hex64(&step.stack[step.stack.len() - 3]);
            if topic == pc.target_padded64 {
                Some(format!("LOG topic 0x{}", pc.target))
            } else {
                None
            }
        }
        "contract_address" => {
            let addr_hex = format!("{:040x}", step.contract_address);
            let target_trimmed = pc.target.trim_start_matches('0');
            if addr_hex.ends_with(target_trimmed) {
                Some(format!("Contract 0x{}", pc.target))
            } else {
                None
            }
        }
        "target_address" => {
            let addr_hex = format!("{:040x}", step.call_target);
            let target_trimmed = pc.target.trim_start_matches('0');
            if addr_hex.ends_with(target_trimmed) {
                Some(format!("Target 0x{}", pc.target))
            } else {
                None
            }
        }
        _ => None,
    }
}

// ── 主扫描入口 ────────────────────────────────────────────────────────────────

pub fn scan_conditions_impl(
    session: &debug_session::DebugSession,
    groups: &[ConditionGroup],
) -> Vec<ScanHit> {
    use rayon::prelude::*;

    if groups.is_empty() || session.trace.is_empty() {
        return Vec::new();
    }

    // 预处理所有组中的条件
    struct PreparedGroup {
        logic: String,
        conditions: Vec<PreparedCond>,
    }
    let prepared_groups: Vec<PreparedGroup> = groups
        .iter()
        .map(|g| PreparedGroup {
            logic: g.logic.clone(),
            conditions: g.conditions.iter().map(PreparedCond::from).collect(),
        })
        .collect();

    const CHUNK: usize = 8192;

    let mut hits: Vec<ScanHit> = session
        .trace
        .par_chunks(CHUNK)
        .enumerate()
        .flat_map(|(chunk_idx, chunk)| {
            let base = chunk_idx * CHUNK;
            let mut mem_cache: std::collections::HashMap<(u16, u32), Vec<u8>> =
                std::collections::HashMap::new();
            let mut local_hits = Vec::new();

            'step: for (j, step) in chunk.iter().enumerate() {
                let i = base + j;
                // 组间 OR：任意一组命中即暂停
                for group in &prepared_groups {
                    let is_and = group.logic == "AND";
                    if group.conditions.is_empty() {
                        continue;
                    }

                    let mut descriptions: Vec<String> = Vec::new();
                    let mut group_hit = is_and; // AND 初始 true，OR 初始 false

                    for cond in &group.conditions {
                        let result = check_single(step, cond, &mut mem_cache, session);
                        if is_and {
                            if let Some(desc) = result {
                                descriptions.push(desc);
                            } else {
                                group_hit = false;
                                break; // AND 短路
                            }
                        } else {
                            // OR：任意一个命中即可
                            if let Some(desc) = result {
                                group_hit = true;
                                descriptions.push(desc);
                                break; // OR 短路
                            }
                        }
                    }

                    if group_hit && !descriptions.is_empty() {
                        local_hits.push(ScanHit {
                            step_index: i,
                            context_id: step.context_id,
                            pc: step.pc,
                            opcode: step.opcode,
                            description: descriptions.join(" AND "),
                        });
                        continue 'step; // 已命中，不重复记录同一步骤
                    }
                }
            }
            local_hits
        })
        .collect();

    hits.sort_unstable_by_key(|h| h.step_index);
    hits
}
