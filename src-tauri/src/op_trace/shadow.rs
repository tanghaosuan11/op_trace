//! EVM 数据流追踪：Shadow Stack + Shadow Memory + Shadow Storage
//!
//! 在 Inspector 的 step/call/call_end 回调中同步维护影子状态，
//! 构建全局 DataNode 图，支持 backward_slice 查询。

use revm::primitives::{Address, U256};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;


pub type NodeId = u32;
pub const NO_NODE: NodeId = u32::MAX;


/// 数据流图中的一个节点，代表某步产生的数据
#[derive(Clone)]
pub struct DataNode {
    /// 全局 step 索引
    pub global_step: u32,
    pub pc: u32,
    pub opcode: u8,
    /// 产生此数据的源节点
    pub parents: Vec<NodeId>,
}


/// 用于发送到前端的节点信息
#[derive(Serialize, Clone)]
pub struct DataNodeInfo {
    /// 节点 ID
    pub id: u32,
    /// 全局步骤索引
    pub global_step: u32,
    /// PC
    pub pc: u32,
    /// 字节码 opcode
    pub opcode: u8,
    /// opcode 助记符
    pub opcode_name: String,
    /// 父节点 ID 列表
    pub parent_ids: Vec<u32>,
    /// 该节点所在 step 执行后的栈值（若能定位到该节点在栈中的位置）
    pub stack_value_post: Option<String>,
}

/// 数据流树
#[derive(Serialize)]
pub struct DataFlowTree {
    /// 查询起点的节点 ID
    pub root_id: u32,
    /// 所有节点
    pub nodes: Vec<DataNodeInfo>,
}

#[derive(Serialize, Clone)]
pub struct ShadowValidationMismatch {
    pub step: u32,
    pub frame_id: Option<u16>,
    pub opcode: u8,
    pub opcode_name: String,
    pub stack_index: usize,
    pub shadow_id: u32,
    pub expected_evm: String,
    pub actual_shadow: String,
    pub reason: String,
}

#[derive(Serialize, Clone)]
pub struct ShadowValidationReport {
    pub checked_steps: usize,
    pub checked_slots: usize,
    pub mismatch_count: usize,
    pub mismatches: Vec<ShadowValidationMismatch>,
}

/// 每个 call frame 的独立影子状态
#[derive(Clone)]
struct ShadowFrame {
    /// 影子栈：镜像 EVM 栈，存 NodeId 而非 U256
    shadow_stack: Vec<NodeId>,
    /// 影子内存：EVM 线性内存模型，按需扩展但有上限
    /// 遵循 EVM 内存算法：访问会自动扩展，超过上限则不记录
    shadow_memory: Vec<NodeId>,
    /// calldata 的影子：按字节索引存 NodeId
    calldata_shadow: Vec<NodeId>,
    /// RETURN/REVERT 前保存的返回数据影子
    prepared_return_shadow: Vec<NodeId>,
}

/// 合理的内存偏移上限：4 MB
/// 
/// 在 EVM gas 限制下，实际可达到的内存远小于这个值。
/// 超过此值的内存操作是不现实的，应该被完全忽略（不污染数据流）。
/// 
/// 计算理由：
/// - EVM 内存成本：3 gas + 1/32 gas 每 32 bytes（二次定价）
/// - 1000 万 gas（一整个区块）最多可扩展 ~1000 万字节内存
/// - 4MB 是保守的现实上限，留有充足的缓冲
const MAX_REASONABLE_MEMORY_OFFSET: usize = 4 * 1024 * 1024;

impl ShadowFrame {
    fn new() -> Self {
        Self {
            shadow_stack: Vec::new(),
            shadow_memory: Vec::new(),
            calldata_shadow: Vec::new(),
            prepared_return_shadow: Vec::new(),
        }
    }

    fn with_calldata(calldata_shadow: Vec<NodeId>) -> Self {
        Self {
            shadow_stack: Vec::new(),
            shadow_memory: Vec::new(),
            calldata_shadow,
            prepared_return_shadow: Vec::new(),
        }
    }
}

/// 全局影子状态，贯穿整个交易执行
#[derive(Clone)]
pub struct ShadowState {
    /// 所有数据流节点
    nodes: Vec<DataNode>,
    /// 调用帧栈
    frames: Vec<ShadowFrame>,
    /// 持久 storage 影子 (address, slot) -> NodeId
    shadow_storage: HashMap<(Address, U256), NodeId>,
    /// 瞬态 storage 影子
    shadow_transient: HashMap<(Address, U256), NodeId>,
    /// 上一次 call 返回的数据影子，供 RETURNDATACOPY 使用
    return_data_shadow: Vec<NodeId>,
    /// 下一次 push_frame 使用的 calldata 影子（在 on_step(CALL/CREATE) 中预计算）
    pending_calldata_shadow: Option<Vec<NodeId>>,
    /// 待在 pop_frame 时回填到父帧栈顶的返回节点栈（支持嵌套 CALL/CREATE）
    /// 元素为 (call_or_create_node_id, origin_step)
    pending_ret_stack: Vec<(NodeId, u32)>,
    /// global_step -> NodeId 映射，用于 backward_slice 查询
    step_node_map: Vec<NodeId>,
    /// global_step -> 影子栈快照，用于根据 stack_depth 查询
    step_stack_snapshots: HashMap<u32, Vec<NodeId>>,
    /// global_step -> 执行前影子栈快照（on_step 入口）
    step_stack_snapshots_pre: HashMap<u32, Vec<NodeId>>,
    /// global_step -> frame_depth（当前 frame 栈深），用于区分跨帧问题
    step_frame_depths: HashMap<u32, usize>,
    /// global_step -> frame_id/context_id
    step_frame_ids: HashMap<u32, u16>,
    /// global_step -> EVM栈快照（执行前，原始 U256）
    step_evm_stacks: HashMap<u32, Vec<U256>>,
    /// global_step -> step_end 后 EVM 栈快照（执行后，原始 U256）
    step_evm_stacks_post: HashMap<u32, Vec<U256>>,
    /// 调试日志文件路径
    debug_log_path: PathBuf,
    /// 导出/调试临时文件目录
    temp_dir: PathBuf,
    /// 是否启用调试日志文件写入
    enable_debug_log: bool,
}

impl ShadowState {
    pub fn new() -> Self {
        Self::with_temp_dir(std::env::temp_dir())
    }

    pub fn with_temp_dir(temp_dir: PathBuf) -> Self {
        let enable_debug_log = false; // 默认禁用调试日志
        let debug_log_path = temp_dir.join("optrace_shadow_debug.log");
        if enable_debug_log {
            // 只在文件不存在时创建，否则以追加模式打开
            let mut init_file = if !debug_log_path.exists() {
                File::create(&debug_log_path).unwrap()
            } else {
                OpenOptions::new().append(true).open(&debug_log_path).unwrap()
            };
            let _ = writeln!(init_file, "\n[shadow] ========== NEW ShadowState instance ==========");
            let _ = init_file.flush();
        } 
        
        Self {
            nodes: Vec::with_capacity(1024),
            frames: Vec::new(), // push_frame 在 Inspector::call() 中创建第一个帧
            shadow_storage: HashMap::new(),
            shadow_transient: HashMap::new(),
            return_data_shadow: Vec::new(),
            pending_calldata_shadow: None,
            pending_ret_stack: Vec::new(),
            step_node_map: Vec::with_capacity(1024),
            step_stack_snapshots: HashMap::new(),
            step_stack_snapshots_pre: HashMap::new(),
            step_frame_depths: HashMap::new(),
            step_frame_ids: HashMap::new(),
            step_evm_stacks: HashMap::new(),
            step_evm_stacks_post: HashMap::new(),
            debug_log_path,
            temp_dir,
            enable_debug_log: enable_debug_log, // 默认启用调试日志
        }
    }
    
    /// 设置是否启用调试日志文件写入
    pub fn set_debug_log_enabled(&mut self, enabled: bool) {
        self.enable_debug_log = enabled;
    }
    
    /// 获取调试日志是否启用
    pub fn is_debug_log_enabled(&self) -> bool {
        self.enable_debug_log
    }
    
    /// 辅助方法：写入调试日志（带自动 flush）
    fn debug_log(&self, msg: &str) {
        if !self.enable_debug_log {
            return;
        }
        if let Ok(mut file) = OpenOptions::new().append(true).open(&self.debug_log_path) {
            let _ = writeln!(file, "{}", msg);
            let _ = file.flush();  // 立刻刷新到磁盘
        }
    }

    // ── 内部工具 ──────────────────────────────────────────────────────────

    fn current_frame(&self) -> &ShadowFrame {
        self.frames.last().expect("shadow: no frame")
    }

    fn current_frame_mut(&mut self) -> &mut ShadowFrame {
        // 懒初始化：如果没有 frame，创建默认的顶层 frame
        if self.frames.is_empty() {
            eprintln!("[shadow] initializing first frame (lazy init)");
            self.frames.push(ShadowFrame::new());
        }
        self.frames.last_mut().expect("shadow: no frame")
    }

    /// 创建新节点，返回 NodeId
    fn alloc_node(&mut self, global_step: u32, pc: u32, opcode: u8, parents: Vec<NodeId>) -> NodeId {
        let id = self.nodes.len() as NodeId;
        self.nodes.push(DataNode {
            global_step,
            pc,
            opcode,
            parents,
        });
        id
    }

    /// 从当前帧的影子栈弹出，栈空时返回 NO_NODE
    fn pop_shadow(&mut self) -> NodeId {
        self.current_frame_mut()
            .shadow_stack
            .pop()
            .unwrap_or(NO_NODE)
    }

    /// 推入当前帧的影子栈
    fn push_shadow(&mut self, nid: NodeId) {
        self.current_frame_mut().shadow_stack.push(nid);
    }

    #[inline]
    fn is_deferred_post_snapshot_opcode(opcode: u8) -> bool {
        matches!(opcode, 0xf1 | 0xf2 | 0xf4 | 0xfa | 0xf0 | 0xf5)
    }

    /// 读取影子内存 [offset..offset+size] 中的唯一非 NO_NODE 节点
    fn memory_parents(&self, offset: usize, size: usize) -> Vec<NodeId> {
        // 如果 offset 超出合理范围，返回空（没有有效的 parents）
        if offset >= MAX_REASONABLE_MEMORY_OFFSET || size == 0 {
            return vec![];
        }
        
        let mem = &self.current_frame().shadow_memory;
        let mut seen = HashSet::new();
        
        // 只在合理范围内查询
        let end = offset.saturating_add(size).min(MAX_REASONABLE_MEMORY_OFFSET);
        let end_idx = end.min(mem.len());
        
        for i in offset..end_idx {
            let nid = mem[i];
            if nid != NO_NODE {
                seen.insert(nid);
            }
        }
        seen.into_iter().collect()
    }

    /// 写入影子内存 [offset..offset+size] = nid
    /// 按需扩展 Vec，遵守 MAX_REASONABLE_MEMORY_OFFSET 限制
    ///
    /// 核心策略：超出合理范围的内存操作直接忽略（return）。
    /// 这些超大偏移在真实 EVM 中不可能发生，不应该污染数据流图。
    fn memory_write(&mut self, offset: usize, size: usize, nid: NodeId) {
        // 第一道防线：如果起始 offset 就超出合理范围，直接忽略
        if offset >= MAX_REASONABLE_MEMORY_OFFSET {
            return;
        }
        
        // 第二道防线：检查写入范围是否超出
        let end_offset = offset.saturating_add(size);
        if end_offset > MAX_REASONABLE_MEMORY_OFFSET {
            // 超出范围，直接忽略（不截断写入）
            return;
        }
        
        // 在合理范围内，正常扩展和写入
        let frame = self.current_frame_mut();
        if end_offset > frame.shadow_memory.len() {
            frame.shadow_memory.resize(end_offset, NO_NODE);
        }
        for i in 0..size {
            frame.shadow_memory[offset + i] = nid;
        }
    }

    /// 从影子内存生成切片，超出合理范围则返回空
    ///
    /// 如果 offset 超出范围，直接返回全 NO_NODE（表示无有效数据）
    fn memory_slice(&self, offset: usize, size: usize) -> Vec<NodeId> {
        // 无效范围，返回空向量
        if offset >= MAX_REASONABLE_MEMORY_OFFSET || size == 0 {
            return vec![NO_NODE; size];
        }
        
        let mem = &self.current_frame().shadow_memory;
        let mut result = vec![NO_NODE; size];
        
        // 只在合理范围内复制
        let end = offset.saturating_add(size).min(MAX_REASONABLE_MEMORY_OFFSET);
        let end_idx = end.min(mem.len());
        
        for i in offset..end_idx {
            if i < mem.len() && i - offset < size {
                result[i - offset] = mem[i];
            }
        }
        result
    }

    /// 从 calldata 影子中读取唯一节点作为 parents
    fn calldata_parents(&self, offset: usize, size: usize) -> Vec<NodeId> {
        let cd = &self.current_frame().calldata_shadow;
        let mut seen = HashSet::new();
        let end = offset.saturating_add(size).min(cd.len());
        for i in offset..end {
            let nid = cd[i];
            if nid != NO_NODE {
                seen.insert(nid);
            }
        }
        seen.into_iter().collect()
    }

    /// 安全读取 stack 值 (revm stack: index 0 = bottom, last = top)
    /// 
    /// 从 u256 值的最低 64 位提取 usize。
    /// 不做截断 - 调用方（memory_write/memory_slice 等）负责检查是否超出合理范围。
    fn stack_val(stack: &[U256], from_top: usize) -> usize {
        let len = stack.len();
        if from_top < len {
            let val = stack[len - 1 - from_top];
            val.as_limbs()[0] as usize
        } else {
            0
        }
    }

    // ── 主入口：on_step ──────────────────────────────────────────────────

    /// 在 Inspector::step() 中调用（opcode 执行前）
    ///
    /// - `opcode`: 当前指令
    /// - `pc`: 程序计数器
    /// - `global_step`: 全局 step 索引（DebugSession 中的 trace 序号）
    /// - `stack`: 执行前的 EVM 栈 (bottom..top)
    /// - `address`: 当前合约地址
    pub fn on_step(
        &mut self,
        opcode: u8,
        pc: usize,
        global_step: usize,
        stack: &[U256],
        address: Address,
        frame_id: u16,
    ) {
        let gs = global_step as u32;
        let pc32 = pc as u32;
        // 执行前快照（与 on_step 入参 stack 同时刻）
        let pre_shadow_stack = self.current_frame().shadow_stack.clone();

        // 记录当前步的节点（默认 NO_NODE，后续赋值）
        let step_idx = global_step;
        // 确保 step_node_map 容量足够
        if step_idx >= self.step_node_map.len() {
            self.step_node_map.resize(step_idx + 1, NO_NODE);
        }

        // 详细日志：仅在开启 debug_log 时构造字符串，避免热路径 format 开销
        if self.enable_debug_log {
            let opcode_name = self.opcode_to_name(opcode);
            self.debug_log(&format!("\n[shadow.on_step] ========== 步骤 {} ==========", step_idx));
            self.debug_log(&format!("[shadow.on_step] opcode: 0x{:02x}({}), pc: 0x{:04x}", opcode, opcode_name, pc));
            self.debug_log(&format!("[shadow.on_step] 栈深度: {}", stack.len()));
            if stack.len() > 0 {
                self.debug_log(&format!("[shadow.on_step] 栈顶(stack[{}]): 0x{:x}", stack.len()-1, stack[stack.len()-1]));
            }
            if stack.len() > 1 {
                self.debug_log(&format!("[shadow.on_step] 栈次(stack[{}]): 0x{:x}", stack.len()-2, stack[stack.len()-2]));
            }
            if stack.len() > 2 {
                self.debug_log(&format!("[shadow.on_step] 栈三(stack[{}]): 0x{:x}", stack.len()-3, stack[stack.len()-3]));
            }
            self.debug_log(&format!("[shadow.on_step] 当前帧影子栈深: {}", self.current_frame().shadow_stack.len()));
            self.debug_log(&format!("[shadow.on_step] 修改前影子栈内容: {:?}", self.current_frame().shadow_stack));
        }

        // CALL/CREATE 返回值在 pop_frame 中推入父帧栈顶

        let node_id = match opcode {
            // ── 二元运算：pop 2, push 1 ────────────────────────────────
            0x01..=0x07 | 0x0a | 0x0b | 0x10..=0x14 | 0x16..=0x18 | 0x1a..=0x1d => {
                let a = self.pop_shadow();
                let b = self.pop_shadow();
                let nid = self.alloc_node(gs, pc32, opcode, vec![a, b]);
                self.push_shadow(nid);
                nid
            }

            // ── 三元运算：ADDMOD(0x08), MULMOD(0x09) → pop 3, push 1 ──
            0x08 | 0x09 => {
                let a = self.pop_shadow();
                let b = self.pop_shadow();
                let c = self.pop_shadow();
                let nid = self.alloc_node(gs, pc32, opcode, vec![a, b, c]);
                self.push_shadow(nid);
                nid
            }

            // ── 一元运算：ISZERO(0x15), NOT(0x19) → pop 1, push 1 ─────
            0x15 | 0x19 => {
                let a = self.pop_shadow();
                let nid = self.alloc_node(gs, pc32, opcode, vec![a]);
                self.push_shadow(nid);
                nid
            }

            // ── KECCAK256(0x20) → pop 2 (offset, size), push 1 ────────
            // 结果依赖内存内容
            0x20 => {
                let offset_n = self.pop_shadow();
                let size_n = self.pop_shadow();
                let offset = Self::stack_val(stack, 0);
                let size = Self::stack_val(stack, 1);
                let mut parents = vec![offset_n, size_n];
                parents.extend(self.memory_parents(offset, size));
                let nid = self.alloc_node(gs, pc32, opcode, parents);
                self.push_shadow(nid);
                nid
            }

            // ── 环境常量：pop 0, push 1（无 parents，是叶子节点） ──────
            0x30 | // ADDRESS
            0x32 | // ORIGIN
            0x33 | // CALLER
            0x34 | // CALLVALUE
            0x36 | // CALLDATASIZE
            0x38 | // CODESIZE
            0x3a | // GASPRICE
            0x3d | // RETURNDATASIZE
            0x41 | // COINBASE
            0x42 | // TIMESTAMP
            0x43 | // NUMBER
            0x44 | // PREVRANDAO
            0x45 | // GASLIMIT
            0x46 | // CHAINID
            0x47 | // SELFBALANCE
            0x48 | // BASEFEE
            0x4a | // BLOBBASEFEE
            0x58 | // PC
            0x59 | // MSIZE
            0x5a | // GAS
            0x5f => // PUSH0
            {
                let nid = self.alloc_node(gs, pc32, opcode, vec![]);
                self.push_shadow(nid);
                nid
            }

            // ── PUSH1..PUSH32 (0x60..0x7f) → push constant ────────────
            0x60..=0x7f => {
                let nid = self.alloc_node(gs, pc32, opcode, vec![]);
                self.push_shadow(nid);
                nid
            }

            // ── 环境读取 (pop 1, push 1) ───────────────────────────────
            // BALANCE(0x31), EXTCODESIZE(0x3b), EXTCODEHASH(0x3f),
            // BLOCKHASH(0x40), BLOBHASH(0x49)
            0x31 | 0x3b | 0x3f | 0x40 | 0x49 => {
                let a = self.pop_shadow();
                let nid = self.alloc_node(gs, pc32, opcode, vec![a]);
                self.push_shadow(nid);
                nid
            }

            // ── CALLDATALOAD(0x35) → pop 1 (offset), push 1 ───────────
            // 结果依赖 calldata 内容
            0x35 => {
                let offset_n = self.pop_shadow();
                let offset = Self::stack_val(stack, 0);
                let mut parents = vec![offset_n];
                parents.extend(self.calldata_parents(offset, 32));
                let nid = self.alloc_node(gs, pc32, opcode, parents);
                self.push_shadow(nid);
                nid
            }

            // ── CALLDATACOPY(0x37) → pop 3, push 0, 写内存 ────────────
            0x37 => {
                let dest_n = self.pop_shadow();
                let offset_n = self.pop_shadow();
                let size_n = self.pop_shadow();
                let dest = Self::stack_val(stack, 0);
                let cd_offset = Self::stack_val(stack, 1);
                let size = Self::stack_val(stack, 2);
                let mut parents = vec![dest_n, offset_n, size_n];
                parents.extend(self.calldata_parents(cd_offset, size));
                let nid = self.alloc_node(gs, pc32, opcode, parents);
                if size > 0 {
                    self.memory_write(dest, size, nid);
                }
                nid
            }

            // ── CODECOPY(0x39) → pop 3, push 0, 写内存 ────────────────
            0x39 => {
                let dest_n = self.pop_shadow();
                let offset_n = self.pop_shadow();
                let size_n = self.pop_shadow();
                let dest = Self::stack_val(stack, 0);
                let size = Self::stack_val(stack, 2);
                let nid = self.alloc_node(gs, pc32, opcode, vec![dest_n, offset_n, size_n]);
                if size > 0 {
                    self.memory_write(dest, size, nid);
                }
                nid
            }

            // ── EXTCODECOPY(0x3c) → pop 4, push 0, 写内存 ────────────
            0x3c => {
                let addr_n = self.pop_shadow();
                let dest_n = self.pop_shadow();
                let offset_n = self.pop_shadow();
                let size_n = self.pop_shadow();
                let dest = Self::stack_val(stack, 1);
                let size = Self::stack_val(stack, 3);
                let nid = self.alloc_node(gs, pc32, opcode, vec![addr_n, dest_n, offset_n, size_n]);
                if size > 0 {
                    self.memory_write(dest, size, nid);
                }
                nid
            }

            // ── RETURNDATACOPY(0x3e) → pop 3, push 0, 写内存 ─────────
            // 读 return data 的影子
            0x3e => {
                let dest_n = self.pop_shadow();
                let offset_n = self.pop_shadow();
                let size_n = self.pop_shadow();
                let dest = Self::stack_val(stack, 0);
                let rd_offset = Self::stack_val(stack, 1);
                let size = Self::stack_val(stack, 2);
                let mut parents = vec![dest_n, offset_n, size_n];
                // 从 return_data_shadow 收集 parents
                let end = rd_offset.saturating_add(size).min(self.return_data_shadow.len());
                let mut seen = HashSet::new();
                for i in rd_offset..end {
                    let nid = self.return_data_shadow[i];
                    if nid != NO_NODE {
                        seen.insert(nid);
                    }
                }
                parents.extend(seen);
                let nid = self.alloc_node(gs, pc32, opcode, parents);
                if size > 0 {
                    self.memory_write(dest, size, nid);
                }
                nid
            }

            // ── POP(0x50) → pop 1, push 0 ─────────────────────────────
            0x50 => {
                self.pop_shadow();
                NO_NODE
            }

            // ── MLOAD(0x51) → pop 1 (offset), push 1 ─────────────────
            0x51 => {
                // EVM 栈语义：stack[0] = offset（执行前）
                let offset = Self::stack_val(stack, 0);  // 先读 offset 值（执行前）
                let offset_n = self.pop_shadow();  // 弹出对应的影子节点
                
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.MLOAD] offset=0x{:x}, offset_n={}", offset, offset_n));
                }
                
                let mut parents = vec![offset_n];
                let mem_parents = self.memory_parents(offset, 32);
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.MLOAD] 从内存[0x{:x}..0x{:x}] 读取 parents: {:?}", offset, offset.saturating_add(32), mem_parents));
                }
                
                parents.extend(mem_parents);
                let parent_count = parents.len();
                let nid = self.alloc_node(gs, pc32, opcode, parents);
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.MLOAD] 创建节点: nid={}, 总 parents={}", nid, parent_count));
                }
                
                self.push_shadow(nid);
                nid
            }

            // ── MSTORE(0x52) → pop 2, push 0, 写 32 字节 ────────────
            0x52 => {
                // EVM 栈语义：stack[0] = offset（栈顶），stack[1] = value（栈次）
                let offset = Self::stack_val(stack, 0); // 先读 offset 值（执行前）
                // 然后按栈顺序弹出：offset 在栈顶，value 在栈次
                let offset_n = self.pop_shadow(); // 弹出 offset 的影子（栈顶）
                let value_n = self.pop_shadow();  // 弹出 value 的影子（栈次）
                
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.MSTORE] pop value_n={}, offset_n={}", value_n, offset_n));
                    self.debug_log(&format!("[shadow.MSTORE] offset=0x{:x}, value_n={}", offset, value_n));
                    self.debug_log(&format!("[shadow.MSTORE] 将 value_n={} 写入内存[0x{:x}..0x{:x}]", value_n, offset, offset.saturating_add(32)));
                }
                
                // 规范正确做法：只把 value_n 本身写入内存（不创建 MSTORE 节点）
                self.memory_write(offset, 32, value_n);
                
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.MSTORE] 完成: memory[0x{:x}] := nid({})", offset, value_n));
                }
                
                NO_NODE  // MSTORE 不产生栈输出
            }

            // ── MSTORE8(0x53) → pop 2, push 0, 写 1 字节 ────────────
            0x53 => {
                // 同 MSTORE，stack[0] = offset，stack[1] = value
                let offset = Self::stack_val(stack, 0);
                let offset_n = self.pop_shadow();
                let value_n = self.pop_shadow();
                
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.MSTORE8] pop value_n={}, offset_n={}", value_n, offset_n));
                    self.debug_log(&format!("[shadow.MSTORE8] 将 value_n={} 写入内存[0x{:x}]", value_n, offset));
                }
                
                // 只写 value_n（1 字节）
                self.memory_write(offset, 1, value_n);
                
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.MSTORE8] 完成: memory[0x{:x}] := nid({})", offset, value_n));
                }
                NO_NODE
            }

            // ── SLOAD(0x54) → pop 1 (key), push 1 ────────────────────
            0x54 => {
                let key_n = self.pop_shadow();
                let key = stack.last().copied().unwrap_or_default();
                
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.SLOAD] key_n={}", key_n));
                    self.debug_log(&format!("[shadow.SLOAD] stack顶=0x{:x} (key)", key));
                }
                
                let mut parents = vec![key_n];
                let storage_parent = self.shadow_storage.get(&(address, key)).copied();
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.SLOAD] 存储中 (addr, key) 的节点: {:?}", storage_parent));
                }
                
                if let Some(&storage_n) = storage_parent.as_ref() {
                    parents.push(storage_n);
                }
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.SLOAD] 总父节点: {:?}", parents));
                }
                
                let nid = self.alloc_node(gs, pc32, opcode, parents);
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.SLOAD] 创建节点: nid={}", nid));
                }
                
                self.push_shadow(nid);
                nid
            }

            // ── SSTORE(0x55) → pop 2, push 0 ─────────────────────────
            0x55 => {
                let key_n = self.pop_shadow();
                let value_n = self.pop_shadow();
                let key = stack.last().copied().unwrap_or_default();
                
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.SSTORE] key_n={}, value_n={}", key_n, value_n));
                    self.debug_log(&format!("[shadow.SSTORE] stack顶=0x{:x} (key)", key));
                    self.debug_log(&format!("[shadow.SSTORE] 存储位置: (addr, key)=({:?}, 0x{:x})", address, key));
                }
                
                let nid = self.alloc_node(gs, pc32, opcode, vec![key_n, value_n]);
                if self.enable_debug_log {
                    self.debug_log(&format!("[shadow.SSTORE] 创建节点: nid={}", nid));
                }
                
                self.shadow_storage.insert((address, key), nid);
                if self.enable_debug_log {
                    self.debug_log("[shadow.SSTORE] 已更新存储映射");
                }
                
                nid
            }

            // ── JUMP(0x56) → pop 1, push 0 ───────────────────────────
            0x56 => {
                self.pop_shadow();
                NO_NODE
            }

            // ── JUMPI(0x57) → pop 2, push 0 ──────────────────────────
            0x57 => {
                self.pop_shadow();
                self.pop_shadow();
                NO_NODE
            }

            // ── JUMPDEST(0x5b) → nop ──────────────────────────────────
            0x5b => NO_NODE,

            // ── TLOAD(0x5c) → pop 1, push 1 ──────────────────────────
            0x5c => {
                let key_n = self.pop_shadow();
                let key = stack.last().copied().unwrap_or_default();
                let mut parents = vec![key_n];
                if let Some(&t_n) = self.shadow_transient.get(&(address, key)) {
                    parents.push(t_n);
                }
                let nid = self.alloc_node(gs, pc32, opcode, parents);
                self.push_shadow(nid);
                nid
            }

            // ── TSTORE(0x5d) → pop 2, push 0 ─────────────────────────
            0x5d => {
                let key_n = self.pop_shadow();
                let value_n = self.pop_shadow();
                let key = stack.last().copied().unwrap_or_default();
                let nid = self.alloc_node(gs, pc32, opcode, vec![key_n, value_n]);
                self.shadow_transient.insert((address, key), nid);
                nid
            }

            // ── MCOPY(0x5e) → pop 3, push 0 ──────────────────────────
            0x5e => {
                let dst_n = self.pop_shadow();
                let src_n = self.pop_shadow();
                let size_n = self.pop_shadow();
                let dst = Self::stack_val(stack, 0);
                let src = Self::stack_val(stack, 1);
                let size = Self::stack_val(stack, 2);
                // 先读源内存的影子，然后写到目标
                let src_shadow = self.memory_slice(src, size);
                let mut parents = vec![dst_n, src_n, size_n];
                let mut seen = HashSet::new();
                for &nid in &src_shadow {
                    if nid != NO_NODE {
                        seen.insert(nid);
                    }
                }
                parents.extend(seen);
                let nid = self.alloc_node(gs, pc32, opcode, parents);
                // 逐字节写入目标（保留源的颗粒度）
                {
                    let frame = self.current_frame_mut();
                    let end_offset = dst.saturating_add(size);
                    // 检查是否超出合理范围
                    if dst >= MAX_REASONABLE_MEMORY_OFFSET {
                        // 超出范围，不处理
                    } else if end_offset <= MAX_REASONABLE_MEMORY_OFFSET {
                        // 在合理范围内，才执行复制
                        if end_offset > frame.shadow_memory.len() {
                            frame.shadow_memory.resize(end_offset, NO_NODE);
                        }
                        for i in 0..size {
                            let idx = dst + i;
                            if idx < frame.shadow_memory.len() {
                                frame.shadow_memory[idx] = src_shadow.get(i).copied().unwrap_or(NO_NODE);
                            }
                        }
                    }
                }
                nid
            }

            // ── DUP1..DUP16 (0x80..0x8f) → 复制栈值 ──────────────────
            0x80..=0x8f => {
                let depth = (opcode - 0x80 + 1) as usize;
                let ss = &self.current_frame().shadow_stack;
                let nid = if depth <= ss.len() {
                    ss[ss.len() - depth]
                } else {
                    NO_NODE
                };
                self.push_shadow(nid);
                NO_NODE // DUP 不创建新节点
            }

            // ── SWAP1..SWAP16 (0x90..0x9f) → 交换栈值 ─────────────────
            0x90..=0x9f => {
                let depth = (opcode - 0x90 + 1) as usize;
                let ss = &mut self.current_frame_mut().shadow_stack;
                let len = ss.len();
                if depth < len {
                    ss.swap(len - 1, len - 1 - depth);
                }
                NO_NODE // SWAP 不创建新节点
            }

            // ── LOG0..LOG4 (0xa0..0xa4) → pop 2+n, push 0 ────────────
            0xa0..=0xa4 => {
                let n_topics = (opcode - 0xa0) as usize;
                // pop offset, size, then topics
                for _ in 0..(2 + n_topics) {
                    self.pop_shadow();
                }
                NO_NODE
            }

            // ── RETURN(0xf3) / REVERT(0xfd) → pop 2, 准备返回数据影子 ─
            0xf3 | 0xfd => {
                let offset_n = self.pop_shadow();
                let size_n = self.pop_shadow();
                let offset = Self::stack_val(stack, 0);
                let size = Self::stack_val(stack, 1);
                // 保存返回数据的影子到当前帧
                let ret_shadow = self.memory_slice(offset, size);
                self.current_frame_mut().prepared_return_shadow = ret_shadow;
                let nid = self.alloc_node(gs, pc32, opcode, vec![offset_n, size_n]);
                nid
            }

            // ── CALL(0xf1) / CALLCODE(0xf2) → pop 7 ──────────────────
            0xf1 | 0xf2 => {
                // 先读取参数，再 pop，保持与 EVM 栈索引一致
                let args_offset = Self::stack_val(stack, 3);
                let args_size = Self::stack_val(stack, 4);
                let mut parents = Vec::with_capacity(7);
                for _ in 0..7 {
                    parents.push(self.pop_shadow());
                }
                // 预计算子帧的 calldata 影子（来自父帧内存）
                self.pending_calldata_shadow = Some(self.memory_slice(args_offset, args_size));

                let nid = self.alloc_node(gs, pc32, opcode, parents);
                // 记录返回节点，待 pop_frame 时推入父帧栈顶
                self.pending_ret_stack.push((nid, gs));
                nid
            }

            // ── DELEGATECALL(0xf4) / STATICCALL(0xfa) → pop 6 ────────
            0xf4 | 0xfa => {
                // 参数位置在 pop 之前计算
                let args_offset = Self::stack_val(stack, 2);
                let args_size = Self::stack_val(stack, 3);
                let mut parents = Vec::with_capacity(6);
                for _ in 0..6 {
                    parents.push(self.pop_shadow());
                }
                // DELEGATECALL/STATICCALL 无 value 参数，offset 在 stack[2]
                self.pending_calldata_shadow = Some(self.memory_slice(args_offset, args_size));

                let nid = self.alloc_node(gs, pc32, opcode, parents);
                self.pending_ret_stack.push((nid, gs));
                nid
            }

            // ── CREATE(0xf0) → pop 3 ─────────────────────────────────
            0xf0 => {
                // 参数位置在 pop 之前计算
                let offset = Self::stack_val(stack, 1);
                let size = Self::stack_val(stack, 2);
                let mut parents = Vec::with_capacity(3);
                for _ in 0..3 {
                    parents.push(self.pop_shadow());
                }
                // init_code 来自内存
                self.pending_calldata_shadow = Some(self.memory_slice(offset, size));

                let nid = self.alloc_node(gs, pc32, opcode, parents);
                self.pending_ret_stack.push((nid, gs));
                nid
            }

            // ── CREATE2(0xf5) → pop 4 ────────────────────────────────
            0xf5 => {
                // 参数位置在 pop 之前计算
                let offset = Self::stack_val(stack, 1);
                let size = Self::stack_val(stack, 2);
                let mut parents = Vec::with_capacity(4);
                for _ in 0..4 {
                    parents.push(self.pop_shadow());
                }
                self.pending_calldata_shadow = Some(self.memory_slice(offset, size));

                let nid = self.alloc_node(gs, pc32, opcode, parents);
                self.pending_ret_stack.push((nid, gs));
                nid
            }

            // ── STOP(0x00) / INVALID(0xfe) / SELFDESTRUCT(0xff) ──────
            0x00 => NO_NODE,
            0xfe => NO_NODE,
            0xff => {
                self.pop_shadow(); // SELFDESTRUCT pops 1
                NO_NODE
            }

            // 未知 opcode：跳过
            _ => NO_NODE,
        };

        self.step_node_map[step_idx] = node_id;
        
        // 记录修改后的影子栈
        if let Some(frame) = self.frames.last() {
            self.debug_log(&format!("[shadow.on_step] 修改后影子栈深: {}", frame.shadow_stack.len()));
            self.debug_log(&format!("[shadow.on_step] 修改后影子栈内容: {:?}", frame.shadow_stack));
            self.debug_log(&format!("[shadow.on_step] 保存了快照到 step_stack_snapshots[gs={}]", gs));
            self.debug_log(&format!("[shadow.on_step] node_id={}, step_idx={}\n", node_id, step_idx));
            
            // 保存当前影子栈快照（post-phase）。
            // 对 CALL*/CREATE*，返回值在 pop_frame 中才 push 到父帧，因此这里延后补写。
            if !Self::is_deferred_post_snapshot_opcode(opcode) {
                self.step_stack_snapshots.insert(gs, frame.shadow_stack.clone());
            }
            // 保存执行前影子栈快照（pre-phase）
            self.step_stack_snapshots_pre.insert(gs, pre_shadow_stack);
            // 记录 frame 深度，供查询阶段做 frame 约束
            self.step_frame_depths.insert(gs, self.frames.len());
            self.step_frame_ids.insert(gs, frame_id);
            
            // 保存 EVM 栈（原始 U256，延迟到查询时再格式化）
            let evm_stack: Vec<U256> = stack.to_vec();
            self.step_evm_stacks.insert(gs, evm_stack);
        }
    }

    // ── 帧管理 ────────────────────────────────────────────────────────────

    /// 在 Inspector::call() / Inspector::create() 中调用
    ///
    /// - `calldata_size`: calldata 字节长度（首帧用于生成 TXINPUT 叶子节点）
    pub fn push_frame(&mut self, calldata_size: usize) {
        let calldata = self.pending_calldata_shadow.take().unwrap_or_else(|| {
            // 顶层帧（tx 级）：为每 32 字节创建一个 TXINPUT 叶子节点
            let mut shadow = vec![NO_NODE; calldata_size];
            let mut offset = 0;
            while offset < calldata_size {
                let nid = self.alloc_node(0, 0, 0xff, vec![]); // 0xff = 合成 TXINPUT 节点
                let end = (offset + 32).min(calldata_size);
                for i in offset..end {
                    shadow[i] = nid;
                }
                offset += 32;
            }
            shadow
        });
        self.frames.push(ShadowFrame::with_calldata(calldata));
    }

    /// 在 Inspector::call_end() / Inspector::create_end() 中调用
    ///
    /// - `ret_offset`, `ret_size`: 父帧中返回数据写入的 memory 区间
    /// - `output_len`: 实际返回数据长度
    pub fn pop_frame(&mut self, ret_offset: usize, ret_size: usize, output_len: usize) {
        let child = match self.frames.pop() {
            Some(f) => f,
            None => return,
        };

        // 把子帧的 return data shadow 保存到全局（供 RETURNDATACOPY 使用）
        self.return_data_shadow = child.prepared_return_shadow.clone();

        // 将返回数据的影子写入父帧的 shadow_memory
        let write_size = output_len.min(ret_size);
        if write_size > 0 && !child.prepared_return_shadow.is_empty() {
            // 检查写入范围是否合理，超出则忽略
            if ret_offset >= MAX_REASONABLE_MEMORY_OFFSET {
                // 超出范围，不处理
            } else {
                let end_offset = ret_offset.saturating_add(write_size);
                if end_offset <= MAX_REASONABLE_MEMORY_OFFSET {
                    let frame = self.current_frame_mut();
                    if end_offset > frame.shadow_memory.len() {
                        frame.shadow_memory.resize(end_offset, NO_NODE);
                    }
                    for i in 0..write_size {
                        let idx = ret_offset + i;
                        if idx < frame.shadow_memory.len() {
                            let nid = child
                                .prepared_return_shadow
                                .get(i)
                                .copied()
                                .unwrap_or(NO_NODE);
                            frame.shadow_memory[idx] = nid;
                        }
                    }
                }
            }
        }

        // 处理返回节点：追加返回数据来源，并推入父帧栈顶
        if let Some((call_nid, origin_step)) = self.pending_ret_stack.pop() {
            let call_nid_usize = call_nid as usize;
            if call_nid_usize < self.nodes.len() {
                // 收集返回数据中的唯一节点，追加为 CALL 节点的 parent
                let mut seen = HashSet::new();
                for &nid in &child.prepared_return_shadow {
                    if nid != NO_NODE {
                        seen.insert(nid);
                    }
                }
                let node = &mut self.nodes[call_nid_usize];
                node.parents.extend(seen);
            }
            // 立即推栈到父帧，避免 deferred_push 被覆盖的问题
            self.push_shadow(call_nid);
            let post_shadow = self.current_frame().shadow_stack.clone();
            self.step_stack_snapshots.insert(origin_step, post_shadow);
        }
    }

    /// 在 Inspector::step_end() 中调用，记录执行后 EVM 栈
    pub fn record_step_end_stack(&mut self, global_step: u32, stack: &[U256]) {
        let evm_stack: Vec<U256> = stack.to_vec();
        self.step_evm_stacks_post.insert(global_step, evm_stack);
    }

    // ── 查询接口 ──────────────────────────────────────────────────────────

    /// 从指定 global_step 开始，BFS 回溯所有祖先节点，返回排序后的 step 列表
    pub fn backward_slice(&self, global_step: u32) -> Vec<u32> {
        eprintln!("[shadow.backward_slice] called with global_step={}", global_step);
        eprintln!("[shadow.backward_slice] step_node_map.len()={}", self.step_node_map.len());
        
        let start_nid = match self.step_node_map.get(global_step as usize) {
            Some(&nid) if nid != NO_NODE => {
                eprintln!("[shadow.backward_slice] start_nid={} (NO_NODE={})", nid, NO_NODE);
                nid
            },
            Some(&_nid) => {
                eprintln!("[shadow.backward_slice] start_nid is NO_NODE at step {}", global_step);
                return vec![];
            },
            None => {
                eprintln!("[shadow.backward_slice] global_step {} out of range", global_step);
                return vec![];
            },
        };

        eprintln!("[shadow.backward_slice] nodes.len()={}", self.nodes.len());
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(start_nid);
        visited.insert(start_nid);

        let mut parent_count = 0;
        while let Some(nid) = queue.pop_front() {
            if let Some(node) = self.nodes.get(nid as usize) {
                eprintln!("[shadow.backward_slice] visiting node {} (pc={}, opcode={:02x}, parents={})", nid, node.pc, node.opcode, node.parents.len());
                for &parent in &node.parents {
                    if parent != NO_NODE && visited.insert(parent) {
                        queue.push_back(parent);
                        parent_count += 1;
                    }
                }
            } else {
                eprintln!("[shadow.backward_slice] node {} not found in nodes", nid);
            }
        }

        eprintln!("[shadow.backward_slice] visited {} nodes, {} new parents found", visited.len(), parent_count);
        let mut steps: Vec<u32> = visited
            .iter()
            .filter_map(|&nid| self.nodes.get(nid as usize).map(|n| n.global_step))
            .collect();
        steps.sort_unstable();
        steps.dedup();
        eprintln!("[shadow.backward_slice] final result: {} unique steps", steps.len());
        steps
    }

    /// 查询指定 step 指定栈位置的 backward slice
    /// stack_pos: 0 = 栈顶, 1 = 栈顶第二个, ...
    /// 返回沿着该值的所有祖先步骤
    pub fn backward_slice_at(&self, global_step: u32, stack_pos: usize) -> Vec<u32> {
        // 统一语义：global_step 直接对应 step_node_map[global_step]
        let query_step = global_step;
        
        // 打印查询步对应的 opcode 信息
        let opcode_info = if (query_step as usize) < self.step_node_map.len() {
            if let Some(&nid) = self.step_node_map.get(query_step as usize) {
                if nid != NO_NODE {
                    if let Some(node) = self.nodes.get(nid as usize) {
                        format!("opcode=0x{:02x}({})", node.opcode, self.opcode_to_name(node.opcode))
                    } else {
                        "node_not_found".to_string()
                    }
                } else {
                    "NO_NODE".to_string()
                }
            } else {
                "map_index_error".to_string()
            }
        } else {
            format!("index_out_of_range(map_len={})", self.step_node_map.len())
        };
        
        eprintln!(
            "[shadow.backward_slice_at] query: step={}, step_map[{}], {}, stack_pos={}",
            global_step, query_step, opcode_info, stack_pos
        );

        // 如果当前 step 有节点，从该节点开始追踪
        if let Some(&nid) = self.step_node_map.get(query_step as usize) {
            if nid != NO_NODE {
                if let Some(node) = self.nodes.get(nid as usize) {
                    eprintln!("[shadow.backward_slice_at] node id={}, pc=0x{:04x}, opcode=0x{:02x}", nid, node.pc, node.opcode);
                }
                return self.backward_slice_from_node(nid);
            }
        }

        // 如果当前 step 没节点，往前查找最近的有节点的 step
        eprintln!("[shadow.backward_slice_at] current step has no node, searching backwards...");
        for step in (0..=query_step).rev() {
            if let Some(&nid) = self.step_node_map.get(step as usize) {
                if nid != NO_NODE {
                    eprintln!(
                        "[shadow.backward_slice_at] found nearest node {} at step {}",
                        nid, step
                    );
                    return self.backward_slice_from_node(nid);
                }
            }
        }

        eprintln!("[shadow.backward_slice_at] no node found in entire history");
        vec![]
    }

    /// 从指定节点开始回溯所有祖先，返回步骤列表
    fn backward_slice_from_node(&self, start_nid: u32) -> Vec<u32> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(start_nid);
        visited.insert(start_nid);

        let mut parent_count = 0;
        while let Some(nid) = queue.pop_front() {
            if let Some(node) = self.nodes.get(nid as usize) {
                eprintln!(
                    "[shadow.backward_slice_from_node] visiting node {} (pc={}, parents={})",
                    nid, node.pc, node.parents.len()
                );
                for &parent in &node.parents {
                    if parent != NO_NODE && visited.insert(parent) {
                        queue.push_back(parent);
                        parent_count += 1;
                    }
                }
            }
        }

        eprintln!(
            "[shadow.backward_slice_from_node] visited {} nodes, {} parents",
            visited.len(),
            parent_count
        );
        let mut steps: Vec<u32> = visited
            .iter()
            .filter_map(|&nid| self.nodes.get(nid as usize).map(|n| n.global_step))
            .collect();
        steps.sort_unstable();
        steps.dedup();
        eprintln!("[shadow.backward_slice_from_node] 返回 {} 个步骤", steps.len());
        steps
    }

    /// 以树形结构返回数据流信息，用于前端显示
    pub fn backward_slice_tree(
        &self,
        global_step: u32,
        stack_depth: Option<u32>,
        value_hint: Option<&str>,
        phase: Option<&str>,
        frame_id: Option<u16>,
    ) -> Result<DataFlowTree, String> {
        // 统一语义：global_step 直接对应 step_node_map/global_step 快照。
        let query_step = global_step;
        let phase_norm = phase.unwrap_or("post").to_ascii_lowercase();
        let use_pre = phase_norm == "pre";
        let selected_snapshots = if use_pre {
            &self.step_stack_snapshots_pre
        } else {
            &self.step_stack_snapshots
        };
        let selected_evm_stacks = if use_pre {
            &self.step_evm_stacks
        } else {
            &self.step_evm_stacks_post
        };
        let target_step = if let Some(fid) = frame_id {
            (0..=query_step)
                .rev()
                .find(|s| self.step_frame_ids.get(s) == Some(&fid))
                .ok_or_else(|| format!("No step found for frame_id={} at/before step {}", fid, query_step))?
        } else {
            query_step
        };
        let frame_start_step = frame_id.and_then(|fid| {
            (0..=target_step)
                .find(|s| self.step_frame_ids.get(s) == Some(&fid))
        });
        
        // 打印查询步对应的 opcode 信息
        let opcode_info = if (query_step as usize) < self.step_node_map.len() {
            if let Some(&nid) = self.step_node_map.get(query_step as usize) {
                if nid != NO_NODE {
                    if let Some(node) = self.nodes.get(nid as usize) {
                        format!("opcode=0x{:02x}({})", node.opcode, self.opcode_to_name(node.opcode))
                    } else {
                        "node_not_found".to_string()
                    }
                } else {
                    "NO_NODE".to_string()
                }
            } else {
                "map_index_error".to_string()
            }
        } else {
            format!("index_out_of_range(map_len={})", self.step_node_map.len())
        };
        
        eprintln!(
            "[shadow.backward_slice_tree] query: step={}, step_map[{}], {}, phase={}, frame_id={:?}, target_step={}",
            global_step, query_step, opcode_info, if use_pre { "pre" } else { "post" }, frame_id, target_step
        );
        
        eprintln!("[shadow.backward_slice_tree] ========== 开始构建数据流树 ==========");
        eprintln!("[shadow.backward_slice_tree] 准备执行步骤: {} (查询 step_map[{}])", global_step, target_step);
        eprintln!("[shadow.backward_slice_tree] stack_depth={:?}, value_hint={:?}", stack_depth, value_hint);
        eprintln!("[shadow.backward_slice_tree] step_node_map 大小: {}", self.step_node_map.len());
        eprintln!(
            "[shadow.backward_slice_tree] snapshots(pre={}, post={}, selected={})",
            self.step_stack_snapshots_pre.len(),
            self.step_stack_snapshots.len(),
            selected_snapshots.len()
        );
        
        // 查找起点节点 ID
        let start_nid = if let Some(depth) = stack_depth {
            // 模式 1：按栈深度查询
            eprintln!("[shadow.backward_slice_tree] use stack_depth={} query", depth);
            eprintln!("[shadow.backward_slice_tree] 🔍 严格查询 step={} 的快照, depth={}", query_step, depth);
            
            // 查询 step 的 frame_depth，用于约束 frame 边界
            let query_frame_depth = self.step_frame_depths.get(&target_step).copied();
            eprintln!("[shadow.backward_slice_tree] step {} frame_depth={:?}", target_step, query_frame_depth);
            
            // 严格模式：只使用 target_step 当步快照，不向前回扫
            let step_frame_depth = self.step_frame_depths.get(&target_step).copied();
            if let (Some(step_depth), Some(query_depth)) = (step_frame_depth, query_frame_depth) {
                let depth_diff = (step_depth as i32) - (query_depth as i32);
                if depth_diff.abs() > 1 {
                    return Err(format!(
                        "Frame depth mismatch at step {}: {} vs {}",
                        target_step, step_depth, query_depth
                    ));
                }
            }

            let shadow_stack = selected_snapshots.get(&target_step).ok_or_else(|| {
                format!(
                    "No {}-phase shadow stack snapshot at step {}",
                    if use_pre { "pre" } else { "post" },
                    target_step
                )
            })?;
            let depth_usize = depth as usize;
            if depth_usize >= shadow_stack.len() {
                return Err(format!(
                    "Stack depth out of range at step {}: depth={}, stack_len={}",
                    target_step, depth, shadow_stack.len()
                ));
            }
            let stack_index = shadow_stack.len() - 1 - depth_usize;
            let nid = shadow_stack[stack_index];
            eprintln!(
                "[shadow.backward_slice_tree]   step={}: 栈长度={}, depth[{}]->idx[{}]=nid({}), NO_NODE={}",
                target_step, shadow_stack.len(), depth, stack_index, nid, NO_NODE
            );
            if nid == NO_NODE {
                return Err(format!(
                    "No data node at step {} stack depth {} (idx={})",
                    target_step, depth, stack_index
                ));
            }
            if let Some(hint) = value_hint {
                let evm_stack = selected_evm_stacks.get(&target_step).ok_or_else(|| {
                    format!(
                        "No {}-phase EVM stack snapshot at step {}",
                        if use_pre { "pre" } else { "post" },
                        target_step
                    )
                })?;
                if stack_index >= evm_stack.len() {
                    return Err(format!(
                        "EVM stack index out of range at step {}: idx={}, evm_stack_len={}",
                        target_step, stack_index, evm_stack.len()
                    ));
                }
                let hint_hex = hint
                    .strip_prefix("0x")
                    .or_else(|| hint.strip_prefix("0X"))
                    .unwrap_or(hint);
                let expected = U256::from_str_radix(hint_hex, 16).map_err(|e| {
                    format!("Invalid value hint at step {} depth {}: {}", target_step, depth, e)
                })?;
                let actual = evm_stack[stack_index];
                if actual != expected {
                    return Err(format!(
                        "Value hint mismatch at step {} depth {}: expected 0x{:064x}, actual 0x{:064x}",
                        target_step, depth, expected, actual
                    ));
                }
            }
            eprintln!(
                "[shadow.backward_slice_tree] found node at step={}, depth={}, idx={}, nid={}",
                target_step, depth, stack_index, nid
            );
            nid
        } else {
            // 模式 2：无栈深度时按 step_node_map 查询
            eprintln!("[shadow.backward_slice_tree] 没有 stack_depth，使用 step_node_map 查询...");
            
            if self.step_node_map.get(target_step as usize) == Some(&NO_NODE) {
                eprintln!("[shadow.backward_slice_tree] 步骤 {} 是 NO_NODE，向后搜索...", target_step);
                // 如果当前 step 是 NO_NODE，向后搜索
                let mut found_nid = None;
                for step in (0..=target_step).rev() {
                    if let Some(fid) = frame_id {
                        if self.step_frame_ids.get(&step) != Some(&fid) {
                            continue;
                        }
                    }
                    if let Some(&nid) = self.step_node_map.get(step as usize) {
                        if nid != NO_NODE {
                            found_nid = Some((nid, step));
                            eprintln!("[shadow.backward_slice_tree] 找到最近的数据节点: nid={} at step={}", nid, step);
                            break;
                        }
                    }
                }
                found_nid.ok_or_else(|| "No data node found for this step".to_string())?
                    .0
            } else {
                let nid = *self.step_node_map.get(target_step as usize)
                    .ok_or_else(|| "Step out of range".to_string())?;
                eprintln!("[shadow.backward_slice_tree] 步骤 {} 对应节点 ID: {}", target_step, nid);
                nid
            }
        };

        if let Some(root_node) = self.nodes.get(start_nid as usize) {
            eprintln!("[shadow.backward_slice_tree] 根节点: id={}, opcode={:02x}({}), pc=0x{:04x}", 
                start_nid, root_node.opcode, self.opcode_to_name(root_node.opcode), root_node.pc);
        }
        if let Some(fid) = frame_id {
            let root = self
                .nodes
                .get(start_nid as usize)
                .ok_or_else(|| format!("Root node {} not found", start_nid))?;
            let root_in_frame = self.step_frame_ids.get(&root.global_step) == Some(&fid);
            let root_is_calldata = root.opcode == 0xff;
            if !root_in_frame && !root_is_calldata {
                return Err(format!(
                    "Root node {} is outside frame {} and not calldata origin",
                    start_nid, fid
                ));
            }
        }

        // BFS 遍历，收集所有相关节点
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        queue.push_back(start_nid);
        visited.insert(start_nid);
        
        eprintln!("[shadow.backward_slice_tree] 开始 BFS 向上追踪...");
        let mut parent_count = 0;

        while let Some(nid) = queue.pop_front() {
            if let Some(node) = self.nodes.get(nid as usize) {
                eprintln!("[shadow.backward_slice_tree]   访问节点 id={}, step={}, parents={}", nid, node.global_step, node.parents.len());
                for &parent in &node.parents {
                    if parent == NO_NODE {
                        continue;
                    }
                    let Some(parent_node) = self.nodes.get(parent as usize) else {
                        continue;
                    };

                    if let Some(fid) = frame_id {
                        let in_frame = self.step_frame_ids.get(&parent_node.global_step) == Some(&fid);
                        let is_calldata = parent_node.opcode == 0xff;
                        let after_frame_start = frame_start_step
                            .is_none_or(|start| parent_node.global_step >= start);
                        if !(is_calldata || (in_frame && after_frame_start)) {
                            continue;
                        }
                    }

                    if visited.insert(parent) {
                        if parent_node.opcode != 0xff {
                            queue.push_back(parent);
                        }
                        parent_count += 1;
                    }
                }
            }
        }
        
        eprintln!("[shadow.backward_slice_tree] BFS 完成: 访问了 {} 个节点，发现 {} 个父节点", visited.len(), parent_count);

        // 构建 DataNodeInfo 列表
        let mut nodes = Vec::new();
        for &nid in &visited {
            if let Some(node) = self.nodes.get(nid as usize) {
                let opcode_name = self.opcode_to_name(node.opcode);
                let stack_value_post = self
                    .step_stack_snapshots
                    .get(&node.global_step)
                    .and_then(|ss| {
                        self.step_evm_stacks_post
                            .get(&node.global_step)
                            .and_then(|evm| {
                                ss.iter()
                                    .rposition(|&id| id == nid)
                                    .and_then(|idx| evm.get(idx).copied())
                                    .map(|v| format!("0x{:064x}", v))
                            })
                    });
                nodes.push(DataNodeInfo {
                    id: nid,
                    global_step: node.global_step,
                    pc: node.pc,
                    opcode: node.opcode,
                    opcode_name,
                    parent_ids: node
                        .parents
                        .iter()
                        .copied()
                        .filter(|pid| *pid != NO_NODE && visited.contains(pid))
                        .collect(),
                    stack_value_post,
                });
            }
        }

        // 按 global_step 排序
        nodes.sort_by_key(|n| n.global_step);
        
        eprintln!("[shadow.backward_slice_tree] build done: {} nodes", nodes.len());
        eprintln!("[shadow.backward_slice_tree] ========== 构建数据流树结束 ==========");

        Ok(DataFlowTree {
            root_id: start_nid,
            nodes,
        })
    }

    /// opcode 到助记符的映射
    fn opcode_to_name(&self, opcode: u8) -> String {
        match opcode {
            0x00 => "STOP".to_string(),
            0x01 => "ADD".to_string(),
            0x02 => "MUL".to_string(),
            0x03 => "SUB".to_string(),
            0x04 => "DIV".to_string(),
            0x05 => "SDIV".to_string(),
            0x06 => "MOD".to_string(),
            0x07 => "SMOD".to_string(),
            0x08 => "ADDMOD".to_string(),
            0x09 => "MULMOD".to_string(),
            0x0a => "EXP".to_string(),
            0x0b => "SIGNEXTEND".to_string(),
            0x10 => "LT".to_string(),
            0x11 => "GT".to_string(),
            0x12 => "SLT".to_string(),
            0x13 => "SGT".to_string(),
            0x14 => "EQ".to_string(),
            0x15 => "ISZERO".to_string(),
            0x16 => "AND".to_string(),
            0x17 => "OR".to_string(),
            0x18 => "XOR".to_string(),
            0x19 => "NOT".to_string(),
            0x1a => "BYTE".to_string(),
            0x1b => "SHL".to_string(),
            0x1c => "SHR".to_string(),
            0x1d => "SAR".to_string(),
            0x20 => "SHA3".to_string(),
            0x21 => "KECCAK256".to_string(),
            0x30 => "ADDRESS".to_string(),
            0x31 => "BALANCE".to_string(),
            0x32 => "ORIGIN".to_string(),
            0x33 => "CALLER".to_string(),
            0x34 => "CALLVALUE".to_string(),
            0x35 => "CALLDATALOAD".to_string(),
            0x36 => "CALLDATASIZE".to_string(),
            0x37 => "CALLDATACOPY".to_string(),
            0x38 => "CODESIZE".to_string(),
            0x39 => "CODECOPY".to_string(),
            0x3a => "GASPRICE".to_string(),
            0x3b => "EXTCODESIZE".to_string(),
            0x3c => "EXTCODECOPY".to_string(),
            0x3d => "RETURNDATASIZE".to_string(),
            0x3e => "RETURNDATACOPY".to_string(),
            0x3f => "EXTCODEHASH".to_string(),
            0x40 => "BLOCKHASH".to_string(),
            0x41 => "COINBASE".to_string(),
            0x42 => "TIMESTAMP".to_string(),
            0x43 => "NUMBER".to_string(),
            0x44 => "DIFFICULTY".to_string(),
            0x45 => "GASLIMIT".to_string(),
            0x46 => "CHAINID".to_string(),
            0x47 => "SELFBALANCE".to_string(),
            0x48 => "BASEFEE".to_string(),
            0x50 => "POP".to_string(),
            0x51 => "MLOAD".to_string(),
            0x52 => "MSTORE".to_string(),
            0x53 => "MSTORE8".to_string(),
            0x54 => "SLOAD".to_string(),
            0x55 => "SSTORE".to_string(),
            0x56 => "JUMP".to_string(),
            0x57 => "JUMPI".to_string(),
            0x58 => "PC".to_string(),
            0x59 => "MSIZE".to_string(),
            0x5a => "GAS".to_string(),
            0x5b => "JUMPDEST".to_string(),
            0x5c => "TLOAD".to_string(),
            0x5d => "TSTORE".to_string(),
            0x5e => "MCOPY".to_string(),
            0x5f => "PUSH0".to_string(),
            0x60 => "PUSH1".to_string(),
            0x61 => "PUSH2".to_string(),
            0x62 => "PUSH3".to_string(),
            0x63 => "PUSH4".to_string(),
            0x64 => "PUSH5".to_string(),
            0x65 => "PUSH6".to_string(),
            0x66 => "PUSH7".to_string(),
            0x67 => "PUSH8".to_string(),
            0x68 => "PUSH9".to_string(),
            0x69 => "PUSH10".to_string(),
            0x6a => "PUSH11".to_string(),
            0x6b => "PUSH12".to_string(),
            0x6c => "PUSH13".to_string(),
            0x6d => "PUSH14".to_string(),
            0x6e => "PUSH15".to_string(),
            0x6f => "PUSH16".to_string(),
            0x70 => "PUSH17".to_string(),
            0x71 => "PUSH18".to_string(),
            0x72 => "PUSH19".to_string(),
            0x73 => "PUSH20".to_string(),
            0x74 => "PUSH21".to_string(),
            0x75 => "PUSH22".to_string(),
            0x76 => "PUSH23".to_string(),
            0x77 => "PUSH24".to_string(),
            0x78 => "PUSH25".to_string(),
            0x79 => "PUSH26".to_string(),
            0x7a => "PUSH27".to_string(),
            0x7b => "PUSH28".to_string(),
            0x7c => "PUSH29".to_string(),
            0x7d => "PUSH30".to_string(),
            0x7e => "PUSH31".to_string(),
            0x7f => "PUSH32".to_string(),
            0x80 => "DUP1".to_string(),
            0x81 => "DUP2".to_string(),
            0x82 => "DUP3".to_string(),
            0x83 => "DUP4".to_string(),
            0x84 => "DUP5".to_string(),
            0x85 => "DUP6".to_string(),
            0x86 => "DUP7".to_string(),
            0x87 => "DUP8".to_string(),
            0x88 => "DUP9".to_string(),
            0x89 => "DUP10".to_string(),
            0x8a => "DUP11".to_string(),
            0x8b => "DUP12".to_string(),
            0x8c => "DUP13".to_string(),
            0x8d => "DUP14".to_string(),
            0x8e => "DUP15".to_string(),
            0x8f => "DUP16".to_string(),
            0x90 => "SWAP1".to_string(),
            0x91 => "SWAP2".to_string(),
            0x92 => "SWAP3".to_string(),
            0x93 => "SWAP4".to_string(),
            0x94 => "SWAP5".to_string(),
            0x95 => "SWAP6".to_string(),
            0x96 => "SWAP7".to_string(),
            0x97 => "SWAP8".to_string(),
            0x98 => "SWAP9".to_string(),
            0x99 => "SWAP10".to_string(),
            0x9a => "SWAP11".to_string(),
            0x9b => "SWAP12".to_string(),
            0x9c => "SWAP13".to_string(),
            0x9d => "SWAP14".to_string(),
            0x9e => "SWAP15".to_string(),
            0x9f => "SWAP16".to_string(),
            0xa0 => "LOG0".to_string(),
            0xa1 => "LOG1".to_string(),
            0xa2 => "LOG2".to_string(),
            0xa3 => "LOG3".to_string(),
            0xa4 => "LOG4".to_string(),
            0xf0 => "CREATE".to_string(),
            0xf1 => "CALL".to_string(),
            0xf2 => "CALLCODE".to_string(),
            0xf3 => "RETURN".to_string(),
            0xf4 => "DELEGATECALL".to_string(),
            0xf5 => "CREATE2".to_string(),
            0xfa => "STATICCALL".to_string(),
            0xfd => "REVERT".to_string(),
            0xfe => "SELFDESTRUCT".to_string(),
            0xff => "TXINPUT".to_string(),
            _ => format!("UNKNOWN(0x{:02x})", opcode),
        }
    }


    /// 返回节点总数（用于前端显示/调试）
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn snapshot_count(&self) -> usize {
        self.step_stack_snapshots.len()
    }

    /// 打印指定范围步骤的调试信息（用于诊断步骤是否被跳过）
    /// 
    /// 会输出到 console（eprintln!），包含：
    /// - step_idx：步骤编号
    /// - opcode：操作码及其名称
    /// - pc：程序计数器
    /// - node_id：节点编号
    /// - 影子栈信息：深度和内容快照
    pub fn debug_steps(&self, start_step: usize, end_step: usize) {
        eprintln!("\n[shadow.debug_steps] ========== 诊断步骤范围: {} - {} ==========", start_step, end_step);
        eprintln!("[shadow.debug_steps] step_node_map.len() = {}", self.step_node_map.len());
        eprintln!("[shadow.debug_steps] step_stack_snapshots.len() = {}", self.step_stack_snapshots.len());
        eprintln!("[shadow.debug_steps] nodes.len() = {}", self.nodes.len());
        
        for step_idx in start_step..=end_step {
            eprintln!("\n[shadow.debug_steps] ========== 步骤 {} ==========", step_idx);
            
            // 检查该 step 是否在 step_node_map 中
            if step_idx >= self.step_node_map.len() {
                eprintln!("[shadow.debug_steps] ❌ 超出范围：step_node_map.len()={}", self.step_node_map.len());
                continue;
            }
            
            let node_id = self.step_node_map[step_idx];
            let has_snapshot = self.step_stack_snapshots.contains_key(&(step_idx as u32));
            let has_pre_snapshot = self.step_stack_snapshots_pre.contains_key(&(step_idx as u32));
            
            if node_id == NO_NODE {
                // 区分：有快照但 NO_NODE = 合法，无快照且 NO_NODE = 被跳过
                if has_snapshot || has_pre_snapshot {
                    eprintln!("[shadow.debug_steps] ⚠️  NO_NODE（合法操作，如 JUMP/JUMPI/JUMPDEST 等）");
                } else {
                    eprintln!("[shadow.debug_steps] ❌ NO_NODE + 无快照（步骤被跳过或未被 on_step 调用）");
                }
            } else {
                // 从 nodes 中恢复信息
                if (node_id as usize) < self.nodes.len() {
                    let node = &self.nodes[node_id as usize];
                    eprintln!("[shadow.debug_steps] node_id={}, pc=0x{:04x}, opcode=0x{:02x}({})", 
                        node_id, node.pc, node.opcode, self.opcode_to_name(node.opcode));
                    eprintln!("[shadow.debug_steps] node.global_step={}, node.parents.len()={}", 
                        node.global_step, node.parents.len());
                } else {
                    eprintln!("[shadow.debug_steps] ❌ node_id={} 但 nodes.len()={}（内部错误）", 
                        node_id, self.nodes.len());
                }
            }
            
            // 从快照中恢复影子栈信息
            if let Some(shadow_stack) = self.step_stack_snapshots.get(&(step_idx as u32)) {
                eprintln!("[shadow.debug_steps] 影子栈深: {}", shadow_stack.len());
                eprintln!("[shadow.debug_steps] 影子栈内容: {:?}", shadow_stack);
            } else {
                eprintln!("[shadow.debug_steps] ⚠️  无影子栈快照（可能步骤未被 on_step 调用）");
            }
            if let Some(shadow_stack_pre) = self.step_stack_snapshots_pre.get(&(step_idx as u32)) {
                eprintln!("[shadow.debug_steps] pre影子栈深: {}", shadow_stack_pre.len());
                eprintln!("[shadow.debug_steps] pre影子栈内容: {:?}", shadow_stack_pre);
            } else {
                eprintln!("[shadow.debug_steps] ⚠️  无pre影子栈快照");
            }
            
            // 打印 frame_depth 信息
            if let Some(frame_depth) = self.step_frame_depths.get(&(step_idx as u32)) {
                eprintln!("[shadow.debug_steps] frame_depth: {}", frame_depth);
            }
            
            // 打印 EVM 栈信息
            if let Some(evm_stack) = self.step_evm_stacks.get(&(step_idx as u32)) {
                eprintln!("[shadow.debug_steps] EVM栈深: {}", evm_stack.len());
                for (i, val) in evm_stack.iter().enumerate() {
                    eprintln!("[shadow.debug_steps]   [{}]: 0x{:064x}", i, val);
                }
            } else {
                eprintln!("[shadow.debug_steps] ⚠️  无EVM栈快照");
            }
        }
        
        eprintln!("\n[shadow.debug_steps] ========== 诊断完成 ==========\n");
    }

    /// 导出所有步骤的影子信息到tmp文件
    pub fn export_all_steps_to_file(&self) -> Result<String, std::io::Error> {
        use std::fs::File;
        use std::io::{BufWriter, Write};
        
        let file_name = format!("optrace_shadow_steps_{}.txt", 
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs());
        
        let file_path = self.temp_dir.join(&file_name);
        let file = File::create(&file_path)?;
        let mut file = BufWriter::new(file);

        let fmt_u256 = |v: U256| -> String { format!("0x{:064x}", v) };
        let fmt_stack_compact = |stack: &[U256]| -> String {
            const PREVIEW: usize = 6;
            if stack.len() <= PREVIEW {
                return stack.iter().map(|v| fmt_u256(*v)).collect::<Vec<_>>().join(", ");
            }
            let head = stack
                .iter()
                .take(3)
                .map(|v| fmt_u256(*v))
                .collect::<Vec<_>>()
                .join(", ");
            let tail = stack
                .iter()
                .rev()
                .take(3)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .map(|v| fmt_u256(*v))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{head}, ... ({} items), ... {tail}", stack.len())
        };
        
        // 写文件头
        writeln!(file, "OpTrace - Shadow Stack Steps Export")?;
        writeln!(file, "==========================================")?;
        writeln!(file, "Total nodes: {}", self.nodes.len())?;
        writeln!(file, "Total steps tracked: {}", self.step_node_map.len())?;
        writeln!(file, "Shadow stack snapshots(post): {}", self.step_stack_snapshots.len())?;
        writeln!(file, "Shadow stack snapshots(pre): {}", self.step_stack_snapshots_pre.len())?;
        writeln!(file, "EVM stack snapshots: {}", self.step_evm_stacks.len())?;
        writeln!(file, "Export time: {}", 
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs())?;
        writeln!(file, "\n")?;
        
        // 导出所有step的信息
        for step_idx in 0..self.step_node_map.len() {
            let node_id = self.step_node_map[step_idx];
            let has_snapshot = self.step_stack_snapshots.contains_key(&(step_idx as u32));
            let has_pre_snapshot = self.step_stack_snapshots_pre.contains_key(&(step_idx as u32));
            
            writeln!(file, "========== Step {} ==========", step_idx)?;
            
            if node_id == NO_NODE {
                if has_snapshot || has_pre_snapshot {
                    writeln!(file, "NodeID: NO_NODE (合法操作，如 JUMP/JUMPI/JUMPDEST 等)")?;
                } else {
                    writeln!(file, "NodeID: NO_NODE (步骤被跳过或未被 on_step 调用)")?;
                }
            } else {
                if (node_id as usize) < self.nodes.len() {
                    let node = &self.nodes[node_id as usize];
                    writeln!(file, "NodeID: {}", node_id)?;
                    writeln!(file, "PC: 0x{:04x}", node.pc)?;
                    writeln!(file, "Opcode: 0x{:02x}({})", node.opcode, self.opcode_to_name(node.opcode))?;
                    writeln!(file, "GlobalStep: {}", node.global_step)?;
                    writeln!(file, "Parents: {:?}", node.parents)?;
                }
            }
            
            // 写影子栈信息
            if let Some(shadow_stack) = self.step_stack_snapshots.get(&(step_idx as u32)) {
                writeln!(file, "ShadowStackDepthPost: {}", shadow_stack.len())?;
                writeln!(file, "ShadowStackPost: {:?}", shadow_stack)?;
            } else {
                writeln!(file, "ShadowStackPost: <no snapshot>")?;
            }
            if let Some(shadow_stack_pre) = self.step_stack_snapshots_pre.get(&(step_idx as u32)) {
                writeln!(file, "ShadowStackDepthPre: {}", shadow_stack_pre.len())?;
                writeln!(file, "ShadowStackPre: {:?}", shadow_stack_pre)?;
            } else {
                writeln!(file, "ShadowStackPre: <no snapshot>")?;
            }
            
            // 写frame depth信息
            if let Some(frame_depth) = self.step_frame_depths.get(&(step_idx as u32)) {
                writeln!(file, "FrameDepth: {}", frame_depth)?;
            }
            
            // 写EVM栈信息（压缩预览，避免超大文件导致导出耗时过长）
            if let Some(evm_stack) = self.step_evm_stacks.get(&(step_idx as u32)) {
                writeln!(file, "EVMStackDepth: {}", evm_stack.len())?;
                writeln!(file, "EVMStackPreview: [{}]", fmt_stack_compact(evm_stack))?;
            } else {
                writeln!(file, "EVMStack: <no snapshot>")?;
            }
            
            writeln!(file)?;
        }
        
        file.flush()?;
        eprintln!("Shadow steps exported to: {}", file_path.display());
        
        Ok(file_path.to_string_lossy().into_owned())
    }

    /// 取出 ShadowState（用于存储到 DebugSession）
    pub fn take(self) -> Self {
        self
    }

    pub fn validate_step_consistency(&self, max_mismatches: usize) -> ShadowValidationReport {
        let limit = max_mismatches.max(1);
        let mut checked_steps = 0usize;
        let mut checked_slots = 0usize;
        let mut mismatch_count = 0usize;
        let mut mismatches: Vec<ShadowValidationMismatch> = Vec::new();
        let mut node_value_map: HashMap<NodeId, U256> = HashMap::new();

        let stack_effect = |opcode: u8| -> Option<(usize, usize)> {
            match opcode {
                0xf1 | 0xf2 => Some((7, 1)), // CALL / CALLCODE
                0xf4 | 0xfa => Some((6, 1)), // DELEGATECALL / STATICCALL
                0xf0 => Some((3, 1)),        // CREATE
                0xf5 => Some((4, 1)),        // CREATE2
                _ => None,
            }
        };

        for step_idx in 0..self.step_node_map.len() {
            let step = step_idx as u32;
            let Some(shadow_stack) = self.step_stack_snapshots.get(&step) else {
                continue;
            };
            checked_steps += 1;

            let (opcode, opcode_name) = match self.step_node_map.get(step_idx).copied() {
                Some(nid) if nid != NO_NODE => self
                    .nodes
                    .get(nid as usize)
                    .map(|n| (n.opcode, self.opcode_to_name(n.opcode)))
                    .unwrap_or((0xff, "UNKNOWN".to_string())),
                _ => (0xff, "NO_NODE".to_string()),
            };
            let frame_id = self.step_frame_ids.get(&step).copied();

            if Self::is_deferred_post_snapshot_opcode(opcode) {
                // CALL*/CREATE* 的 step_end 栈与最终父帧 post 栈不在同一时刻采样。
                // 对这些 opcode 只做长度校验：len(pre) - pop + push == len(shadow_post)。
                if let (Some(pre_evm), Some((pop_n, push_n))) =
                    (self.step_evm_stacks.get(&step), stack_effect(opcode))
                {
                    let expected_len = pre_evm.len().saturating_sub(pop_n) + push_n;
                    if shadow_stack.len() != expected_len {
                        mismatch_count += 1;
                        if mismatches.len() < limit {
                            mismatches.push(ShadowValidationMismatch {
                                step,
                                frame_id,
                                opcode,
                                opcode_name: opcode_name.clone(),
                                stack_index: 0,
                                shadow_id: NO_NODE,
                                expected_evm: format!("len={expected_len}"),
                                actual_shadow: format!("len={}", shadow_stack.len()),
                                reason: "len_mismatch_deferred".to_string(),
                            });
                        }
                    }
                }
                continue;
            }

            let Some(evm_stack) = self.step_evm_stacks_post.get(&step) else {
                continue;
            };

            if shadow_stack.len() != evm_stack.len() {
                mismatch_count += 1;
                if mismatches.len() < limit {
                    mismatches.push(ShadowValidationMismatch {
                        step,
                        frame_id,
                        opcode,
                        opcode_name: opcode_name.clone(),
                        stack_index: 0,
                        shadow_id: NO_NODE,
                        expected_evm: format!("len={}", evm_stack.len()),
                        actual_shadow: format!("len={}", shadow_stack.len()),
                        reason: "len_mismatch".to_string(),
                    });
                }
            }

            let compare_len = shadow_stack.len().min(evm_stack.len());
            for i in 0..compare_len {
                checked_slots += 1;
                let nid = shadow_stack[i];
                let evm_val = evm_stack[i];

                if nid == NO_NODE {
                    mismatch_count += 1;
                    if mismatches.len() < limit {
                        mismatches.push(ShadowValidationMismatch {
                            step,
                            frame_id,
                            opcode,
                            opcode_name: opcode_name.clone(),
                            stack_index: i,
                            shadow_id: NO_NODE,
                            expected_evm: format!("0x{:064x}", evm_val),
                            actual_shadow: "NO_NODE".to_string(),
                            reason: "no_node".to_string(),
                        });
                    }
                    continue;
                }

                match node_value_map.get(&nid).copied() {
                    Some(prev) if prev != evm_val => {
                        mismatch_count += 1;
                        if mismatches.len() < limit {
                            mismatches.push(ShadowValidationMismatch {
                                step,
                                frame_id,
                                opcode,
                                opcode_name: opcode_name.clone(),
                                stack_index: i,
                                shadow_id: nid,
                                expected_evm: format!("0x{:064x}", evm_val),
                                actual_shadow: format!("0x{:064x}", prev),
                                reason: "id_value_mismatch".to_string(),
                            });
                        }
                    }
                    None => {
                        node_value_map.insert(nid, evm_val);
                    }
                    _ => {}
                }
            }
        }

        ShadowValidationReport {
            checked_steps,
            checked_slots,
            mismatch_count,
            mismatches,
        }
    }
}
