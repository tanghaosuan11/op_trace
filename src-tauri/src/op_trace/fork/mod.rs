// What-If Fork 模块
// 在指定步修改 stack/memory 后重跑交易（假设执行）

pub mod fork_inspector;
mod fork_runner;

pub use fork_runner::{StatePatch};
