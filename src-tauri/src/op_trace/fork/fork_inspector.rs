//! ForkInspector：包装现有 Cheatcodes，在指定步注入 stack/memory patch。

use crate::optrace_journal::OpTraceJournal;
use revm::{
    bytecode::OpCode,
    context::Cfg,
    context_interface::{Block, Transaction},
    interpreter::{CallInputs, CallOutcome},
    primitives::{Log, U256},
    Context, Inspector,
};
use revm_interpreter::{CreateInputs, CreateOutcome, interpreter_types::Jumps};

use super::super::debug_session::DebugSession;
use super::super::inspector::Cheatcodes;
use super::super::message_encoder::MessageEncoder;
use super::super::AlloyCacheDB;
use super::StatePatch;

use std::sync::{Arc, Mutex};


pub(crate) struct ForkInspector<BlockT, TxT, CfgT> {
    pub inner: Cheatcodes<BlockT, TxT, CfgT>,
    pub(crate) patches: Vec<StatePatch>,
    next_patch_idx: usize,
    global_step: usize,
}

impl<BlockT, TxT, CfgT> ForkInspector<BlockT, TxT, CfgT> {
    pub fn new(
        encoder: MessageEncoder,
        debug_session: Arc<Mutex<DebugSession>>,
        mut patches: Vec<StatePatch>,
    ) -> Self {
        patches.sort_by_key(|p| p.step_index);
        Self {
            inner: Cheatcodes::new(
                encoder,
                debug_session,
                std::env::temp_dir().join("optrace"),
                true,
            ),
            patches,
            next_patch_idx: 0,
            global_step: 0,
        }
    }

    pub fn flush_steps(&mut self) {
        self.inner.flush_steps();
    }

    pub fn send_finished(&self) {
        self.inner.send_finished();
    }

    pub fn send_balance_changes(&self, json: &str) {
        self.inner.send_balance_changes(json);
    }

    pub fn new_from_cheatcodes(
        inner: Cheatcodes<BlockT, TxT, CfgT>,
        mut patches: Vec<StatePatch>,
    ) -> Self {
        patches.sort_by_key(|p| p.step_index);
        Self {
            inner,
            patches,
            next_patch_idx: 0,
            global_step: 0,
        }
    }
}


impl<BlockT, TxT, CfgT>
    Inspector<Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>>
    for ForkInspector<BlockT, TxT, CfgT>
where
    BlockT: Block + Clone,
    TxT: Transaction + Clone,
    CfgT: Cfg + Clone,
{
    fn step(
        &mut self,
        interp: &mut revm::interpreter::Interpreter<revm::interpreter::interpreter::EthInterpreter>,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
    ) {
        // 1. 在 inner.step() 之前注入 patch（修改栈/内存）
        if self.next_patch_idx < self.patches.len()
            && self.patches[self.next_patch_idx].step_index == self.global_step
        {
            let opcode = interp.bytecode.opcode();
            let op = OpCode::new(opcode).unwrap();
            let patch = &self.patches[self.next_patch_idx];
            println!(
                "[ForkInspector] ▶ patch hit: global_step={} step_index={} \
                 stack_patches={} mem_patches={} opcode={:?}",
                self.global_step,
                patch.step_index,
                patch.stack_patches.len(),
                patch.memory_patches.len(),
                op.as_str(),
            );

            // 注入栈修改
            for (pos, hex_val) in &patch.stack_patches {
                let value =
                    U256::from_str_radix(hex_val.trim_start_matches("0x"), 16).unwrap_or_default();
                let data = interp.stack.data_mut();
                let stack_len = data.len();
                let idx = stack_len.saturating_sub(1).saturating_sub(*pos);
                println!(
                    "[ForkInspector]   stack: pos={pos} hex={hex_val} → value={value} \
                     stack_len={stack_len} idx={idx} in_bounds={}",
                    idx < stack_len,
                );
                if idx < stack_len {
                    let before = data[idx];
                    data[idx] = value;
                    println!("[ForkInspector]   stack[{idx}]: {before} → {}", data[idx]);
                } else {
                    println!("[ForkInspector]   stack: SKIP — index out of bounds");
                }
            }

            // 注入内存修改
            for (offset, hex_data) in &patch.memory_patches {
                let bytes: Vec<u8> = hex_decode(hex_data);
                if !bytes.is_empty() {
                    let mem_len_before = interp.memory.len();
                    let needed = offset + bytes.len();
                    let aligned = needed.next_multiple_of(32);
                    println!(
                        "[ForkInspector]   mem: offset={offset} data_len={} \
                         mem_before={mem_len_before} needed={needed} aligned={aligned}",
                        bytes.len(),
                    );
                    if mem_len_before < aligned {
                        interp.memory.resize(aligned);
                        println!(
                            "[ForkInspector]   mem: resized {} → {}",
                            mem_len_before,
                            interp.memory.len()
                        );
                    }
                    interp.memory.set(*offset, &bytes);
                    println!("[ForkInspector]   mem: set done");
                } else {
                    println!("[ForkInspector]   mem: SKIP — empty hex data for offset={offset}");
                }
            }

            self.next_patch_idx += 1;
        }

        // 2. 委托给内部 Cheatcodes 做正常的 trace 采集
        self.inner.step(interp, context);
        self.global_step += 1;
    }

    fn step_end(
        &mut self,
        interp: &mut revm::interpreter::Interpreter<revm::interpreter::interpreter::EthInterpreter>,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
    ) {
        self.inner.step_end(interp, context);
    }

    fn call(
        &mut self,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        inputs: &mut CallInputs,
    ) -> Option<CallOutcome> {
        self.inner.call(context, inputs)
    }

    fn call_end(
        &mut self,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        inputs: &CallInputs,
        outcome: &mut CallOutcome,
    ) {
        self.inner.call_end(context, inputs, outcome);
    }

    fn create(
        &mut self,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        inputs: &mut CreateInputs,
    ) -> Option<CreateOutcome> {
        self.inner.create(context, inputs)
    }

    fn create_end(
        &mut self,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        inputs: &CreateInputs,
        outcome: &mut CreateOutcome,
    ) {
        self.inner.create_end(context, inputs, outcome);
    }

    fn initialize_interp(
        &mut self,
        interp: &mut revm::interpreter::Interpreter<revm::interpreter::interpreter::EthInterpreter>,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
    ) {
        self.inner.initialize_interp(interp, context);
    }

    fn log_full(
        &mut self,
        interp: &mut revm::interpreter::Interpreter<revm::interpreter::interpreter::EthInterpreter>,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        log: Log,
    ) {
        self.inner.log_full(interp, context, log);
    }
}

/// 简易 hex → bytes 解码
fn hex_decode(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    (0..s.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}
