mod op_trace;
mod optrace_journal;
mod analysis;
mod sourcify;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// 开始调试命令
#[tauri::command]
async fn op_trace(
    app_handle: tauri::AppHandle,
    tx: &str,
    tx_data: Option<op_trace::TxDebugData>,
    block_data: Option<op_trace::BlockDebugData>,
    rpc_url: String,
    use_alloy_cache: bool,
    use_prestate: bool,
    patches: Option<Vec<op_trace::fork::StatePatch>>,
    channel: Channel,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<(), String> {
    let session_arc = Arc::clone(&state.0);
    op_trace::op_trace(tx, tx_data, block_data, &rpc_url, use_alloy_cache, use_prestate, patches.unwrap_or_default(), channel, app_handle, session_arc)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// 
#[tauri::command]
async fn seek_to(
    index: usize,
    request_id: u32,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<serde_json::Value, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or("No debug session active")?;

    let result = op_trace::seek_to_impl(session, index)
        .ok_or_else(|| format!("Index {} out of range", index))?;

    // 返回 JSON，包含 request_id 供前端丢弃过期响应
    let mut json = serde_json::to_value(&result).map_err(|e| e.to_string())?;
    json["request_id"] = serde_json::Value::Number(request_id.into());
    Ok(json)
}

// 获取范围数据
#[tauri::command]
async fn range_full_data(
    start: usize,
    end: usize,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<serde_json::Value, String> {
    let session_arc = Arc::clone(&state.0);
    let (tx, rx) = std::sync::mpsc::channel::<Result<serde_json::Value, String>>();
    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            let guard = session_arc.lock().map_err(|e| e.to_string())?;
            let session = guard.as_ref().ok_or("No debug session active")?;
            let t0 = std::time::Instant::now();
            let data = op_trace::range_full_data_impl(session, start, end);
            println!(
                "[range_full_data] {}..{} → {} steps | {:.1}ms",
                start, end, data.len(), t0.elapsed().as_secs_f64() * 1000.0,
            );
            serde_json::to_value(&data).map_err(|e| e.to_string())
        })();
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| e.to_string())?
}

// 扫描PauseConv
#[tauri::command]
async fn scan_conditions(
    conditions: Vec<op_trace::ConditionGroup>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<serde_json::Value, String> {
    // 提前校验 session 存在
    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.as_ref().ok_or("No debug session active")?;
    }

    // 将 CPU 密集型扫描移到独立线程，避免阻塞 Tokio executor
    let session_arc = Arc::clone(&state.0);
    let (tx, rx) = std::sync::mpsc::channel::<Result<serde_json::Value, String>>();
    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            let guard = session_arc.lock().map_err(|e| e.to_string())?;
            let session = guard.as_ref().ok_or("No debug session active")?;
            let step_count = session.trace.len();
            let t0 = std::time::Instant::now();
            let hits = op_trace::scan_conditions_impl(session, &conditions);
            let scan_ms = t0.elapsed().as_secs_f64() * 1000.0;
            println!(
                "[scan_conditions] {} steps × {} groups → {} hits | scan {:.1}ms",
                step_count, conditions.len(), hits.len(), scan_ms,
            );
            serde_json::to_value(&hits).map_err(|e| e.to_string())
        })();
        let _ = tx.send(result);
    });

    rx.recv().map_err(|e| e.to_string())?
}


/// 全局取消标志
pub struct AnalysisCancelFlag(pub Arc<AtomicBool>);

// 执行分析脚本
#[tauri::command]
async fn run_analysis(
    script: String,
    filters: Option<analysis::RawFilters>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
    cancel_flag: tauri::State<'_, AnalysisCancelFlag>,
) -> Result<serde_json::Value, String> {
    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.as_ref().ok_or("No debug session active")?;
    }

    cancel_flag.0.store(false, Ordering::Relaxed);

    let session_arc = Arc::clone(&state.0);
    let cancelled = Arc::clone(&cancel_flag.0);
    let raw_filters = filters.unwrap_or_default();
    let (tx, rx) = std::sync::mpsc::channel::<Result<serde_json::Value, String>>();
    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            let guard = session_arc.lock().map_err(|e| e.to_string())?;
            let session = guard.as_ref().ok_or("No debug session active")?;
            let t0 = std::time::Instant::now();
            let res = analysis::run_analysis(session, &script, raw_filters, Arc::clone(&cancelled))?;
            println!(
                "[run_analysis] {} steps | {:.1}ms",
                session.trace.len(),
                t0.elapsed().as_secs_f64() * 1000.0,
            );
            Ok(res)
        })();
        let _ = tx.send(result);
    });
    rx.recv().map_err(|e| e.to_string())?
}

// 取消分析
#[tauri::command]
async fn cancel_analysis(
    cancel_flag: tauri::State<'_, AnalysisCancelFlag>,
) -> Result<(), String> {
    cancel_flag.0.store(true, Ordering::Relaxed);
    Ok(())
}

// 查找值在栈顶最后一次出现的全局步骤
#[tauri::command]
async fn find_value_origin(
    global_index: usize,
    value_hex: String,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<Option<usize>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let session = guard.as_ref().ok_or("No debug session active")?;
    let hex = value_hex.trim_start_matches("0x").trim_start_matches("0X");
    let value = revm::primitives::U256::from_str_radix(hex, 16)
        .map_err(|e| e.to_string())?;
    Ok(session.find_value_origin(global_index, value))
}

// 重置状态
#[tauri::command]
async fn reset_session(
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        *guard = None;
        println!("[reset] debug session released");
    }
    Ok(())
}

// 打开应用数据目录
#[tauri::command]
async fn open_app_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(op_trace::DebugSessionState(Arc::new(Mutex::new(None))))
        .manage(AnalysisCancelFlag(Arc::new(AtomicBool::new(false))))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, op_trace, seek_to, scan_conditions, range_full_data, run_analysis, cancel_analysis, find_value_origin, open_app_data_dir, reset_session, sourcify::sourcify_read_cache, sourcify::sourcify_write_cache])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
