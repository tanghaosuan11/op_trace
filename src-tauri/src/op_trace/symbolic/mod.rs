//! 符号执行模块 — 公共接口
//!
//! 完全独立于 ShadowState，不修改任何现有执行逻辑。
//!
//! 使用流程：
//! 1. 构建 `SymConfig`（指定哪些 calldata 字节是符号）
//! 2. 调用 `engine::replay_from_trace` 从已有 trace 数据重放符号引擎
//! 3. 用 `solver::build_smt2_query` 构建 SMT-LIB2 查询
//! 4. 调用 `solver::run_z3` 执行 Z3，得到 `SolverResult`

pub mod expr;
pub mod engine;
pub mod solver;
pub mod slicer;

pub use engine::replay_from_trace;
pub use solver::{SolverResult, SymGoal, build_smt2_query, run_z3, SolveExplain, explain_solve};
pub use solver::PathConstraint;
pub use slicer::{SymSource, slice_for_jumpi};

use serde::{Deserialize, Serialize};

/// 符号执行配置 — 指定哪些输入变量被视为符号
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SymConfig {
    /// calldata 中需要被符号化的位置
    ///
    /// 每项 `(offset, name)` 表示：CALLDATALOAD(offset) 返回符号变量 `name`
    ///
    /// 示例（ERC-20 transfer）：
    /// ```json
    /// [
    ///   [4,  "amount"],
    ///   [36, "recipient"]
    /// ]
    /// ```
    /// 注意：这里的 offset 是 `CALLDATALOAD` 指令的第一个字节偏移。
    /// ABI 编码中，函数选择器 4 字节后，第一个参数 CALLDATALOAD(4)，第二个 CALLDATALOAD(36)，etc.
    #[serde(default)]
    pub calldata_symbols: Vec<(usize, String)>,

    /// 是否将 CALLVALUE 视为符号
    #[serde(default)]
    pub callvalue_sym: bool,

    /// 是否将 CALLER（msg.sender）视为符号
    #[serde(default)]
    pub caller_sym: bool,

    /// 是否将 ORIGIN（tx.origin）视为符号
    #[serde(default)]
    pub origin_sym: bool,

    /// 是否将 TIMESTAMP（block.timestamp）视为符号
    #[serde(default)]
    pub timestamp_sym: bool,

    /// 是否将 NUMBER（block.number）视为符号
    #[serde(default)]
    pub block_number_sym: bool,

    /// 初始存储状态中被视为符号的 slot（仅用于尚未被 SSTORE 的 SLOAD）
    /// 每项 `(slot_hex64, name)`
    #[serde(default)]
    pub storage_symbols: Vec<(String, String)>,

    /// 反编译模式：把所有环境 opcode、子帧 CALLDATALOAD、未被写入的 SLOAD/TLOAD
    /// 一律合成为自由符号，保证 JUMPI 条件、tstore/sstore 的表达式尽量不丢失来源。
    /// 仅供 decompile 路径使用；SMT 求解侧不要开启（会引入无约束自由变量）。
    #[serde(default)]
    pub decompile_mode: bool,
}

impl Default for SymConfig {
    fn default() -> Self {
        Self {
            calldata_symbols: Vec::new(),
            callvalue_sym: false,
            caller_sym: false,
            origin_sym: false,
            timestamp_sym: false,
            block_number_sym: false,
            storage_symbols: Vec::new(),
            decompile_mode: false,
        }
    }
}
