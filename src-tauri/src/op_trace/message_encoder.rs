// 二进制消息编码器

use revm::primitives::{Address, Log, StorageKey, StorageValue, U256};
use revm_interpreter::InstructionResult;
use serde::Serialize;
use std::sync::Arc;
use crate::op_trace::debug_session::{StateChangeKind, StateChangeRecord};

/// 底层字节发送器，由调用方注入（Tauri: channel.send; daemon: stdout JSON）
pub type BytesSender = Arc<dyn Fn(Vec<u8>) + Send + Sync + 'static>;


#[repr(u8)]
enum MsgType {
    StepBatch = 1,
    ContractSource = 2,
    ContextUpdateAddress = 3,
    Logs = 4,
    // MemoryUpdate = 5,
    ReturnData = 6,
    StorageChange = 7,
    FrameEnter = 8,
    FrameExit = 9,
    SelfDestruct = 10,
    BalanceChanges = 11,
    KeccakOp = 12,
    StateChange = 13,
    FoundrySourceJson = 14,
    Finished = 255,
}


/// 每批发送的步数上限
const STEP_BATCH_SIZE: usize = 800;

/// 需要在 StepBatch 中携带栈顶 3 项的 opcode 集合
const NEEDS_STACK: [u8; 13] = [
    0x20, // KECCAK256: offset, size
    0x54, // SLOAD
    0x55, // SSTORE
    0x5c, // TLOAD
    0x5d, // TSTORE
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, // LOG0-LOG4
    0xf1, // CALL
    0xfa, // STATICCALL
    0xf4, // DELEGATECALL
];

pub(crate) struct MessageEncoder {
    sender: BytesSender,
    /// 正在累积的 StepBatch 缓冲（第 0 字节已写 MsgType::StepBatch）
    step_payload: Vec<u8>,
    /// 当前缓冲中的步数
    step_cache_count: usize,
    /// 最近一次 pack_step 写入 gas_cost 字段的偏移，用于 step_end 回填
    last_step_gas_cost_offset: Option<usize>,
}

impl Clone for MessageEncoder {
    fn clone(&self) -> Self {
        Self {
            sender: Arc::clone(&self.sender),
            step_payload: self.step_payload.clone(),
            step_cache_count: self.step_cache_count,
            last_step_gas_cost_offset: self.last_step_gas_cost_offset,
        }
    }
}

impl MessageEncoder {
    pub fn new(sender: BytesSender) -> Self {
        let mut payload = Vec::with_capacity(1 + STEP_BATCH_SIZE * 400);
        payload.push(MsgType::StepBatch as u8);
        Self {
            sender,
            step_payload: payload,
            step_cache_count: 0,
            last_step_gas_cost_offset: None,
        }
    }


    /// 将一步的数据追加到批量缓冲。gas_cost 字段先占位 0，需要调用 `backfill_gas_cost` 回填。
    ///
    /// 二进制布局每步：`transaction_id`(4) + 原字段（见 `parseStepBatch`）。
    pub fn pack_step(
        &mut self,
        transaction_id: u32,
        pc: u64,
        op: u8,
        frame_id: u16,
        depth: u16,
        gas_remaining: u64,
        stack: &[U256],
        frame_step_count: usize,
    ) {
        // 0. Transaction ID (4 bytes, big-endian) — 单 tx 为 0
        self.step_payload
            .extend_from_slice(&transaction_id.to_be_bytes());
        // 1. Context ID (2 bytes)
        self.step_payload
            .extend_from_slice(&frame_id.to_be_bytes());
        // 2. Depth (2 bytes)
        self.step_payload.extend_from_slice(&depth.to_be_bytes());
        // 3. PC (8 bytes)
        self.step_payload.extend_from_slice(&pc.to_be_bytes());
        // 4. Opcode (1 byte)
        self.step_payload.push(op);
        // 5. Gas Cost (8 bytes) — 先写 0 占位，step_end 中回填
        self.last_step_gas_cost_offset = Some(self.step_payload.len());
        self.step_payload
            .extend_from_slice(&0u64.to_be_bytes());
        // 6. Gas Remaining (8 bytes)
        self.step_payload
            .extend_from_slice(&gas_remaining.to_be_bytes());
        // 7. Stack — 仅对需要栈数据的 opcode 发送栈顶 3 项，其余发 0
        if NEEDS_STACK.contains(&op) && !stack.is_empty() {
            let n = stack.len().min(3) as u16;
            self.step_payload
                .extend_from_slice(&n.to_be_bytes());
            // stack 底→顶排列，取末尾 n 项（即栈顶 n 项），保持底→顶顺序
            for val in &stack[stack.len() - n as usize..] {
                let b = val.to_be_bytes::<32>();
                self.step_payload.extend_from_slice(&b);
            }
        } else {
            self.step_payload
                .extend_from_slice(&0u16.to_be_bytes());
        }
        // 8. Frame step count (8 bytes)
        self.step_payload
            .extend_from_slice(&frame_step_count.to_be_bytes());
        self.step_cache_count += 1;
    }

    /// 回填最近一步的 gas_cost，并在累积足够步数时自动刷新。
    pub fn backfill_gas_cost(&mut self, gas_cost: u64) {
        if let Some(offset) = self.last_step_gas_cost_offset.take() {
            let bytes = gas_cost.to_be_bytes();
            self.step_payload[offset..offset + 8].copy_from_slice(&bytes);
        }
        if self.step_cache_count >= STEP_BATCH_SIZE {
            self.flush_steps();
        }
    }

    /// 将缓冲中的 StepBatch 数据通过 channel 发送给前端。
    pub fn flush_steps(&mut self) {
        if self.step_cache_count == 0 {
            return;
        }
        // 交换出当前 payload 直接发送（零拷贝），新的预写类型字节
        let mut next = Vec::with_capacity(1 + STEP_BATCH_SIZE * 400);
        next.push(MsgType::StepBatch as u8);
        let packet = std::mem::replace(&mut self.step_payload, next);
        self.step_cache_count = 0;
        (self.sender)(packet);
    }


    /// 发送 FrameEnter（JSON 序列化的 FrameInfo）
    pub fn send_frame_enter(&self, info: &impl Serialize) {
        let json = serde_json::to_vec(info).unwrap();
        let mut packet = Vec::with_capacity(1 + json.len());
        packet.push(MsgType::FrameEnter as u8);
        packet.extend_from_slice(&json);
        (self.sender)(packet);
    }

    /// 发送 FrameExit
    /// 格式: [type:1] [transaction_id:4] [frame_id:2] [result:1] [success:1] [gas_used:8] [output_len:4] [output:N]
    pub fn send_frame_exit(
        &self,
        transaction_id: u32,
        frame_id: u16,
        result: InstructionResult,
        success: bool,
        gas_used: u64,
        output: &[u8],
    ) {
        let mut packet = Vec::with_capacity(1 + 4 + 2 + 1 + 1 + 8 + 4 + output.len());
        packet.push(MsgType::FrameExit as u8);
        packet.extend_from_slice(&transaction_id.to_be_bytes());
        packet.extend_from_slice(&frame_id.to_be_bytes());
        packet.push(result as u8);
        packet.push(success as u8);
        packet.extend_from_slice(&gas_used.to_be_bytes());
        packet.extend_from_slice(&(output.len() as u32).to_be_bytes());
        packet.extend_from_slice(output);
        (self.sender)(packet);
    }

    /// 发送 SelfDestruct 事件
    /// 格式: [type:1] [transaction_id:4] [frame_id:2] [contract:20] [target:20] [value:32]
    pub fn send_selfdestruct(
        &self,
        transaction_id: u32,
        frame_id: u16,
        contract: Address,
        target: Address,
        value: U256,
    ) {
        let mut packet = Vec::with_capacity(1 + 4 + 2 + 20 + 20 + 32);
        packet.push(MsgType::SelfDestruct as u8);
        packet.extend_from_slice(&transaction_id.to_be_bytes());
        packet.extend_from_slice(&frame_id.to_be_bytes());
        packet.extend_from_slice(contract.as_slice());
        packet.extend_from_slice(target.as_slice());
        packet.extend_from_slice(&value.to_be_bytes::<32>());
        (self.sender)(packet);
    }

    /// 发送余额变化汇总 JSON
    pub fn send_balance_changes(&self, json: &str) {
        let mut packet = Vec::with_capacity(1 + json.len());
        packet.push(MsgType::BalanceChanges as u8);
        packet.extend_from_slice(json.as_bytes());
        (self.sender)(packet);
    }

    /// 发送 Finished 信号。
    /// - 无 `tx_boundaries`：与旧版兼容，仅 1 字节 `MsgType::Finished`。
    /// - 有 `tx_boundaries`：多笔调试时下发「第 2 笔起」每笔起始的 **global step 下标**（JSON，字段 `txBoundaries`）。
    pub fn send_finished(&self, tx_boundaries: Option<&[u32]>) {
        match tx_boundaries {
            Some(b) if !b.is_empty() => {
                #[derive(Serialize)]
                struct FinishedMeta<'a> {
                    #[serde(rename = "txBoundaries")]
                    tx_boundaries: &'a [u32],
                }
                let json = serde_json::to_vec(&FinishedMeta {
                    tx_boundaries: b,
                })
                .unwrap();
                let mut packet = Vec::with_capacity(1 + json.len());
                packet.push(MsgType::Finished as u8);
                packet.extend_from_slice(&json);
                (self.sender)(packet);
            }
            _ => {
                (self.sender)(vec![MsgType::Finished as u8]);
            }
        }
    }

    /// 发送 ContractSource（字节码）
    /// 格式: [type:1] [depth:2] [transaction_id:4] [context_id:2] [len:4] [bytecode]
    pub fn send_contract_source(
        &self,
        depth: u16,
        transaction_id: u32,
        context_id: u16,
        bytecode: &[u8],
    ) {
        if bytecode.is_empty() {
            return;
        }
        let mut packet = Vec::with_capacity(1 + 2 + 4 + 2 + 4 + bytecode.len());
        packet.push(MsgType::ContractSource as u8);
        packet.extend_from_slice(&depth.to_be_bytes());
        packet.extend_from_slice(&transaction_id.to_be_bytes());
        packet.extend_from_slice(&context_id.to_be_bytes());
        packet.extend_from_slice(&(bytecode.len() as u32).to_be_bytes());
        packet.extend_from_slice(bytecode);
        (self.sender)(packet);
    }

    /// 发送 ContextUpdateAddress（CREATE 后回填部署地址）
    /// 格式: [type:1] [transaction_id:4] [context_id:2] [address:20]
    pub fn send_frame_update_address(
        &self,
        transaction_id: u32,
        context_id: u16,
        address: Address,
    ) {
        let mut packet = Vec::with_capacity(1 + 4 + 2 + 20);
        packet.push(MsgType::ContextUpdateAddress as u8);
        packet.extend_from_slice(&transaction_id.to_be_bytes());
        packet.extend_from_slice(&context_id.to_be_bytes());
        packet.extend_from_slice(address.as_slice());
        (self.sender)(packet);
    }

    /// 发送 ReturnData（RETURN / REVERT 输出）
    /// 格式: [type:1] [transaction_id:4] [context_id:2] [step_count:8] [data]
    pub fn send_return_data(
        &self,
        transaction_id: u32,
        context_id: u16,
        step_count: usize,
        data: &[u8],
    ) {
        let mut packet = Vec::with_capacity(1 + 4 + 2 + 8 + data.len());
        packet.push(MsgType::ReturnData as u8);
        packet.extend_from_slice(&transaction_id.to_be_bytes());
        packet.extend_from_slice(&context_id.to_be_bytes());
        packet.extend_from_slice(&step_count.to_be_bytes());
        packet.extend_from_slice(data);
        (self.sender)(packet);
    }

    /// 发送 StorageChange
    /// 格式: [type:1] [storage_type:1] [frame_id:2] [step_index:8] [transaction_id:4] [address:20] [slot:32] [old:32] [new:32]
    pub fn send_storage_change(
        &self,
        is_transient: bool,
        is_read: bool,
        frame_id: u16,
        step_index: usize,
        transaction_id: u32,
        address: Address,
        key: StorageKey,
        old_value: StorageValue,
        new_value: StorageValue,
    ) {
        let mut packet = Vec::with_capacity(1 + 1 + 1 + 2 + 8 + 4 + 20 + 32 + 32 + 32);
        packet.push(MsgType::StorageChange as u8);
        packet.push(is_transient as u8);
        packet.push(is_read as u8);
        packet.extend_from_slice(&frame_id.to_be_bytes());
        packet.extend_from_slice(&step_index.to_be_bytes());
        packet.extend_from_slice(&transaction_id.to_be_bytes());
        packet.extend_from_slice(address.as_slice());
        packet.extend_from_slice(&key.to_be_bytes::<32>());
        packet.extend_from_slice(&old_value.to_be_bytes::<32>());
        packet.extend_from_slice(&new_value.to_be_bytes::<32>());
        (self.sender)(packet);
    }

    /// 发送 KeccakOp
    /// 布局: [type:1][transaction_id:4][context_id:2][step_index:8][hash:32][input_len:4][input...]
    pub fn send_keccak_op(
        &self,
        transaction_id: u32,
        context_id: u16,
        step_index: usize,
        hash: &[u8; 32],
        input: &[u8],
    ) {
        let mut packet = Vec::with_capacity(1 + 4 + 2 + 8 + 32 + 4 + input.len());
        packet.push(MsgType::KeccakOp as u8);
        packet.extend_from_slice(&transaction_id.to_be_bytes());
        packet.extend_from_slice(&context_id.to_be_bytes());
        packet.extend_from_slice(&step_index.to_be_bytes());
        packet.extend_from_slice(hash);
        packet.extend_from_slice(&(input.len() as u32).to_be_bytes());
        packet.extend_from_slice(input);
        (self.sender)(packet);
    }

    /// 发送 Logs（JSON 序列化的 Log）
    /// 布局：`[type:1][context_id:2][step_index:8 BE][transaction_id:4 BE][json...]`
    pub fn send_logs(
        &self,
        context_id: u16,
        step_index: usize,
        transaction_id: u32,
        log: &Log,
    ) {
        let json = serde_json::to_string(log).unwrap();
        let mut packet = Vec::with_capacity(1 + 2 + 8 + 4 + json.len());
        packet.push(MsgType::Logs as u8);
        packet.extend_from_slice(&context_id.to_be_bytes());
        packet.extend_from_slice(&step_index.to_be_bytes());
        packet.extend_from_slice(&transaction_id.to_be_bytes());
        packet.extend_from_slice(json.as_bytes());
        (self.sender)(packet);
    }

    /// 发送预构建好的 Log JSON（用于 Foundry 模式，topics 来自 EVM 栈，data 为 emit 文本）
    /// 布局与 send_logs 完全相同：`[type:1][context_id:2][step_index:8 BE][transaction_id:4 BE][json...]`
    pub fn send_log_data(
        &self,
        context_id: u16,
        step_index: usize,
        transaction_id: u32,
        log_json: &str,
    ) {
        let mut packet = Vec::with_capacity(1 + 2 + 8 + 4 + log_json.len());
        packet.push(MsgType::Logs as u8);
        packet.extend_from_slice(&context_id.to_be_bytes());
        packet.extend_from_slice(&step_index.to_be_bytes());
        packet.extend_from_slice(&transaction_id.to_be_bytes());
        packet.extend_from_slice(log_json.as_bytes());
        (self.sender)(packet);
    }

    /// 发送 FoundrySourceJson（Foundry 模式源码+sourcemap JSON，仅内存，不持久化）
    /// 格式: [type:1] [transaction_id:4] [context_id:2] [json_len:4] [json_bytes]
    pub fn send_foundry_source_json(
        &self,
        transaction_id: u32,
        context_id: u16,
        json_bytes: &[u8],
    ) {
        let mut packet = Vec::with_capacity(1 + 4 + 2 + 4 + json_bytes.len());
        packet.push(MsgType::FoundrySourceJson as u8);
        packet.extend_from_slice(&transaction_id.to_be_bytes());
        packet.extend_from_slice(&context_id.to_be_bytes());
        packet.extend_from_slice(&(json_bytes.len() as u32).to_be_bytes());
        packet.extend_from_slice(json_bytes);
        (self.sender)(packet);
    }

    /// 发送 StateChange（账户/余额/nonce 变化）
    /// 格式: [type:1][transaction_id:4][frame_id:2][step_index:8][json...]
    /// JSON 包含 category, kind 以及变化相关字段
    pub fn send_state_change(&self, rec: &StateChangeRecord) {
        fn hex(b: &[u8]) -> String {
            format!("0x{}", hex::encode(b))
        }
        fn u256_hex(v: &U256) -> String {
            format!("0x{}", hex::encode(v.to_be_bytes::<32>()))
        }
        let json_val = match &rec.kind {
            StateChangeKind::AccountCreated { address, is_created_globally } => serde_json::json!({
                "category": "account",
                "kind": "AccountCreated",
                "address": hex(address.as_slice()),
                "isCreatedGlobally": is_created_globally,
            }),
            StateChangeKind::AccountDestroyed { address, target, had_balance } => serde_json::json!({
                "category": "account",
                "kind": "AccountDestroyed",
                "address": hex(address.as_slice()),
                "target": hex(target.as_slice()),
                "hadBalance": u256_hex(had_balance),
            }),
            StateChangeKind::BalanceChange { address, old_balance, new_balance } => serde_json::json!({
                "category": "balance",
                "kind": "BalanceChange",
                "address": hex(address.as_slice()),
                "oldBalance": u256_hex(old_balance),
                "newBalance": u256_hex(new_balance),
            }),
            StateChangeKind::BalanceTransfer { from, to, balance } => serde_json::json!({
                "category": "balance",
                "kind": "BalanceTransfer",
                "from": hex(from.as_slice()),
                "to": hex(to.as_slice()),
                "balance": u256_hex(balance),
            }),
            StateChangeKind::NonceChange { address, previous_nonce, new_nonce } => serde_json::json!({
                "category": "nonce",
                "kind": "NonceChange",
                "address": hex(address.as_slice()),
                "previousNonce": previous_nonce,
                "newNonce": new_nonce,
            }),
            StateChangeKind::NonceBump { address, previous_nonce, new_nonce } => serde_json::json!({
                "category": "nonce",
                "kind": "NonceBump",
                "address": hex(address.as_slice()),
                "previousNonce": previous_nonce,
                "newNonce": new_nonce,
            }),
        };
        let json = serde_json::to_string(&json_val).unwrap();
        let mut packet = Vec::with_capacity(1 + 4 + 2 + 8 + json.len());
        packet.push(MsgType::StateChange as u8);
        packet.extend_from_slice(&rec.transaction_id.to_be_bytes());
        packet.extend_from_slice(&rec.frame_id.to_be_bytes());
        packet.extend_from_slice(&rec.step_index.to_be_bytes());
        packet.extend_from_slice(json.as_bytes());
        (self.sender)(packet);
    }
}
