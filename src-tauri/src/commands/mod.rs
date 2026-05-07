//! Tauri command handlers, split by domain.

pub mod session;
pub mod debug;
pub mod analysis_cmd;
pub mod shadow;
pub mod fork;
pub mod cfg;
pub mod symbolic;
pub mod data;
pub mod foundry;
pub mod decompile;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;

/// 分析任务取消标志
pub struct AnalysisCancelFlags(pub Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);
