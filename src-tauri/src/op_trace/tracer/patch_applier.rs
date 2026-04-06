//! Fork / What-If：在每条 opcode 执行前注入对栈、内存等的修改（及后续 storage、ETH 余额等）。
//!
//! 与 `gas_tracer` 等「只读记录」不同，这里会改变解释器 / journal 状态，故单独成模块便于扩展。

use crate::optrace_journal::{OpTraceBalancePatch, OpTraceJournal};
use revm::{
    bytecode::OpCode,
    context::Cfg,
    context::ContextTr,
    context_interface::{Block, JournalTr, Transaction},
    interpreter::interpreter::EthInterpreter,
    primitives::{StorageKey, U256},
    Context,
};
use revm_interpreter::interpreter_types::Jumps;

use crate::op_trace::fork::{parse_address_hex, parse_u256_hex, StatePatch};
use crate::op_trace::AlloyCacheDB;

fn hex_decode(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0usize;
    while i + 1 < s.len() {
        if let Ok(v) = u8::from_str_radix(&s[i..i + 2], 16) {
            out.push(v);
        }
        i += 2;
    }
    out
}

/// 对当前 `global_step` 上排队的所有 `StatePatch` 依次生效（与 `patch.step_index` 对齐）。
///
/// `context`：stack/memory 改解释器；storage 走 `journal_mut().sstore`（与 EVM SSTORE 一致）。
pub fn apply_pending_patches_at_step<BlockT, TxT, CfgT>(
    patches: &[StatePatch],
    next_patch_idx: &mut usize,
    global_step: usize,
    patch_log_enabled: bool,
    interp: &mut revm::interpreter::Interpreter<EthInterpreter>,
    context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
) where
    BlockT: Block + Clone,
    TxT: Transaction + Clone,
    CfgT: Cfg + Clone,
    Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>: ContextTr,
    <Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>> as ContextTr>::Journal:
        JournalTr + OpTraceBalancePatch,
{
    while *next_patch_idx < patches.len()
        && patches[*next_patch_idx].step_index == global_step
    {
        let patch = &patches[*next_patch_idx];
        let opcode = interp.bytecode.opcode();
        let op = OpCode::new(opcode).unwrap();
        if patch_log_enabled {
            println!(
                "[PatchApplier] ▶ patch hit: global_step={} step_index={} stack_patches={} mem_patches={} storage_patches={} balance_patches={} opcode={:?}",
                global_step,
                patch.step_index,
                patch.stack_patches.len(),
                patch.memory_patches.len(),
                patch.storage_patches.len(),
                patch.balance_patches.len(),
                op.as_str(),
            );
        }

        for (pos, hex_val) in &patch.stack_patches {
            let value =
                U256::from_str_radix(hex_val.trim_start_matches("0x"), 16).unwrap_or_default();
            let data = interp.stack.data_mut();
            let stack_len = data.len();
            let idx = stack_len.saturating_sub(1).saturating_sub(*pos);
            if idx < stack_len {
                data[idx] = value;
            }
        }

        for (offset, hex_data) in &patch.memory_patches {
            let bytes: Vec<u8> = hex_decode(hex_data);
            if !bytes.is_empty() {
                let needed = offset + bytes.len();
                let aligned = needed.next_multiple_of(32);
                if interp.memory.len() < aligned {
                    interp.memory.resize(aligned);
                }
                interp.memory.set(*offset, &bytes);
            }
        }

        for (addr_hex, slot_hex, val_hex) in &patch.storage_patches {
            let addr = match parse_address_hex(addr_hex) {
                Ok(a) => a,
                Err(e) => {
                    if patch_log_enabled {
                        eprintln!("[PatchApplier] bad storage address: {e}");
                    }
                    continue;
                }
            };
            let slot = match parse_u256_hex(slot_hex) {
                Ok(s) => s,
                Err(e) => {
                    if patch_log_enabled {
                        eprintln!("[PatchApplier] bad storage slot: {e}");
                    }
                    continue;
                }
            };
            let val = match parse_u256_hex(val_hex) {
                Ok(v) => v,
                Err(e) => {
                    if patch_log_enabled {
                        eprintln!("[PatchApplier] bad storage value: {e}");
                    }
                    continue;
                }
            };
            let key = StorageKey::from(slot);
            if let Err(e) = context.journal_mut().sstore(addr, key, val) {
                if patch_log_enabled {
                    eprintln!("[PatchApplier] sstore failed: addr={addr:?} err={e:?}");
                }
            }
        }

        if !patch.balance_patches.is_empty() {
            let sink_primary = context.block().beneficiary();
            for (addr_hex, target_hex) in &patch.balance_patches {
                let addr = match parse_address_hex(addr_hex) {
                    Ok(a) => a,
                    Err(e) => {
                        if patch_log_enabled {
                            eprintln!("[PatchApplier] bad balance address: {e}");
                        }
                        continue;
                    }
                };
                let target = match parse_u256_hex(target_hex) {
                    Ok(t) => t,
                    Err(e) => {
                        if patch_log_enabled {
                            eprintln!("[PatchApplier] bad balance target: {e}");
                        }
                        continue;
                    }
                };
                OpTraceBalancePatch::apply_fork_balance_absolute(
                    context.journal_mut(),
                    addr,
                    target,
                    sink_primary,
                    patch_log_enabled,
                );
            }
        }

        *next_patch_idx += 1;
    }
}
