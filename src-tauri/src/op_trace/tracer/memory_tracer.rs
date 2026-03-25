//! 内存变更分发器：按 opcode 类型处理内存操作

use crate::op_trace::debug_session::DebugSession;
use crate::op_trace::message_encoder::MessageEncoder;
use revm::bytecode::OpCode;
use revm::interpreter::interpreter::EthInterpreter;
use revm::primitives::U256;
use revm_interpreter::interpreter_types::MemoryTr;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct MemoryTracer {
    src_data_offset: usize,
    dst_memory_offset: usize,
    memory_size: usize,
}

/// 返回值信息：RETURN/REVERT 指令提取的返回数据
/// 由调用方决定如何写入父帧，解耦 MemoryTracer 与帧管理
#[derive(Debug, Clone)]
pub struct ReturnValueInfo {
    pub data: Vec<u8>,
}

impl MemoryTracer {
    pub fn new() -> Self {
        Self {
            src_data_offset: 0,
            dst_memory_offset: 0,
            memory_size: 0,
        }
    }

    /// 记录当前 step 的内存操作参数
    /// 只处理内存相关指令，解耦合于 step_info 等外部结构
    pub fn record_opcode_args(&mut self, opcode: OpCode, stack_data: &[U256]) {
        match opcode {
            OpCode::MLOAD => {
                // MLOAD [offset]
                self.dst_memory_offset = usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.memory_size = 32;
            }
            OpCode::MSTORE => {
                // MSTORE [offset, value]
                self.dst_memory_offset = usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.memory_size = 32;
            }
            OpCode::MSTORE8 => {
                // MSTORE8 [offset, value]
                self.dst_memory_offset = usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.memory_size = 1;
            }
            OpCode::MCOPY => {
                // MCOPY [dst, src, size]
                self.dst_memory_offset = usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.src_data_offset = usize::try_from(stack_data[stack_data.len() - 2]).unwrap();
                self.memory_size = usize::try_from(stack_data[stack_data.len() - 3]).unwrap();
            }
            OpCode::CALLDATACOPY | OpCode::CODECOPY | OpCode::RETURNDATACOPY => {
                // CALLDATACOPY / CODECOPY / RETURNDATACOPY [dst, src, size]
                self.dst_memory_offset = usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.src_data_offset = usize::try_from(stack_data[stack_data.len() - 2]).unwrap();
                self.memory_size = usize::try_from(stack_data[stack_data.len() - 3]).unwrap();
            }
            OpCode::EXTCODECOPY => {
                // EXTCODECOPY [addr, dst, src, size]
                self.dst_memory_offset = usize::try_from(stack_data[stack_data.len() - 2]).unwrap();
                self.src_data_offset = usize::try_from(stack_data[stack_data.len() - 3]).unwrap();
                self.memory_size = usize::try_from(stack_data[stack_data.len() - 4]).unwrap();
            }
            OpCode::RETURN | OpCode::REVERT => {
                // RETURN / REVERT [offset, size]
                self.dst_memory_offset = usize::try_from(stack_data[stack_data.len() - 1]).unwrap();
                self.memory_size = usize::try_from(stack_data[stack_data.len() - 2]).unwrap();
            }
            _ => {}
        }
    }

    /// 在 step_end() 中调用：执行内存变更
    /// 返回 Some(ReturnValueInfo) 当 RETURN/REVERT 时，由调用方处理父帧写入
    pub fn dispatch_update(
        &self,
        opcode: OpCode,
        interp: &revm::interpreter::Interpreter<EthInterpreter>,
        frame_id: u16,
        frame_step: usize,
        debug_session: &Arc<Mutex<DebugSession>>,
        encoder: &MessageEncoder,
        memory_len_before: usize,
    ) -> Option<ReturnValueInfo> {
        let frame_step_u32 = frame_step as u32;

        match opcode {
            OpCode::MLOAD => {
                // MLOAD - 检测隐含扩张
                let offset = self.dst_memory_offset;
                if offset + 32 > memory_len_before && offset + 32 <= interp.memory.len() {
                    let new_size = interp.memory.len();
                    if new_size > memory_len_before {
                        let expand_data = vec![0u8; new_size - memory_len_before];
                        debug_session.lock().unwrap().push_patch(
                            frame_id,
                            frame_step_u32,
                            memory_len_before as u32,
                            expand_data,
                        );
                    }
                }
            }
            OpCode::MSTORE | OpCode::MSTORE8 | OpCode::MCOPY => {
                // MSTORE / MSTORE8 / MCOPY
                let dst_offset = self.dst_memory_offset;
                let size = self.memory_size;
                if size == 0 {
                    return None;
                }
                let data = interp.memory.slice(dst_offset..dst_offset + size).to_vec();
                debug_session.lock().unwrap().push_patch(
                    frame_id,
                    frame_step_u32,
                    dst_offset as u32,
                    data,
                );
            }
            OpCode::CALLDATACOPY | OpCode::CODECOPY | OpCode::EXTCODECOPY | OpCode::RETURNDATACOPY => {
                // CALLDATACOPY / CODECOPY / EXTCODECOPY / RETURNDATACOPY
                let dst_offset = self.dst_memory_offset;
                let size = self.memory_size;
                if size == 0 {
                    return None;
                }
                let data = interp.memory.slice(dst_offset..dst_offset + size).to_vec();
                debug_session.lock().unwrap().push_patch(
                    frame_id,
                    frame_step_u32,
                    dst_offset as u32,
                    data,
                );
            }
            OpCode::RETURN | OpCode::REVERT => {
                // RETURN / REVERT
                let offset = self.dst_memory_offset;
                let size = self.memory_size;
                if size > 0 {
                    let data = interp.memory.slice(offset..offset + size).to_vec();
                    encoder.send_return_data(frame_id, frame_step, &data);
                    // 返回给调用方，让其处理写入父帧的逻辑
                    return Some(ReturnValueInfo { data });
                }
                return None;
            }
            OpCode::KECCAK256 | OpCode::CALL | OpCode::CALLCODE | OpCode::DELEGATECALL | OpCode::STATICCALL => {
                // KECCAK256 / CALL / CALLCODE / DELEGATECALL / STATICCALL
                // 这些指令的 args/ret 区域可能触发内存静默扩张（只填零）
                let new_size = interp.memory.len();
                if new_size > memory_len_before {
                    let expand_data = vec![0u8; new_size - memory_len_before];
                    debug_session.lock().unwrap().push_patch(
                        frame_id,
                        frame_step_u32,
                        memory_len_before as u32,
                        expand_data,
                    );
                }
            }
            _ => {}
        }
        None
    }
}
