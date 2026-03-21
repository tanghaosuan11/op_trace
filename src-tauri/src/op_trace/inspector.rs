//! EVM Inspector 实现
//!
//! 在 revm 的 step / call / create 回调中采集 trace 数据，
//! 通过 MessageEncoder 发送给前端，并写入 DebugSession 供 seek_to 查询。

use crate::optrace_journal::OpTraceJournal;
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
    CallInput, CallScheme, CreateInputs, CreateOutcome, CreateScheme,
    InterpreterResult,
    interpreter_types::{Jumps, MemoryTr},
};
use std::sync::{Arc, Mutex};

use super::debug_session::{DebugSession, TraceStep};
use super::message_encoder::MessageEncoder;
use super::AlloyCacheDB;


#[derive(Clone, Default)]
struct StepInfo {
    opcode: OpCode,
    pc: usize,
    // 所有context的step累计计数
    step_count: usize,
    // memory相关的临时变量，记录在 step 里，等 step_end 的时候发送给前端
    // src 不一定是内存,可能是 calldata 或 code，所以命名为 src_data_offset
    src_data_offset: usize,
    dst_memory_offset: usize,
    memory_size: usize,
    /// 执行前内存大小，用于检测 MLOAD 等导致的静默内存扩张
    memory_len_before: usize,
    stack: Vec<U256>,
    gas_remaining_before: u64,
    gas_remaining_after: u64,
    gas_cost: u64,
    storage_key: Option<StorageKey>,
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub enum CallKind {
    #[default]
    Call,
    StaticCall,
    CallCode,
    DelegateCall,
    AuthCall,
    Create,
    Create2,
}

#[derive(Clone, Default, serde::Serialize)]
struct FrameInfo {
    parent_id: u16,
    depth: u16,
    frame_id: u16,
    address: Address,
    // 该frame的累计step数
    step_count: usize,
    value: U256,
    caller: Address,
    target_address: Address,
    selfdestruct_refund_target: Option<Address>,
    selfdestruct_transferred_value: Option<U256>,
    kind: CallKind,
    gas_used: u64,
    gas_limit: u64,
    input: Bytes,
    status: Option<InterpreterResult>,
    success: bool,
    output: Bytes,
    /// CALL 指令的 retOffset（父 frame 内存写入起始位置）
    ret_memory_offset: usize,
    /// CALL 指令的 retSize（父 frame 内存最大写入长度）
    ret_memory_size: usize,
}


#[derive(Clone)]
pub(crate) struct Cheatcodes<BlockT, TxT, CfgT> {
    step_info: StepInfo,
    bytecode: Bytecode,
    // frame_id,每次创建新的frame就加1,用于识别当前是哪个frame
    frame_count: u16,
    // 存储所有frame的信息
    frame_info_vec: Vec<FrameInfo>,
    // 消息编码器（负责 channel 发送）
    encoder: MessageEncoder,
    // 已处理过的 journal 条目总数，用于在 step_end 中只处理新增条目（去重）
    last_journal_total_entries: usize,
    // seek_to 用的持久存储
    debug_session: Arc<Mutex<DebugSession>>,
    /// 开关：开启后每步对比增量重建内存与实际全量内存
    verify_memory: bool,
    phantom: core::marker::PhantomData<(BlockT, TxT, CfgT)>,
}

impl<BlockT, TxT, CfgT> Cheatcodes<BlockT, TxT, CfgT> {
    pub(crate) fn new(encoder: MessageEncoder, debug_session: Arc<Mutex<DebugSession>>) -> Self {
        Self {
            step_info: StepInfo::default(),
            bytecode: Bytecode::default(),
            frame_info_vec: Vec::new(),
            frame_count: 0,
            encoder,
            last_journal_total_entries: 0,
            debug_session,
            verify_memory: false,
            phantom: core::marker::PhantomData,
        }
    }

    pub(crate) fn flush_steps(&mut self) {
        self.encoder.flush_steps();
    }

    pub(crate) fn set_verify_memory(&mut self, enable: bool) {
        self.verify_memory = enable;
    }

    pub(crate) fn send_finished(&self) {
        self.encoder.send_finished();
    }

    pub(crate) fn send_balance_changes(&self, json: &str) {
        self.encoder.send_balance_changes(json);
    }

    fn frame_current_id(&self) -> u16 {
        self.frame_info_vec.last().map(|f| f.frame_id).unwrap_or(1)
    }

    fn frame_address(&self) -> Address {
        let default_address = Address::ZERO;
        self.frame_info_vec
            .last()
            .map(|f| f.address)
            .unwrap_or(default_address)
    }

    fn frame_call_target(&self) -> Address {
        // target_address in FrameInfo stores the CALL target (inputs.target_address)
        self.frame_info_vec
            .last()
            .map(|f| f.target_address)
            .unwrap_or(Address::ZERO)
    }

    fn frame_step_count(&self) -> usize {
        self.frame_info_vec
            .last()
            .map(|f| f.step_count)
            .unwrap_or(0)
    }

    /// 每 50 步全量抓一次内存，其余返回空快照。
    fn collect_memory_snapshot(
        &self,
        interp: &revm::interpreter::Interpreter<EthInterpreter>,
    ) -> (bool, usize, Vec<u8>) {
        let frame_step = self.frame_step_count();
        if frame_step % 50 == 0 {
            let size = interp.memory.len();
            let data = interp.memory.slice(0..size).to_vec();
            (true, 0, data)
        } else {
            (false, 0, Vec::new())
        }
    }
}

impl<BlockT, TxT, CfgT> Cheatcodes<BlockT, TxT, CfgT>
where
    BlockT: Block + Clone,
    TxT: Transaction + Clone,
    CfgT: Cfg + Clone,
{
    /// 根据 opcode 将内存参数（dst_offset / src_offset / size）写入 step_info，
    /// 以便 step_end 中读取并发送增量内存更新。
    fn record_opcode_args(&mut self, opcode: u8, stack_data: &[U256]) {
        match opcode {
            0x51 => {
                // MLOAD [offset]
                self.step_info.dst_memory_offset =
                    usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.step_info.memory_size = 32;
            }
            0x52 => {
                // MSTORE [offset, value]
                self.step_info.dst_memory_offset =
                    usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.step_info.memory_size = 32;
            }
            0x53 => {
                // MSTORE8 [offset, value]
                self.step_info.dst_memory_offset =
                    usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.step_info.memory_size = 1;
            }
            0x5e => {
                // MCOPY [dst, src, size]
                self.step_info.dst_memory_offset =
                    usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.step_info.src_data_offset =
                    usize::try_from(stack_data[stack_data.len() - 2]).unwrap();
                self.step_info.memory_size =
                    usize::try_from(stack_data[stack_data.len() - 3]).unwrap();
            }
            0x37 | 0x39 | 0x3e => {
                // CALLDATACOPY / CODECOPY / RETURNDATACOPY [dst, src, size]
                self.step_info.dst_memory_offset =
                    usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.step_info.src_data_offset =
                    usize::try_from(stack_data[stack_data.len() - 2]).unwrap();
                self.step_info.memory_size =
                    usize::try_from(stack_data[stack_data.len() - 3]).unwrap();
            }
            0x3c => {
                // EXTCODECOPY [addr, dst, src, size]
                self.step_info.dst_memory_offset =
                    usize::try_from(stack_data[stack_data.len() - 2]).unwrap();
                self.step_info.src_data_offset =
                    usize::try_from(stack_data[stack_data.len() - 3]).unwrap();
                self.step_info.memory_size =
                    usize::try_from(stack_data[stack_data.len() - 4]).unwrap();
            }
            0xf3 | 0xfd => {
                // RETURN / REVERT [offset, size]
                self.step_info.dst_memory_offset =
                    usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.step_info.memory_size =
                    usize::try_from(stack_data[stack_data.len() - 2]).unwrap();
            }
            0x54 | 0x5c =>{
                // SLOAD / TLOAD [key]
                let key = StorageKey::from(stack_data[stack_data.len() - 1]);
                self.step_info.storage_key = Some(key);
            }
            _ => {}
        }
    }

    fn send_frame_enter(&self) {
        if let Some(info) = self.frame_info_vec.last() {
            self.encoder.send_frame_enter(info);
        }
    }

    fn send_frame_update_address(&self, address: Address) {
        self.encoder
            .send_frame_update_address(self.frame_current_id(), address);
    }

    fn send_memory_update(&self, dst_offset: u32, memory: &[u8]) {
        self.encoder.send_memory_update(
            self.frame_current_id(),
            self.frame_step_count(),
            dst_offset,
            memory,
        );
    }

    fn send_frame_result(&self, return_data: &[u8]) {
        self.encoder.send_return_data(
            self.frame_current_id(),
            self.step_info.step_count,
            return_data,
        );
    }

    fn send_storage_change(
        &self,
        is_transient: bool,
        is_read:bool,
        frame_id: u16,
        step_index: usize,
        address: Address,
        key: StorageKey,
        old_value: StorageValue,
        new_value: StorageValue,
    ) {
        self.encoder.send_storage_change(
            is_transient, is_read, frame_id, step_index, address, key, old_value, new_value,
        );
    }

    fn send_frame_logs(&self, log: &Log) {
        let ctx_id = self.frame_current_id();
        // step_count 在 step() 末尾已经 +1，所以这里要 -1 来得到产生 log 的那一步的索引
        let log_step_index = self.step_info.step_count.saturating_sub(1);
        self.encoder.send_logs(ctx_id, log_step_index, log);
    }

    /// 计算本步 gas 消耗，回填到 step_payload 中的占位字段，并在达到阈值时批量发送。
    fn backfill_gas_cost(&mut self, interp: &revm::interpreter::Interpreter<EthInterpreter>) {
        self.step_info.gas_remaining_after = interp.gas.remaining();
        self.step_info.gas_cost = self
            .step_info
            .gas_remaining_before
            .saturating_sub(self.step_info.gas_remaining_after);
        self.encoder.backfill_gas_cost(self.step_info.gas_cost);
    }

    /// 扫描 journal 中新增的条目，发送 Storage / TransientStorage 变迁消息。
    /// 使用游标 last_journal_total_entries 避免重复发送。
    fn process_journal_storage(
        &mut self,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
    ) {
        let step_idx = self.step_info.step_count;
        let frame_id = self.frame_current_id();
        let journal_ref = context.journal().with_journaled_state();
        let mut flat_idx = 0usize;

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
                        false, false,frame_id, step_idx, addr, *key, *had_value, new_val,
                    );
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
                }
            }
            flat_idx += 1;
        }
        self.last_journal_total_entries = flat_idx;
    }

    fn process_sstore_load(
        &mut self,
        _context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        stack_data: &[U256],
    ) {
        let opcode = self.step_info.opcode.as_usize();
        let step_idx = self.step_info.step_count;
        let frame_id = self.frame_current_id();

        let zero = U256::from(0);
        if opcode == 0x54 || opcode == 0x5c {
            let storage_data = stack_data.last().unwrap_or(&zero);
            let address = self.frame_call_target();
            let is_transient = opcode == 0x5c;
            let storage_key = self.step_info.storage_key.unwrap_or_default();
            self.send_storage_change(
                is_transient, false, frame_id, step_idx, address, storage_key, zero, *storage_data,
            );
        }
    }

    /// 根据当前 opcode 读取 step_info 中预记录的参数，
    /// 发送执行后的增量内存更新或 RETURN/REVERT 的返回数据。
    fn dispatch_memory_update(
        &mut self,
        interp: &mut revm::interpreter::Interpreter<EthInterpreter>,
    ) {
        let ctx_id = self.frame_current_id();
        let frame_step =
            self.frame_info_vec
                .last()
                .map(|f| f.step_count)
                .unwrap_or(0) as u32;

        match self.step_info.opcode.as_usize() {
            0x51 => {
                // MLOAD - 读取不写入，但可能引起内存静默扩张（填零）
                let offset = self.step_info.dst_memory_offset;
                let old_size = self.step_info.memory_len_before;
                if offset + 32 > old_size {
                    // 内存发生了扩张，记录新增的零字节区域（revm 已保证 word 对齐）
                    let new_size = interp.memory.len();
                    if new_size > old_size {
                        let expand_data = vec![0u8; new_size - old_size];
                        self.debug_session
                            .lock()
                            .unwrap()
                            .push_patch(ctx_id, frame_step, old_size as u32, expand_data);
                    }
                }
            }
            0x52 | 0x53 | 0x5e => {
                // MSTORE / MSTORE8 / MCOPY
                let dst_offset = self.step_info.dst_memory_offset;
                let size = self.step_info.memory_size;
                if size == 0 {
                    return;
                }
                let data = interp.memory.slice(dst_offset..dst_offset + size).to_vec();
                // 存储 patch 到 DebugSession（供 seek_to 重建内存），不再发前端
                self.debug_session
                    .lock()
                    .unwrap()
                    .push_patch(ctx_id, frame_step, dst_offset as u32, data);
            }
            0x37 | 0x39 | 0x3c | 0x3e => {
                // CALLDATACOPY / CODECOPY / EXTCODECOPY / RETURNDATACOPY
                let dst_offset = self.step_info.dst_memory_offset;
                let size = self.step_info.memory_size;
                if size == 0 {
                    return;
                }
                let data = interp.memory.slice(dst_offset..dst_offset + size).to_vec();
                // 存储 patch 到 DebugSession（供 seek_to 重建内存），不再发前端
                self.debug_session
                    .lock()
                    .unwrap()
                    .push_patch(ctx_id, frame_step, dst_offset as u32, data);
            }
            0xf3 | 0xfd => {
                // RETURN / REVERT
                // EVM 规范：两者都会将返回数据写入父 frame 的 retOffset 区域
                let offset = self.step_info.dst_memory_offset;
                let size = self.step_info.memory_size;
                if size > 0 {
                    let data = interp.memory.slice(offset..offset + size).to_vec();
                    self.send_frame_result(&data);

                    // 将返回值写入父 frame 内存的 [retOffset, retOffset+min(retSize, size))
                    let frame_len = self.frame_info_vec.len();
                    if frame_len >= 2 {
                        let cur = &self.frame_info_vec[frame_len - 1];
                        let ret_offset = cur.ret_memory_offset;
                        let ret_size   = cur.ret_memory_size;
                        if ret_size > 0 {
                            let write_size = size.min(ret_size);
                            let write_data = interp.memory.slice(offset..offset + write_size).to_vec();
                            let parent = &self.frame_info_vec[frame_len - 2];
                            let parent_ctx  = parent.frame_id;
                            let parent_step = parent.step_count as u32;
                            self.debug_session
                                .lock()
                                .unwrap()
                                .push_patch(parent_ctx, parent_step, ret_offset as u32, write_data);
                        }
                    }
                }
            }
            0x20 | 0xf1 | 0xf2 | 0xf4 | 0xfa => {
                // KECCAK256 / CALL / CALLCODE / DELEGATECALL / STATICCALL
                // 这些指令的 args/ret 区域可能触发内存静默扩张（只填零）
                let old_size = self.step_info.memory_len_before;
                let new_size = interp.memory.len();
                if new_size > old_size {
                    let expand_data = vec![0u8; new_size - old_size];
                    self.debug_session
                        .lock()
                        .unwrap()
                        .push_patch(ctx_id, frame_step, old_size as u32, expand_data);
                }
            }
            _ => {}
        }
    }

    fn update_frame_bytecode(&self, depth: u16, _context_id: u16, bytecode: &Bytes) {
        self.encoder
            .send_contract_source(depth, self.frame_current_id(), bytecode);
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
        self.step_info.gas_remaining_before = interp.gas.remaining();
        self.step_info.memory_len_before = interp.memory.len();
        let depth = context.journaled_state.depth();

        self.record_opcode_args(opcode, interp.stack.data());

        let frame_step_count = self.frame_step_count();
        self.encoder.pack_step(
            self.step_info.pc as u64,
            opcode,
            self.frame_current_id(),
            depth as u16,
            self.step_info.gas_remaining_before,
            interp.stack.data(),
            frame_step_count,
        );

        // 并行存储到 DebugSession，供 seek_to 使用
        let frame_step = frame_step_count as u32;
        let ctx_id = self.frame_current_id();
        {
            let mut session = self.debug_session.lock().unwrap();
            session.push_step(TraceStep {
                context_id: ctx_id,
                frame_step,
                pc: self.step_info.pc as u32,
                opcode,
                gas_cost: 0, // step_end 中回填
                gas_remaining: self.step_info.gas_remaining_before,
                stack: interp.stack.data().to_vec(),
                contract_address: self.frame_address(),
                call_target: self.frame_call_target(),
            });
            // 全量内存快照（每 50 步一次）
            if frame_step % 50 == 0 {
                let size = interp.memory.len();
                let data = interp.memory.slice(0..size).to_vec();
                session.push_snapshot(ctx_id, frame_step, data);
            }
        }

        (*self.frame_info_vec.last_mut().unwrap()).step_count += 1;
        // flush 移到 step_end，确保 gas_cost 回填后再发送

        self.step_info.step_count += 1;
    }

    fn step_end(
        &mut self,
        interp: &mut revm::interpreter::Interpreter<EthInterpreter>,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
    ) {
        self.backfill_gas_cost(interp);

        // 回填 DebugSession 中最后一步的 gas_cost
        {
            let mut session = self.debug_session.lock().unwrap();
            if let Some(last) = session.trace.last_mut() {
                last.gas_cost = self.step_info.gas_cost;
            }
        }

        self.process_journal_storage(context);
        // 只在 SLOAD/TLOAD 时才需要读栈顶，避免每步都做 Vec 堆分配
        let op = self.step_info.opcode.as_usize();
        if op == 0x54 || op == 0x5c {
            self.process_sstore_load(context, interp.stack.data());
        }
        self.dispatch_memory_update(interp);

        // 内存校验：对比增量重建 vs 实际全量内存
        if self.verify_memory {
            let ctx_id = self.frame_current_id();
            let frame_step = self.frame_info_vec.last().map(|f| f.step_count).unwrap_or(0) as u32;
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
                let actual_hex: String = actual_mem.iter().take(cmp_len).map(|b| format!("{:02x}", b)).collect();
                let rebuilt_hex: String = rebuilt_mem.iter().take(cmp_len).map(|b| format!("{:02x}", b)).collect();
                eprintln!("  actual : {}", actual_hex);
                eprintln!("  rebuilt: {}", rebuilt_hex);
            }
        }
    }

    fn call(
        &mut self,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        inputs: &mut CallInputs,
    ) -> Option<CallOutcome> {
        self.frame_count += 1;

        let (from, to) = match inputs.scheme {
            CallScheme::DelegateCall | CallScheme::CallCode => {
                (inputs.target_address, inputs.bytecode_address)
            }
            _ => (inputs.caller, inputs.target_address),
        };

        let value = if matches!(inputs.scheme, CallScheme::DelegateCall) {
            if let Some(parent) = self.frame_info_vec.last() {
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
        self.frame_info_vec.push(FrameInfo {
            
            parent_id: self.frame_info_vec.last().map(|f| f.frame_id).unwrap_or(0),
            depth: context.journaled_state.depth() as u16,
            frame_id: self.frame_count as u16,
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
                _ => CallKind::Call,
            },
            gas_used: 0,
            gas_limit: inputs.gas_limit,
            input: input,
            status: None,
            output: Bytes::new(),
            ret_memory_offset,
            ret_memory_size,
        });
        self.send_frame_enter();
        None
    }

    fn call_end(
        &mut self,
        _: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        _inputs: &CallInputs,
        _outcome: &mut CallOutcome,
    ) {
        let last_frame = self.frame_info_vec.last_mut().unwrap();
        last_frame.status = Some(_outcome.result.clone());
        last_frame.success = last_frame
            .status
            .as_ref()
            .is_some_and(|status| status.is_ok());
        last_frame.output = _outcome.result.output.clone();
        let frame_id = last_frame.frame_id;
        let result = _outcome.result.result;
        let success = last_frame.success;
        let gas_used = _outcome.result.gas.spent();
        let output = last_frame.output.clone();
        // last_frame borrow ends here

        // Precompile 调用不会执行 RETURN/REVERT opcode，需要在此补一个父 frame 内存 patch
        // EVM 规范：is_ok_or_revert() 时将返回数据写入父 frame [retOffset, retOffset+min(retSize, outputLen))
        let is_precompile = {
            let b = _inputs.bytecode_address.as_slice();
            b[..19].iter().all(|&x| x == 0) && b[19] > 0 && b[19] < 0x20
        };
        let ret_mem_start = _inputs.return_memory_offset.start;
        let ret_mem_size  = _inputs.return_memory_offset.len();
        if is_precompile && ret_mem_size > 0 && !output.is_empty() {
            let write_size = output.len().min(ret_mem_size);
            let write_data = output[..write_size].to_vec();
            let frame_len = self.frame_info_vec.len();
            if frame_len >= 2 {
                let parent = &self.frame_info_vec[frame_len - 2];
                let parent_ctx  = parent.frame_id;
                let parent_step = parent.step_count as u32;
                self.debug_session
                    .lock()
                    .unwrap()
                    .push_patch(parent_ctx, parent_step, ret_mem_start as u32, write_data);
            }
        }

        self.flush_steps();
        self.encoder
            .send_frame_exit(frame_id, result, success, gas_used, &output);
        self.frame_info_vec.pop();
    }

    fn create(
        &mut self,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        inputs: &mut CreateInputs,
    ) -> Option<CreateOutcome> {
        self.frame_count += 1;
        let nonce = context
            .journal_mut()
            .load_account(inputs.caller())
            .ok()?
            .info
            .nonce;
        self.frame_info_vec.push(FrameInfo {
            parent_id: self.frame_info_vec.last().map(|f| f.frame_id).unwrap_or(0),
            depth: context.journaled_state.depth() as u16,
            frame_id: self.frame_count as u16,
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
        self.send_frame_enter();
        None
    }

    fn create_end(
        &mut self,
        _: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
        _inputs: &CreateInputs,
        _outcome: &mut CreateOutcome,
    ) {
        let last_frame = self.frame_info_vec.last_mut().unwrap();
        last_frame.status = Some(_outcome.result.clone());
        last_frame.success = last_frame
            .status
            .as_ref()
            .is_some_and(|status| status.is_ok());
        last_frame.output = _outcome.result.output.clone();
        let frame_id = last_frame.frame_id;
        let result = _outcome.result.result;
        let success = last_frame.success;
        let gas_used = _outcome.result.gas.spent();
        let output = last_frame.output.clone();
        let deployed_addr = _outcome.address.unwrap_or(Address::ZERO);
        self.send_frame_update_address(deployed_addr);
        self.flush_steps();
        self.encoder
            .send_frame_exit(frame_id, result, success, gas_used, &output);
        self.frame_info_vec.pop();
    }

    fn initialize_interp(
        &mut self,
        interp: &mut revm::interpreter::Interpreter<EthInterpreter>,
        context: &mut Context<BlockT, TxT, CfgT, AlloyCacheDB, OpTraceJournal<AlloyCacheDB>>,
    ) {
        self.update_frame_bytecode(
            context.journaled_state.depth() as u16,
            self.frame_current_id(),
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
        if let Some(info) = self.frame_info_vec.last_mut() {
            info.selfdestruct_refund_target = Some(target);
            info.selfdestruct_transferred_value = Some(value);
        }
        // 通过 encoder 发送 selfdestruct 事件，附在 FrameExit 之前
        self.encoder.send_selfdestruct(
            self.frame_current_id(),
            contract,
            target,
            value,
        );
    }
}
