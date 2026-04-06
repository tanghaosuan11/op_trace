mod op_trace;
mod optrace_journal;
mod analysis;
mod sourcify;
mod scripts_fs;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;

fn resolve_required_session_id(
    session_id: Option<String>,
    session_id_camel: Option<String>,
    command: &str,
) -> Result<String, String> {
    let merged = session_id.or(session_id_camel);
    let sid = merged
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    sid.ok_or_else(|| format!("{command} requires session_id/sessionId"))
}

const SESSION_TTL_MS: u64 = 30 * 60 * 1000; // 30 minutes

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn cleanup_stale_sessions(
    sessions: &mut HashMap<String, op_trace::debug_session::SessionEntry>,
) -> usize {
    let now = now_ms();
    let before = sessions.len();
    sessions.retain(|_, e| {
        // 运行中的会话不清理
        if e.is_running {
            return true;
        }
        // 无 session 的空壳，或长时间未更新的会话可清理
        if e.session.is_none() {
            return false;
        }
        now.saturating_sub(e.updated_at_ms) <= SESSION_TTL_MS
    });
    before.saturating_sub(sessions.len())
}

fn get_session_by_sid<'a>(
    sessions: &'a HashMap<String, op_trace::debug_session::SessionEntry>,
    sid: &str,
) -> Result<&'a op_trace::debug_session::DebugSession, String> {
    if let Some(e) = sessions.get(sid) {
        if let Some(ref s) = e.session {
            return Ok(s);
        }
        if e.is_running {
            return Err(format!("Debug session is running for session_id={}", sid));
        }
        return Err(op_trace::debug_session::no_session_error(sid));
    }
    Err(op_trace::debug_session::no_session_error(sid))
}

fn get_session_mut_by_sid<'a>(
    sessions: &'a mut HashMap<String, op_trace::debug_session::SessionEntry>,
    sid: &str,
) -> Result<&'a mut op_trace::debug_session::DebugSession, String> {
    if let Some(e) = sessions.get_mut(sid) {
        if let Some(ref mut s) = e.session {
            return Ok(s);
        }
        if e.is_running {
            return Err(format!("Debug session is running for session_id={}", sid));
        }
        return Err(op_trace::debug_session::no_session_error(sid));
    }
    Err(op_trace::debug_session::no_session_error(sid))
}

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
    #[allow(non_snake_case)]
    txDataList: Option<Vec<op_trace::TxDebugData>>,
    block_data: Option<op_trace::BlockDebugData>,
    rpc_url: String,
    use_alloy_cache: bool,
    use_prestate: bool,
    enable_shadow: bool,
    readonly: Option<bool>,
    patches: Option<Vec<op_trace::fork::StatePatch>>,
    // 手填：true 时不按 tx 哈希拉链上交易，块环境来自 block_data
    hand_fill: Option<bool>,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    channel: Channel,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<(), String> {
    let session_arc = Arc::clone(&state.0);
    let sid = resolve_required_session_id(session_id, sessionId, "op_trace")?;
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let removed = cleanup_stale_sessions(&mut guard);
        if removed > 0 {
            println!("[session.gc] removed {} stale sessions before op_trace", removed);
        }
        let entry = guard.entry(sid.clone()).or_default();
        if entry.is_running {
            return Err(format!(
                "Debug session already running for session_id={}",
                sid
            ));
        }
        entry.is_running = true;
        entry.updated_at_ms = now_ms();
        entry.session = None;
        println!(
            "[session] start op_trace sid={} total_sessions={} running=true",
            sid,
            guard.len()
        );
    }
    if let Err(e) = op_trace::op_trace(
        tx,
        tx_data,
        txDataList,
        block_data,
        &rpc_url,
        use_alloy_cache,
        use_prestate,
        enable_shadow,
        readonly.unwrap_or(false),
        patches.unwrap_or_default(),
        hand_fill.unwrap_or(false),
        channel,
        app_handle,
        session_arc,
        Some(sid.clone()),
    )
    .await
    {
        let mut guard = state.0.lock().map_err(|le| le.to_string())?;
        if let Some(entry) = guard.get_mut(&sid) {
            entry.is_running = false;
            entry.updated_at_ms = now_ms();
        }
        println!(
            "[session] op_trace failed sid={} total_sessions={} running=false err={}",
            sid,
            guard.len(),
            e
        );
        return Err(e.to_string());
    }
    Ok(())
}

// 
#[tauri::command]
async fn seek_to(
    index: usize,
    request_id: u32,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<serde_json::Value, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let sid = resolve_required_session_id(session_id, sessionId, "seek_to")?;
    let session = get_session_by_sid(&guard, &sid)?;

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
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<serde_json::Value, String> {
    let session_arc = Arc::clone(&state.0);
    let sid = resolve_required_session_id(session_id, sessionId, "range_full_data")?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<serde_json::Value, String>>();
    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            let guard = session_arc.lock().map_err(|e| e.to_string())?;
            let session = get_session_by_sid(&guard, &sid)?;
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

/// 根据后端 DebugSession 完整 trace 校验 Fork 补丁（step 为 0-based 全局下标，与 patch.step_index 一致）
#[tauri::command]
fn validate_fork_patch(
    step_index: usize,
    kind: String,
    stack_pos: Option<usize>,
    mem_offset: Option<usize>,
    mem_hex: Option<String>,
    pc_hex: Option<String>,
    value_hex: Option<String>,
    storage_address_hex: Option<String>,
    storage_slot_hex: Option<String>,
    storage_value_hex: Option<String>,
    balance_address_hex: Option<String>,
    session_id: Option<String>,
    #[allow(non_snake_case)]
    sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let sid = resolve_required_session_id(session_id, sessionId, "validate_fork_patch")?;
    let session = get_session_by_sid(&guard, &sid)?;
    op_trace::fork::validate_fork_patch_impl(
        session,
        step_index,
        &kind,
        stack_pos,
        mem_offset,
        mem_hex.as_deref(),
        pc_hex.as_deref(),
        value_hex.as_deref(),
        storage_address_hex.as_deref(),
        storage_slot_hex.as_deref(),
        storage_value_hex.as_deref(),
        balance_address_hex.as_deref(),
    )
}

// 扫描PauseConv
#[tauri::command]
async fn scan_conditions(
    conditions: Vec<op_trace::ConditionGroup>,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    #[allow(non_snake_case)]
    transaction_id: Option<u32>,
    #[allow(non_snake_case)]
    transactionId: Option<u32>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<serde_json::Value, String> {
    let sid = resolve_required_session_id(session_id, sessionId, "scan_conditions")?;
    // 提前校验 session 存在
    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let _ = get_session_by_sid(&guard, &sid)?;
    }

    // CPU 密集型扫描放到独立线程
    let session_arc = Arc::clone(&state.0);
    let (tx, rx) = std::sync::mpsc::channel::<Result<serde_json::Value, String>>();
    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            let guard = session_arc.lock().map_err(|e| e.to_string())?;
            let session = get_session_by_sid(&guard, &sid)?;
            let step_count = session.trace.len();
            let t0 = std::time::Instant::now();
            let tid = transaction_id.or(transactionId);
            let hits = op_trace::scan_conditions_impl(session, &conditions, tid);
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


/// 分析任务取消标志
pub struct AnalysisCancelFlags(pub Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

// 执行分析脚本（transactionId / transaction_id 会并入 filters）
#[tauri::command]
async fn run_analysis(
    app: tauri::AppHandle,
    script: String,
    filters: Option<analysis::RawFilters>,
    chain_id: Option<String>,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    #[allow(non_snake_case)]
    transaction_id: Option<u32>,
    #[allow(non_snake_case)]
    transactionId: Option<u32>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
    cancel_flags: tauri::State<'_, AnalysisCancelFlags>,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let sid = resolve_required_session_id(session_id, sessionId, "run_analysis")?;
    {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let _ = get_session_by_sid(&guard, &sid)?;
    }

    let cancelled = {
        let mut guard = cancel_flags.0.lock().map_err(|e| e.to_string())?;
        let flag = guard
            .entry(sid.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone();
        flag.store(false, Ordering::Relaxed);
        flag
    };

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cid = chain_id.unwrap_or_default();

    // CPU 密集型分析放到独立线程

    let session_arc = Arc::clone(&state.0);
    let mut raw_filters = filters.unwrap_or_default();
    let tid = transaction_id.or(transactionId);
    if let Some(t) = tid {
        raw_filters.transaction_id = Some(t);
    }
    let (tx, rx) = std::sync::mpsc::channel::<Result<serde_json::Value, String>>();
    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            let guard = session_arc.lock().map_err(|e| e.to_string())?;
            let session = get_session_by_sid(&guard, &sid)?;
            let t0 = std::time::Instant::now();
            let res = analysis::run_analysis(session, &script, raw_filters, Arc::clone(&cancelled), app_data_dir, cid)?;
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
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    cancel_flags: tauri::State<'_, AnalysisCancelFlags>,
) -> Result<(), String> {
    let sid = resolve_required_session_id(session_id, sessionId, "cancel_analysis")?;
    let mut guard = cancel_flags.0.lock().map_err(|e| e.to_string())?;
    let flag = guard
        .entry(sid)
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone();
    flag.store(true, Ordering::Relaxed);
    Ok(())
}

// 构建 CFG（后端静态分块 + trace 映射）
#[tauri::command]
async fn build_cfg(
    transaction_id: u32,
    context_id: u16,
    only_executed: Option<bool>,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<serde_json::Value, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let sid = resolve_required_session_id(session_id, sessionId, "build_cfg")?;
    let session = get_session_mut_by_sid(&mut guard, &sid)?;
    let result = op_trace::cfg_builder::build_cfg_for_frame_cached(
        session,
        transaction_id,
        context_id,
        only_executed.unwrap_or(true),
    )?;
    serde_json::to_value(&result).map_err(|e| e.to_string())
}

// 查找值在栈顶最后一次出现的全局步骤
#[tauri::command]
async fn find_value_origin(
    global_index: usize,
    value_hex: String,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<Option<usize>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let sid = resolve_required_session_id(session_id, sessionId, "find_value_origin")?;
    let session = get_session_by_sid(&guard, &sid)?;
    let hex = value_hex.trim_start_matches("0x").trim_start_matches("0X");
    let value = revm::primitives::U256::from_str_radix(hex, 16)
        .map_err(|e| e.to_string())?;
    Ok(session.find_value_origin(global_index, value))
}

// 重置状态
#[tauri::command]
async fn reset_session(
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
    cancel_flags: tauri::State<'_, AnalysisCancelFlags>,
) -> Result<(), String> {
    let sid = resolve_required_session_id(session_id, sessionId, "reset_session")?;
    let now = now_ms();
    let removed_session = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        let removed = cleanup_stale_sessions(&mut guard);
        if removed > 0 {
            println!("[session.gc] removed {} stale sessions before reset", removed);
        }
        guard.remove(&sid)
    };
    let removed_cancel_flag = {
        let mut cguard = cancel_flags.0.lock().map_err(|e| e.to_string())?;
        cguard.remove(&sid)
    };
    if removed_session.is_some() || removed_cancel_flag.is_some() {
        let sid_for_log = sid.clone();
        // 后台释放重资源，缩短 reset IPC 的阻塞时间
        std::thread::spawn(move || {
            drop(removed_session);
            drop(removed_cancel_flag);
            println!("[reset] debug session released: {}", sid_for_log);
        });
    } else {
        println!("[reset] no session found for sid={} at {}", sid, now);
    }
    Ok(())
}

/// 解析调试 tab：`frame-{transaction_id}-{context_id}` 或旧版 `frame-{context_id}`（单笔）。
fn parse_frame_tab_id(raw: &str) -> (Option<u16>, Option<u32>) {
    let rest = match raw.trim().strip_prefix("frame-") {
        Some(r) => r,
        None => return (None, None),
    };
    let mut parts = rest.splitn(2, '-');
    let first = parts.next().unwrap_or("");
    match parts.next() {
        Some(second) => {
            if let (Ok(tid), Ok(cid)) = (first.parse::<u32>(), second.parse::<u16>()) {
                return (Some(cid), Some(tid));
            }
        }
        None => {
            if let Ok(n) = first.parse::<u16>() {
                return (Some(n), None);
            }
        }
    }
    (None, None)
}

/// 返回数据流树形结构，用于前端显示
#[tauri::command]
async fn backward_slice_tree(
    global_step: u32,
    stack_depth: Option<u32>,
    value_hint: Option<String>,
    phase: Option<String>,
    frame_id: Option<String>,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<op_trace::shadow::DataFlowTree, String> {
    eprintln!("[backward_slice_tree] ========== 数据流查询开始 ==========");
    eprintln!("[backward_slice_tree] 全局步骤: {}", global_step);
    eprintln!("[backward_slice_tree] ❗ 栈深度(原始): {:?}", stack_depth);
    eprintln!("[backward_slice_tree] 数值: {:?}", value_hint);
    eprintln!("[backward_slice_tree] phase: {:?}", phase);
    eprintln!("[backward_slice_tree] frame_id(raw): {:?}", frame_id);
    
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let sid = resolve_required_session_id(session_id, sessionId, "backward_slice_tree")?;
    let session = get_session_by_sid(&guard, &sid)?;
    let shadow = session.shadow.as_ref().ok_or("Shadow state not available")?;
    
    eprintln!("[backward_slice_tree] shadow 节点总数: {}", shadow.node_count());
    eprintln!(
        "[backward_slice_tree] 📍 即将调用backward_slice_tree: global_step={}, stack_depth={:?}, phase={:?}, frame_id={:?}",
        global_step, stack_depth, phase, frame_id
    );
    
    let value_hint_str = value_hint.as_deref();
    let phase_str = phase.as_deref();
    let (frame_id_num, frame_tx_filter) = frame_id
        .as_deref()
        .map(parse_frame_tab_id)
        .unwrap_or((None, None));
    let result = shadow.backward_slice_tree(
        global_step,
        stack_depth,
        value_hint_str,
        phase_str,
        frame_id_num,
        frame_tx_filter,
    )?;
    
    eprintln!("[backward_slice_tree] ✓ 查询完成: {} 个节点", result.nodes.len());
    eprintln!("[backward_slice_tree] ========== 数据流查询结束 ==========");
    
    Ok(result)
}

/// 打印指定范围步骤的详细调试信息
#[tauri::command]
async fn debug_shadow_steps(
    start: u32,
    end: u32,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let sid = resolve_required_session_id(session_id, sessionId, "debug_shadow_steps")?;
    let session = get_session_by_sid(&guard, &sid)?;
    let shadow = session.shadow.as_ref().ok_or("Shadow state not available")?;
    
    shadow.debug_steps(start as usize, end as usize);
    Ok(format!("已打印步骤 {} 到 {} 的调试信息到控制台", start, end))
}

/// 导出所有步骤的影子信息到tmp文件
#[tauri::command]
async fn export_all_shadow_steps(
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let sid = resolve_required_session_id(session_id, sessionId, "export_all_shadow_steps")?;
    let session = get_session_by_sid(&guard, &sid)?;
    let shadow = session.shadow.as_ref().ok_or("Shadow state not available")?;
    
    let file_path = shadow.export_all_steps_to_file()
        .map_err(|e| format!("Failed to export shadow steps: {}", e))?;
    
    Ok(file_path)
}

#[tauri::command]
async fn validate_shadow_steps(
    max_mismatches: Option<usize>,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<op_trace::shadow::ShadowValidationReport, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let sid = resolve_required_session_id(session_id, sessionId, "validate_shadow_steps")?;
    let session = get_session_by_sid(&guard, &sid)?;
    let shadow = session.shadow.as_ref().ok_or("Shadow state not available")?;
    Ok(shadow.validate_step_consistency(max_mismatches.unwrap_or(200)))
}


/// 代理请求 eth-labels.com API，绕过浏览器 CORS 限制
#[tauri::command]
async fn fetch_address_labels(address: String) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("https://eth-labels.com/labels/{}", address.to_lowercase());
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    
    let response = client
        .get(&url)
        .header("User-Agent", "OpTrace-Debugger/1.0")
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if !response.status().is_success() {
        return Ok(Vec::new()); // 返回空数组表示无标签
    }

    let labels: Vec<serde_json::Value> = response
        .json()
        .await
        .unwrap_or_default();

    Ok(labels)
}

// 打开应用数据目录
#[tauri::command]
async fn open_app_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

/// 保存数据到 {app_data_dir}/save_data/{chain_id}/{filename}。
/// 若同名文件已存在，在扩展名前插入时间戳（如 foo.1711234567890.json）。
/// 返回实际写入的完整路径。
#[tauri::command]
async fn save_data(
    app: tauri::AppHandle,
    chain_id: String,
    filename: String,
    content: String,
) -> Result<String, String> {
    use tauri::Manager;
    use std::time::{SystemTime, UNIX_EPOCH};

    // 校验：禁止路径穿越
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename".into());
    }

    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("save_data").join(&chain_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let target = dir.join(&filename);
    let final_path = if target.exists() {
        // 在扩展名前插入毫秒时间戳
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let stem = std::path::Path::new(&filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&filename);
        let ext = std::path::Path::new(&filename)
            .extension()
            .and_then(|s| s.to_str());
        let new_name = match ext {
            Some(e) => format!("{}.{}.{}", stem, ts, e),
            None    => format!("{}.{}", stem, ts),
        };
        dir.join(new_name)
    } else {
        target
    };

    std::fs::write(&final_path, content.as_bytes()).map_err(|e| e.to_string())?;
    final_path.to_str().ok_or("Invalid path".into()).map(|s| s.to_string())
}

// Re-export analysis scripts FS commands (defined in `scripts_fs.rs`) so `generate_handler!` can use them.
use scripts_fs::{
    delete_analysis_script_path,
    list_analysis_scripts,
    mkdir_analysis_script_dir,
    read_analysis_script,
    rename_analysis_script_path,
    write_analysis_script,
};


/// 对已执行 trace 中指定 JUMPI 步骤进行符号化约束求解
///
/// 参数：
/// - `calldata_hex`：根交易原始 calldata，十六进制字符串（带或不带 0x 前缀）
/// - `sym_config`：符号变量配置（哪些 calldata 偏移是符号）
/// - `target_step`：目标 JUMPI 的全局步骤索引
/// - `goal`：TakeJump / SkipJump / EqualValue
/// - `z3_path`：Z3 可执行路径（默认使用 PATH 中的 z3）
#[tauri::command]
async fn symbolic_solve(
    calldata_hex: String,
    calldata_by_tx: Option<Vec<(u32, String)>>,
    sym_config: op_trace::symbolic::SymConfig,
    target_step: u32,
    goal: op_trace::symbolic::SymGoal,
    z3_path: Option<String>,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<op_trace::symbolic::SolverResult, String> {
    let sid = resolve_required_session_id(session_id, sessionId, "symbolic_solve")?;
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let session = get_session_by_sid(&guard, &sid)?;

    // 获取 shadow（需要 step_frame_depths）
    let shadow = session.shadow.as_ref()
        .ok_or_else(|| "shadow 未启用，请用 enable_shadow=true 重新执行".to_string())?;

    let frame_depths = shadow.step_frame_depths();
    let trace = &session.trace;

    if trace.is_empty() {
        return Err("trace 为空".into());
    }

    fn parse_hex_bytes(name: &str, raw: &str) -> Result<Vec<u8>, String> {
        let clean = raw.trim_start_matches("0x").trim_start_matches("0X");
        if clean.len() % 2 != 0 {
            return Err(format!("{name} 长度为奇数（{}字符），无法解析为字节序列", clean.len()));
        }
        clean.as_bytes().chunks(2)
            .map(|c| {
                let s = std::str::from_utf8(c).unwrap_or("??");
                u8::from_str_radix(s, 16)
                    .map_err(|_| format!("{name} 含非法十六进制字符: \"{}\"", s))
            })
            .collect::<Result<Vec<u8>, String>>()
    }

    // fallback calldata（单 tx 或未提供多 tx 输入时使用）
    let calldata = parse_hex_bytes("calldata_hex", &calldata_hex)?;

    // 可选：多 tx calldata 映射（tx_id -> calldata）
    let mut calldata_map: std::collections::HashMap<u32, Vec<u8>> = std::collections::HashMap::new();
    if let Some(entries) = calldata_by_tx {
        for (tx_id, hex) in entries {
            calldata_map.insert(tx_id, parse_hex_bytes(&format!("calldata_by_tx[{tx_id}]"), &hex)?);
        }
    }

    let target_idx = target_step as usize;
    if target_idx >= trace.len() {
        return Err(format!(
            "target_step {} 越界（trace len = {}）",
            target_step,
            trace.len()
        ));
    }
    let target_tx = trace[target_idx].transaction_id;
    let offset_by_name: std::collections::HashMap<String, usize> = sym_config
        .calldata_symbols
        .iter()
        .map(|(off, name)| (name.clone(), *off))
        .collect();

    // 重放符号引擎
    let engine = op_trace::symbolic::replay_from_trace(trace, frame_depths, &calldata, &calldata_map, sym_config);

    // 找到目标步骤对应的 JUMPI 条件表达式
    let target_constraint = engine.path_constraints
        .iter()
        .find(|c| c.step == target_step)
        .ok_or_else(|| format!(
            "步骤 {} 没有符号化的 JUMPI 约束。请确认：① 该步骤是 JUMPI 指令 ② 其条件依赖了已标记的符号输入",
            target_step
        ))?;

    // 构建 SMT-LIB2
    let query = op_trace::symbolic::build_smt2_query(
        engine.constraints(),
        target_step,
        target_tx,
        &target_constraint.condition,
        &goal,
    );

    eprintln!("[symbolic_solve] SMT-LIB2 查询:\n{}", query.smt2);

    // 调用 Z3
    let mut result = op_trace::symbolic::run_z3(&query.smt2, z3_path.as_deref(), target_tx);

    // 将 calldata 变量偏移从 sym_config 显式映射到解，避免依赖变量名 `cd_<off>` 约定。
    if let op_trace::symbolic::SolverResult::Sat { inputs, .. } = &mut result {
        for inp in inputs.iter_mut() {
            if let Some(off) = offset_by_name.get(&inp.name) {
                inp.calldata_offset = Some(*off);
            }
        }
    }
    eprintln!("[symbolic_solve] Z3 结果: {:?}", result);

    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(op_trace::DebugSessionState(Arc::new(Mutex::new(std::collections::HashMap::new()))))
        .manage(AnalysisCancelFlags(Arc::new(Mutex::new(HashMap::new()))))
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            op_trace,
            seek_to,
            scan_conditions,
            range_full_data,
            validate_fork_patch,
            run_analysis,
            cancel_analysis,
            find_value_origin,
            open_app_data_dir,
            list_analysis_scripts,
            read_analysis_script,
            write_analysis_script,
            mkdir_analysis_script_dir,
            delete_analysis_script_path,
            rename_analysis_script_path,
            save_data,
            reset_session,
            fetch_address_labels,
            backward_slice_tree,
            debug_shadow_steps,
            export_all_shadow_steps,
            validate_shadow_steps,
            build_cfg,
            symbolic_solve,
            sourcify::sourcify_read_cache,
            sourcify::sourcify_write_cache,
            sourcify::decompile_read_cache,
            sourcify::decompile_write_cache,
            sourcify::decompile_bytecode
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
