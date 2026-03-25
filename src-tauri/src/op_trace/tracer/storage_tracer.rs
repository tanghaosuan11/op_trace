//! 存储操作分发器：处理 SLOAD/TLOAD 和存储变化记录生成

use revm::bytecode::OpCode;
use revm::primitives::{Address, StorageKey, StorageValue, U256};
use crate::op_trace::debug_session::StorageChangeRecord;

#[derive(Clone, Default)]
pub struct StorageTracer {
    storage_key: Option<StorageKey>,
}

impl StorageTracer {
    pub fn new() -> Self {
        Self {
            storage_key: None,
        }
    }

    /// 记录 SLOAD/TLOAD 的 key（从栈顶读取）
    /// 只处理存储相关指令，解耦合于其他结构
    pub fn record_storage_key(&mut self, opcode: OpCode, stack_data: &[U256]) {
        match opcode {
            OpCode::SLOAD | OpCode::TLOAD => {
                // SLOAD / TLOAD [key]
                self.storage_key = Some(StorageKey::from(stack_data[stack_data.len() - 1]));
            }
            _ => {
                self.storage_key = None;
            }
        }
    }

    /// 返回存储 key（供调用方使用）
    pub fn get_storage_key(&self) -> Option<StorageKey> {
        self.storage_key
    }

    /// 生成存储变化记录
    pub fn create_change_record(
        step_index: usize,
        frame_id: u16,
        is_transient: bool,
        is_read: bool,
        address: Address,
        key: StorageKey,
        old_value: StorageValue,
        new_value: StorageValue,
    ) -> StorageChangeRecord {
        StorageChangeRecord {
            step_index,
            frame_id,
            is_transient,
            is_read,
            address,
            key,
            old_value,
            new_value,
        }
    }
}
