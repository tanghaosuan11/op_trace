//! Debug-core tauri commands: op_trace, seek_to, range_full_data, etc.

use std::sync::Arc;
use tauri::ipc::Channel;

use crate::op_trace;
use super::session::*;
use super::AnalysisCancelFlags;

#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub async fn op_trace(
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
    hardfork: Option<String>,
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
        hardfork,
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

#[tauri::command]
pub async fn seek_to(
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

#[tauri::command]
pub async fn range_full_data(
    start: usize,
    end: usize,
    session_id: Option<String>,
    #[allow(non_snake_case)] sessionId: Option<String>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<serde_json::Value, String> {
    if end.saturating_sub(start) >= 5000 {
        return Err(format!(
            "range_full_data: range {}..{} exceeds 5000-step limit",
            start, end
        ));
    }
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

#[tauri::command]
pub async fn find_value_origin(
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

#[tauri::command]
pub async fn reset_session(
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
