//! EVM Inspector 实现
//!
//! 在 revm 的 step / call / create 回调中采集 trace 数据，
//! 通过 MessageEncoder 发送给前端，并写入 DebugSession 供 seek_to 查询。

use crate::{
    op_trace::{
        frame_manager::{FrameInfo, FrameManager},
        tracer::memory_tracer::MemoryTracer,
        tracer::storage_tracer::StorageTracer,
        tracer::gas_tracer::GasTracer,
        tracer::log_tracer::LogTracer,
        // tracer::bytecode_tracer::BytecodeTracer,
    },
    optrace_journal::OpTraceJournal,
};
use revm::{
    bytecode::OpCode,
    context::{Cfg, ContextTr, LocalContextTr},
    context_interface::{Block, JournalTr, Transaction},
    interpreter::{interpreter::EthInterpreter, CallInputs, CallOutcome},
    primitives::{Address, Bytes, Log, StorageKey, StorageValue, U256},
    state::Bytecode,
    Context, Inspector, JournalEntry,
};
use revm_interpreter::{
    interpreter_types::{Jumps, MemoryTr},
    CallInput, CallScheme, CreateInputs, CreateOutcome, CreateScheme, 
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::debug_session::{DebugSession, FrameRecord, StorageChangeRecord, TraceStep};
use super::message_encoder::MessageEncoder;
use super::shadow::ShadowState;
use super::AlloyCacheDB;
use crate::op_trace::types::CallKind;

#[derive(Clone, Default)]
struct StepInfo {
    opcode: OpCode,
    pc: usize,
    // 所有context的step累计计数
    step_count: usize,
    /// 执行前内存大小，用于检测 MLOAD 等导致的静默内存扩张
    memory_len_before: usize,
}

pub(crate) trait CallInputExt {
    fn input_data<CTX: ContextTr>(&self, ctx: &mut CTX) -> Bytes;
}

impl CallInputExt for CallInputs {
    fn input_data<CTX: ContextTr>(&self, ctx: &mut CTX) -> Bytes {
        match &self.input {
            CallInput::SharedBuffer(range) => ctx
                .local()
                .shared_memory_buffer_slice(range.clone())
                .map(|slice| Bytes::copy_from_slice(&slice))
                .unwrap_or_default(),
            CallInput::Bytes(bytes) => bytes.clone(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Cheatcodes<BlockT, TxT, CfgT> {
    step_info: StepInfo,
    bytecode: Bytecode,
    // frame_id,每次创建新的frame就加1,用于识别当前是哪个frame
    // 存储所有frame的信息
    // frame_info_vec: Vec<FrameInfo>,
    // 消息编码器（负责 channel 发送）
    encoder: MessageEncoder,
    // 已处理过的 journal 条目总数，用于在 step_end 中只处理新增条目（去重）
    last_journal_total_entries: usize,
    // seek_to 用的持久存储
    debug_session: Arc<Mutex<DebugSession>>,
    /// 开关：开启后每步对比增量重建内存与实际全量内存
    verify_memory: bool,
    phantom: core::marker::PhantomData<(BlockT, TxT, CfgT)>,
    frame_manager: FrameManager,
    memory_tracer: MemoryTracer,
    storage_tracer: StorageTracer,
    gas_tracer: GasTracer,
    log_tracer: LogTracer,
    // bytecode_tracer: BytecodeTracer,
    shadow: ShadowState,
    shadow_temp_dir: PathBuf,
    shadow_enabled: bool,
}

impl<BlockT, TxT, CfgT> Cheatcodes<BlockT, TxT, CfgT> {
    pub(crate) fn new(
        encoder: MessageEncoder,
        debug_session: Arc<Mutex<DebugSession>>,
        shadow_temp_dir: PathBuf,
        shadow_enabled: bool,
    ) -> Self {
        Self {
            step_info: StepInfo::default(),
            bytecode: Bytecode::default(),
            encoder,
            last_journal_total_entries: 0,
            debug_session: debug_session.clone(),
            verify_memory: false,
            phantom: core::marker::PhantomData,
            frame_manager: FrameManager::new(debug_session),
            memory_tracer: MemoryTracer::new(),
            storage_tracer: StorageTracer::new(),
            gas_tracer: GasTracer::new(),
            log_tracer: LogTracer::new(),
            // bytecode_tracer: BytecodeTracer::new(),
            shadow: ShadowState::with_temp_dir(shadow_temp_dir.clone()),
            shadow_temp_dir,
            shadow_enabled,
        }
    }

    pub(crate) fn flush_steps(&mut self) {
        self.encoder.flush_steps();
    }

    pub(crate) fn _set_verify_memory(&mut self, enable: bool) {
        self.verify_memory = enable;
    }

    pub(crate) fn send_finished(&self) {
        self.encoder.send_finished();
    }

    /// 取出 ShadowState 用于存入 DebugSession
    pub(crate) fn take_shadow(&mut self) -> ShadowState {
        std::mem::replace(
            &mut self.shadow,
            ShadowState::with_temp_dir(self.shadow_temp_dir.clone()),
        )
    }

    pub(crate) fn send_balance_changes(&self, json: &str) {
        self.encoder.send_balance_changes(json);
    }

}

impl<BlockT, TxT, CfgT> Cheatcodes<BlockT, TxT, CfgT>
where
    BlockT: Block + Clone,
    TxT: Transaction + Clone,
    CfgT: Cfg + Clone,
{
    fn verify_memory(&self, interp: &revm::interpreter::Interpreter<EthInterpreter>) {
        let ctx_id = self.frame_manager.current_id();
        let frame_step = self.frame_manager.current_step_count() as u32;
        let actual_size = interp.memory.len();
        let actual_mem = interp.memory.slice(0..actual_size).to_vec();
        let session = self.debug_session.lock().unwrap();
        let rebuilt_mem = session.compute_memory_at_step(ctx_id, frame_step);
        if actual_mem != rebuilt_mem {
            eprintln!(
                    "[MEMORY MISMATCH] ctx_id={} current_step={} pc={} opcode=0x{:02x} actual_len={} rebuilt_len={}",
                    ctx_id, self.step_info.step_count, self.step_info.pc, self.step_info.opcode.get(), actual_mem.len(), rebuilt_mem.len()
                );
            // 打印前 64 字节差异
            let cmp_len = actual_mem.len().max(rebuilt_mem.len());
            let actual_hex: String = actual_mem
                .iter()
                .take(cmp_len)
                .map(|b| format!("{:02x}", b))
                .collect();
            let rebuilt_hex: String = rebuilt_mem
                .iter()
                .take(cmp_len)
                .map(|b| format!("{:02x}", b))
                .collect();
            eprintln!("  actual : {}", actual_hex);
            eprintln!("  rebuilt: {}", rebuilt_hex);
        }
    }

    fn send_frame_enter(&self) {
        if let Some(info) = self.frame_manager.current_frame() {
            self.encoder.send_frame_enter(info);
        }
    }

    fn send_frame_update_address(&self, address: Address) {
        self.encoder
            .send_frame_update_address(self.frame_manager.current_id(), address);
    }

    fn send_storage_change(
        &self,
        is_transient: bool,
        is_read: bool,
        frame_id: u16,
        step_index: usize,
        address: Address,
        key: StorageKey,
        old_value: StorageValue,
        new_value: StorageValue,
    ) {
        self.encoder.send_storage_change(
            is_transient,
            is_read,
            frame_id,
            step_index,
            address,
            key,
            old_value,
            new_value,
        );
    }

    fn send_frame_logs(&self, log: &Log) {
        let ctx_id = self.frame_manager.current_id();
        let log_step_index = self.log_tracer.get_log_step_index();
        self.encoder.send_logs(ctx_id, log_step_index, log);
    }

    /// 扫描 journal 中新增的条目，发送 Storage / TransientStorage 变迁消息。
    /// 使用游标 last_journal_total_entries 避免重复发送。
    fn process_journal_storage(
        &mut self,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
    ) {
        let step_idx = self.step_info.step_count;
        let frame_id = self.frame_manager.current_id();
        let journal_ref = context.journal().with_journaled_state();
        let mut flat_idx = 0usize;
        let mut new_changes: Vec<StorageChangeRecord> = Vec::new();

        for entry in journal_ref.journal.iter() {
            if flat_idx >= self.last_journal_total_entries {
                if let JournalEntry::StorageChanged {
                    address,
                    key,
                    had_value,
                } = entry
                {
                    let addr = Address::from_slice(address.as_slice());
                    let new_val = journal_ref
                        .state
                        .get(&addr)
                        .and_then(|acc| acc.storage.get(key))
                        .map(|s| s.present_value)
                        .unwrap_or_default();
                    self.send_storage_change(
                        false, false, frame_id, step_idx, addr, *key, *had_value, new_val,
                    );
                    new_changes.push(StorageTracer::create_change_record(
                        step_idx,
                        frame_id,
                        false,
                        false,
                        addr,
                        *key,
                        *had_value,
                        new_val,
                    ));
                }
                if let JournalEntry::TransientStorageChange {
                    address,
                    key,
                    had_value,
                } = entry
                {
                    let addr = Address::from_slice(address.as_slice());
                    let new_val = journal_ref
                        .transient_storage
                        .get(&(addr, *key))
                        .copied()
                        .unwrap_or_default();
                    self.send_storage_change(
                        true, false, frame_id, step_idx, addr, *key, *had_value, new_val,
                    );
                    new_changes.push(StorageTracer::create_change_record(
                        step_idx,
                        frame_id,
                        true,
                        false,
                        addr,
                        *key,
                        *had_value,
                        new_val,
                    ));
                }
            }
            flat_idx += 1;
        }
        self.last_journal_total_entries = flat_idx;

        if !new_changes.is_empty() {
            let mut session = self.debug_session.lock().unwrap();
            for change in new_changes {
                session.push_storage_change(change);
            }
        }
    }

    fn process_sstore_load(
        &mut self,
        _context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        stack_data: &[U256],
    ) {
        let opcode = self.step_info.opcode.as_usize();
        let step_idx = self.step_info.step_count;
        let frame_id = self.frame_manager.current_id();

        let zero = U256::from(0);
        if opcode == 0x54 || opcode == 0x5c {
            let storage_data = stack_data.last().unwrap_or(&zero);
            let address = self.frame_manager.current_target();
            let is_transient = opcode == 0x5c;
            let storage_key = self.storage_tracer.get_storage_key().unwrap_or_default();
            self.send_storage_change(
                is_transient,
                true,
                frame_id,
                step_idx,
                address,
                storage_key,
                zero,
                *storage_data,
            );
            self.debug_session
                .lock()
                .unwrap()
                .push_storage_change(StorageTracer::create_change_record(
                    step_idx,
                    frame_id,
                    is_transient,
                    true,
                    address,
                    storage_key,
                    zero,
                    *storage_data,
                ));
        }
    }

    fn update_frame_bytecode(&mut self, depth: u16, _context_id: u16, bytecode: &Bytes) {
        // if self.bytecode_tracer.has_bytecode_changed(bytecode) {
        //     self.bytecode_tracer.update_bytecode_hash(bytecode);
        self.encoder
            .send_contract_source(depth, self.frame_manager.current_id(), bytecode);
        // }
    }
}

impl<BlockT, TxT, CfgT>
    Inspector<Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>>
    for Cheatcodes<BlockT, TxT, CfgT>
where
    BlockT: Block + Clone,
    TxT: Transaction + Clone,
    CfgT: Cfg + Clone,
{
    // step的时候,pc指向当前待执行的opcode
    // step_end的时候,pc指向当前下一个opcode了
    // 所以大部分操作要在step中获取记录,在step_end中获取执行结果
    // 例如stack、memory要在step中获取,如果是step_end,此时是执行完的状态,已经不对了.
    fn step(
        &mut self,
        interp: &mut revm::interpreter::Interpreter<EthInterpreter>,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
    ) {
        let opcode = interp.bytecode.opcode();
        let op = OpCode::new(opcode).unwrap();

        self.step_info.pc = interp.bytecode.pc();
        self.step_info.opcode = op;
        self.gas_tracer.record_gas_before(interp.gas.remaining());
        self.step_info.memory_len_before = interp.memory.len();
        let depth = context.journaled_state.depth();

        self.memory_tracer
            .record_opcode_args(op, interp.stack.data());

        self.storage_tracer
            .record_storage_key(op, interp.stack.data());

        let frame_step_count = self.frame_manager.current_step_count();
        self.encoder.pack_step(
            self.step_info.pc as u64,
            opcode,
            self.frame_manager.current_id(),
            depth as u16,
            self.gas_tracer.get_gas_remaining_before(),
            interp.stack.data(),
            frame_step_count,
        );

        // 并行存储到 DebugSession，供 seek_to 使用
        let frame_step = frame_step_count as u32;
        let ctx_id = self.frame_manager.current_id();
        {
            let mut session = self.debug_session.lock().unwrap();
            session.push_step(TraceStep {
                context_id: ctx_id,
                frame_step,
                pc: self.step_info.pc as u32,
                opcode,
                gas_cost: 0, // step_end 中回填
                gas_remaining: self.gas_tracer.get_gas_remaining_before(),
                stack: interp.stack.data().to_vec(),
                contract_address: self.frame_manager.current_address(),
                call_target: self.frame_manager.current_target(),
            });
            // 全量内存快照（每 50 步一次）
            if frame_step % 50 == 0 {
                let size = interp.memory.len();
                let data = interp.memory.slice(0..size).to_vec();
                session.push_snapshot(ctx_id, frame_step, data);
            }
        }

        self.frame_manager.current_increment_step_count();
        // flush 移到 step_end，确保 gas_cost 回填后再发送
        // 记录当前 step 计数供 LogTracer 使用
        self.log_tracer.record_current_step_count(self.step_info.step_count);

        // 数据流追踪：影子栈/内存/存储
        if self.shadow_enabled {
            self.shadow.on_step(
                opcode,
                self.step_info.pc,
                self.step_info.step_count,
                interp.stack.data(),
                self.frame_manager.current_target(),
                self.frame_manager.current_id(),
            );
        }

        self.step_info.step_count += 1;
    }

    fn step_end(
        &mut self,
        interp: &mut revm::interpreter::Interpreter<EthInterpreter>,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
    ) {
        let finished_step = self.step_info.step_count.saturating_sub(1) as u32;
        if self.shadow_enabled {
            self.shadow
                .record_step_end_stack(finished_step, interp.stack.data());
        }

        self.gas_tracer.backfill_gas_cost(interp);

        // 回填 DebugSession 中最后一步的 gas_cost
        {
            let mut session = self.debug_session.lock().unwrap();
            if let Some(last) = session.trace.last_mut() {
                last.gas_cost = self.gas_tracer.get_gas_cost();
            }
        }
        // 发送此步的 gas_cost 给前端
        self.encoder.backfill_gas_cost(self.gas_tracer.get_gas_cost());

        self.process_journal_storage(context);
        // 只在 SLOAD/TLOAD 时才需要读栈顶，避免每步都做 Vec 堆分配
        let op = self.step_info.opcode.as_usize();
        if op == 0x54 || op == 0x5c {
            self.process_sstore_load(context, interp.stack.data());
        }

        // 增量内存变更处理
        if let Some(ret_info) = self.memory_tracer.dispatch_update(
            self.step_info.opcode,
            interp,
            self.frame_manager.current_id(),
            self.frame_manager.current_step_count(),
            &self.debug_session,
            &self.encoder,
            self.step_info.memory_len_before,
        ) {
            // 处理 RETURN/REVERT 写入父帧的逻辑
            let frame_len = self.frame_manager.frame_stack_len();
            if frame_len >= 2 {
                let ret_offset = self.frame_manager.current_ret_memory_offset();
                let ret_size = self.frame_manager.current_ret_memory_size();
                if ret_size > 0 {
                    let write_size = ret_info.data.len().min(ret_size);
                    let write_data = ret_info.data[..write_size].to_vec();
                    let parent_ctx = self.frame_manager.parent_id();
                    let parent_step = self.frame_manager.parent_step_count() as u32;
                    self.debug_session.lock().unwrap().push_patch(
                        parent_ctx,
                        parent_step,
                        ret_offset as u32,
                        write_data,
                    );
                }
            }
        }

        // 内存校验：对比增量重建 vs 实际全量内存
        if self.verify_memory {
            self.verify_memory(interp);
        }
    }

    fn call(
        &mut self,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        inputs: &mut CallInputs,
    ) -> Option<CallOutcome> {
        let frame_id = self.frame_manager.allocate_frame_id();

        let (from, to) = match inputs.scheme {
            CallScheme::DelegateCall | CallScheme::CallCode => {
                (inputs.target_address, inputs.bytecode_address)
            }
            _ => (inputs.caller, inputs.target_address),
        };

        let value = if matches!(inputs.scheme, CallScheme::DelegateCall) {
            if let Some(parent) = self.frame_manager.current_frame() {
                parent.value
            } else {
                inputs.call_value()
            }
        } else {
            inputs.call_value()
        };

        let input = inputs.input_data(context);
        let ret_memory_offset = inputs.return_memory_offset.start;
        let ret_memory_size = inputs.return_memory_offset.len();
        self.frame_manager.push_frame(FrameInfo {
            parent_id: self.frame_manager.current_id(),
            depth: context.journaled_state.depth() as u16,
            frame_id,
            address: inputs.bytecode_address,
            step_count: 0,
            value: value,
            success: false,
            caller: from,
            target_address: inputs.target_address,
            selfdestruct_refund_target: None,
            selfdestruct_transferred_value: None,
            kind: match inputs.scheme {
                CallScheme::Call => CallKind::Call,
                CallScheme::StaticCall => CallKind::StaticCall,
                CallScheme::CallCode => CallKind::CallCode,
                CallScheme::DelegateCall => CallKind::DelegateCall,
                _ => {
                    CallKind::Call
                },
            },
            gas_used: 0,
            gas_limit: inputs.gas_limit,
            input: input,
            status: None,
            output: Bytes::new(),
            ret_memory_offset,
            ret_memory_size,
        });

        self.debug_session
            .lock()
            .unwrap()
            .push_frame_record(FrameRecord {
                frame_id: self.frame_manager.current_id(),
                parent_id: self.frame_manager.parent_id(),
                depth: self.frame_manager.current_depth(),
                address: self.frame_manager.current_address(),
                caller: self.frame_manager.current_caller(),
                target_address: self.frame_manager.current_target(),
                kind: format!("{:?}", self.frame_manager.current_kind()),
                gas_limit: self.frame_manager.current_gas_limit(),
                gas_used: 0,
                step_count: 0,
                success: false,
            });
        self.send_frame_enter();
        // shadow: 推入新帧
        let input_len = self.frame_manager.current_frame().map(|f| f.input.len()).unwrap_or(0);
        if self.shadow_enabled {
            self.shadow.push_frame(input_len);
        }
        None
    }

    fn call_end(
        &mut self,
        _: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        _inputs: &CallInputs,
        _outcome: &mut CallOutcome,
    ) {
        self.frame_manager
            .current_update_outcome(_outcome.result.output.clone(), _outcome.result.gas.spent());
        self.frame_manager
            .current_update_status(_outcome.result.clone());
        let frame_id = self.frame_manager.current_id();
        let result = _outcome.result.result;
        let success = self.frame_manager.current_is_success();
        let gas_used = _outcome.result.gas.spent();
        let output = self.frame_manager.current_output().clone();
        let frame_step_count = self.frame_manager.current_step_count();

        self.debug_session.lock().unwrap().finalize_frame(
            frame_id,
            gas_used,
            success,
            frame_step_count,
        );

        // Precompile 调用不会执行 RETURN/REVERT opcode，需要在此补一个父 frame 内存 patch
        // EVM 规范：is_ok_or_revert() 时将返回数据写入父 frame [retOffset, retOffset+min(retSize, outputLen))
        let is_precompile = {
            let b = _inputs.bytecode_address.as_slice();
            b[..19].iter().all(|&x| x == 0) && b[19] > 0 && b[19] < 0x20
        };
        let ret_mem_start = _inputs.return_memory_offset.start;
        let ret_mem_size = _inputs.return_memory_offset.len();
        if is_precompile && ret_mem_size > 0 && !output.is_empty() {
            let write_size = output.len().min(ret_mem_size);
            let write_data = output[..write_size].to_vec();
            let frame_len = self.frame_manager.frame_stack_len();
            if frame_len >= 2 {
                let parent_ctx = self.frame_manager.parent_id();
                let parent_step = self.frame_manager.parent_step_count() as u32;
                self.debug_session.lock().unwrap().push_patch(
                    parent_ctx,
                    parent_step,
                    ret_mem_start as u32,
                    write_data,
                );
            }
        }

        self.flush_steps();
        // shadow: 弹出子帧，写入返回数据影子到父帧内存
        let ret_mem_offset = _inputs.return_memory_offset.start;
        let ret_mem_len = _inputs.return_memory_offset.len();
        let output_len_for_shadow = output.len();
        if self.shadow_enabled {
            self.shadow.pop_frame(ret_mem_offset, ret_mem_len, output_len_for_shadow);
        }
        self.encoder
            .send_frame_exit(frame_id, result, success, gas_used, &output);
        self.frame_manager.pop_frame();
    }

    fn create(
        &mut self,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        inputs: &mut CreateInputs,
    ) -> Option<CreateOutcome> {
        let frame_id = self.frame_manager.allocate_frame_id();
        let nonce = context
            .journal_mut()
            .load_account(inputs.caller())
            .ok()?
            .info
            .nonce;
        self.frame_manager.push_frame(FrameInfo {
            parent_id: self.frame_manager.current_id(),
            depth: context.journaled_state.depth() as u16,
            frame_id,
            address: inputs.created_address(nonce),
            step_count: 0,
            value: U256::from(0),
            success: false,
            caller: inputs.caller(),
            target_address: Address::ZERO,
            selfdestruct_refund_target: None,
            selfdestruct_transferred_value: None,
            kind: match inputs.scheme() {
                CreateScheme::Create => CallKind::Create,
                CreateScheme::Create2 { salt: _ } => CallKind::Create2,
                _ => CallKind::Create,
            },
            gas_used: 0,
            gas_limit: inputs.gas_limit(),
            input: inputs.init_code().clone(),
            status: None,
            output: Bytes::new(),
            ret_memory_offset: 0,
            ret_memory_size: 0,
        });

        self.debug_session
            .lock()
            .unwrap()
            .push_frame_record(FrameRecord {
                frame_id: self.frame_manager.current_id(),
                parent_id: self.frame_manager.parent_id(),
                depth: self.frame_manager.current_depth(),
                address: self.frame_manager.current_address(),
                caller: self.frame_manager.current_caller(),
                target_address: self.frame_manager.current_target(),
                kind: format!("{:?}", self.frame_manager.current_kind()),
                gas_limit: self.frame_manager.current_gas_limit(),
                gas_used: 0,
                step_count: 0,
                success: false,
            });
        self.send_frame_enter();
        // shadow: 推入新帧（CREATE 的 calldata 来自 init_code）
        let init_code_len = self.frame_manager.current_frame().map(|f| f.input.len()).unwrap_or(0);
        if self.shadow_enabled {
            self.shadow.push_frame(init_code_len);
        }
        None
    }

    fn create_end(
        &mut self,
        _: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        _inputs: &CreateInputs,
        _outcome: &mut CreateOutcome,
    ) {
        self.frame_manager
            .current_update_status(_outcome.result.clone());
        self.frame_manager
            .current_update_outcome(_outcome.result.output.clone(), _outcome.result.gas.spent());
        self.frame_manager
            .current_update_status(_outcome.result.clone());
        let frame_id = self.frame_manager.current_id();
        let result = _outcome.result.result;
        let success = self.frame_manager.current_is_success();
        let gas_used = _outcome.result.gas.spent();
        let output = self.frame_manager.current_output();
        let frame_step_count = self.frame_manager.current_step_count();

        self.debug_session.lock().unwrap().finalize_frame(
            frame_id,
            gas_used,
            success,
            frame_step_count,
        );

        let deployed_addr = _outcome.address.unwrap_or(Address::ZERO);
        self.send_frame_update_address(deployed_addr);
        self.flush_steps();
        // shadow: 弹出子帧（CREATE 没有 retOffset/retSize 写入父帧）
        if self.shadow_enabled {
            self.shadow.pop_frame(0, 0, output.len());
        }
        self.encoder
            .send_frame_exit(frame_id, result, success, gas_used, &output);
        self.frame_manager.pop_frame();
    }

    fn initialize_interp(
        &mut self,
        interp: &mut revm::interpreter::Interpreter<EthInterpreter>,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
    ) {
        self.update_frame_bytecode(
            context.journaled_state.depth() as u16,
            self.frame_manager.current_id(),
            &interp.bytecode.bytes(),
        );
        self.bytecode = interp.bytecode.clone();
    }

    fn log_full(
        &mut self,
        _: &mut revm::interpreter::Interpreter<EthInterpreter>,
        _: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        log: Log,
    ) {
        self.send_frame_logs(&log);
    }

    fn selfdestruct(&mut self, contract: Address, target: Address, value: U256) {
        if let Some(info) = self.frame_manager.current_frame_mut() {
            info.selfdestruct_refund_target = Some(target);
            info.selfdestruct_transferred_value = Some(value);
        }
        // 通过 encoder 发送 selfdestruct 事件，附在 FrameExit 之前
        self.encoder
            .send_selfdestruct(self.frame_manager.current_id(), contract, target, value);
    }
}
