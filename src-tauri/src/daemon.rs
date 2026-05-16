#![recursion_limit = "256"]
//! OpTrace daemon — JSON-RPC over stdin/stdout
//!
//! VSCode 插件启动本进程，通过 newline-delimited JSON 通信:
//!   插件 → daemon : {"id":1,"method":"op_trace","params":{...}}
//!   daemon → 插件 : {"id":1,"result":{...}}           (成功)
//!   daemon → 插件 : {"id":1,"error":"message"}         (失败)
//!   daemon → 插件 : {"id":null,"event":"...","data":{...}}  (push 事件)
//!
//! 每行一个完整 JSON 对象，\n 分隔。


use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use optrace_lib::op_trace::{self, DebugSessionState};
use optrace_lib::op_trace::message_encoder::BytesSender;
use optrace_lib::commands::{self, session::*, foundry::start_foundry_debug_impl};
use optrace_lib::scripts_fs;
use optrace_lib::sourcify;
use optrace_lib::analysis;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─── Message types ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct Response {
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct Event {
    id: Value,
    event: String,
    data: Value,
}

// ─── Shared state ─────────────────────────────────────────────────────────────

struct AppState {
    sessions: DebugSessionState,
    cancel_flags: commands::AnalysisCancelFlags,
    data_dir: PathBuf,
}

// ─── Output helpers ───────────────────────────────────────────────────────────

fn send_line(stdout: &Mutex<io::Stdout>, value: &impl Serialize) {
    let mut out = stdout.lock().unwrap();
    let mut line = serde_json::to_string(value).unwrap();
    line.push('\n');
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}

fn reply_ok(stdout: &Mutex<io::Stdout>, id: Value, result: Value) {
    send_line(stdout, &Response { id, result: Some(result), error: None });
}

fn reply_err(stdout: &Mutex<io::Stdout>, id: Value, msg: String) {
    send_line(stdout, &Response { id, result: None, error: Some(msg) });
}

fn push_event(stdout: &Arc<Mutex<io::Stdout>>, event: &str, data: Value) {
    send_line(stdout, &Event { id: Value::Null, event: event.to_string(), data });
}

// ─── Method dispatch ──────────────────────────────────────────────────────────

async fn dispatch(req: Request, state: Arc<AppState>, stdout: Arc<Mutex<io::Stdout>>) {
    let id = req.id;
    let params = req.params;

    macro_rules! param {
        ($k:expr, $t:ty) => {
            serde_json::from_value::<$t>(params.get($k).cloned().unwrap_or(Value::Null))
                .map_err(|e| format!("param '{}': {}", $k, e))
        };
        ($k:expr) => {
            params.get($k).cloned().unwrap_or(Value::Null)
        };
    }

    let result: Result<Value, String> = match req.method.as_str() {

        "seek_to" => (|| {
            let index: usize = param!("index", usize)?;
            let request_id: u32 = param!("requestId", u32).unwrap_or(0);
            let sid = extract_sid(&params)?;
            let guard = state.sessions.0.lock().map_err(|e| e.to_string())?;
            let session = get_session_by_sid(&guard, &sid)?;
            let result = op_trace::seek_to_impl(session, index)
                .ok_or_else(|| format!("Index {} out of range", index))?;
            let mut json = serde_json::to_value(&result).map_err(|e| e.to_string())?;
            json["request_id"] = Value::Number(request_id.into());
            Ok(json)
        })(),

        "range_full_data" => (|| {
            let start: usize = param!("start", usize)?;
            let end: usize = param!("end", usize)?;
            if end.saturating_sub(start) >= 5000 {
                return Err(format!("range {}..{} exceeds 5000-step limit", start, end));
            }
            let sid = extract_sid(&params)?;
            let guard = state.sessions.0.lock().map_err(|e| e.to_string())?;
            let session = get_session_by_sid(&guard, &sid)?;
            let data = op_trace::range_full_data_impl(session, start, end);
            serde_json::to_value(&data).map_err(|e| e.to_string())
        })(),

        "reset_session" => (|| {
            let sid = extract_sid(&params)?;
            state.sessions.0.lock().map_err(|e| e.to_string())?.remove(&sid);
            state.cancel_flags.0.lock().map_err(|e| e.to_string())?.remove(&sid);
            Ok(Value::Bool(true))
        })(),

        "find_value_origin" => (|| {
            let global_index: usize = param!("globalIndex", usize)?;
            let value_hex: String = param!("valueHex", String)?;
            let sid = extract_sid(&params)?;
            let guard = state.sessions.0.lock().map_err(|e| e.to_string())?;
            let session = get_session_by_sid(&guard, &sid)?;
            let hex = value_hex.trim_start_matches("0x").trim_start_matches("0X");
            let value = revm::primitives::U256::from_str_radix(hex, 16)
                .map_err(|_| format!("Invalid U256 hex: {}", value_hex))?;
            let idx = session.find_value_origin(global_index, value);
            Ok(serde_json::to_value(idx).unwrap())
        })(),

        "validate_fork_patch" => (|| {
            let sid = extract_sid(&params)?;
            let step_index: usize = param!("stepIndex", usize)?;
            let kind: String = param!("kind", String)?;
            let stack_pos: Option<usize> = param!("stackPos", Option<usize>).unwrap_or(None);
            let mem_offset: Option<usize> = param!("memOffset", Option<usize>).unwrap_or(None);
            let mem_hex: Option<String> = param!("memHex", Option<String>).unwrap_or(None);
            let pc_hex: Option<String> = param!("pcHex", Option<String>).unwrap_or(None);
            let value_hex: Option<String> = param!("valueHex", Option<String>).unwrap_or(None);
            let storage_address_hex: Option<String> = param!("storageAddressHex", Option<String>).unwrap_or(None);
            let storage_slot_hex: Option<String> = param!("storageSlotHex", Option<String>).unwrap_or(None);
            let storage_value_hex: Option<String> = param!("storageValueHex", Option<String>).unwrap_or(None);
            let balance_address_hex: Option<String> = param!("balanceAddressHex", Option<String>).unwrap_or(None);
            let guard = state.sessions.0.lock().map_err(|e| e.to_string())?;
            let session = get_session_by_sid(&guard, &sid)?;
            op_trace::fork::validate_fork_patch_impl(
                session, step_index, &kind, stack_pos, mem_offset,
                mem_hex.as_deref(), pc_hex.as_deref(), value_hex.as_deref(),
                storage_address_hex.as_deref(), storage_slot_hex.as_deref(),
                storage_value_hex.as_deref(), balance_address_hex.as_deref(),
            )?;
            Ok(Value::Bool(true))
        })(),

        "build_cfg" => (|| {
            let sid = extract_sid(&params)?;
            let transaction_id: u32 = param!("transactionId", u32).unwrap_or(0);
            let context_id: u16 = param!("contextId", u16)?;
            let only_executed: bool = param!("onlyExecuted", bool).unwrap_or(true);
            let mut guard = state.sessions.0.lock().map_err(|e| e.to_string())?;
            let session = get_session_mut_by_sid(&mut guard, &sid)?;
            let result = op_trace::cfg_builder::build_cfg_for_frame_cached(
                session, transaction_id, context_id, only_executed,
            )?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        })(),

        "fetch_address_labels" => {
            match param!("address", String) {
                Ok(address) => {
                    match commands::data::fetch_address_labels_impl(address).await {
                        Ok(data) => serde_json::to_value(data).map_err(|e| e.to_string()),
                        Err(e) => Err(e),
                    }
                }
                Err(e) => Err(e),
            }
        }

        "sourcify_read_cache" => (|| {
            let address: String = param!("address", String)?;
            let chain_id: u64 = param!("chainId", u64)?;
            let result = sourcify::sourcify_read_cache_with_dir(&state.data_dir, chain_id, &address)?;
            Ok(serde_json::to_value(result).unwrap())
        })(),

        "sourcify_write_cache" => (|| {
            let address: String = param!("address", String)?;
            let chain_id: u64 = param!("chainId", u64)?;
            let json: String = param!("json", String)?;
            sourcify::sourcify_write_cache_with_dir(&state.data_dir, chain_id, &address, &json)?;
            Ok(Value::Bool(true))
        })(),

        "decompile_read_cache" => (|| {
            let address: String = param!("address", String)?;
            let chain_id: u64 = param!("chainId", u64)?;
            let result = sourcify::decompile_read_cache_impl(chain_id, &address)?;
            Ok(serde_json::to_value(result).unwrap())
        })(),

        "decompile_write_cache" => (|| {
            let address: String = param!("address", String)?;
            let chain_id: u64 = param!("chainId", u64)?;
            let json: String = param!("json", String)?;
            sourcify::decompile_write_cache_impl(chain_id, &address, &json)?;
            Ok(Value::Bool(true))
        })(),

        "list_analysis_scripts" => (|| {
            let scripts_root = state.data_dir.join("scripts");
            let nodes = scripts_fs::list_analysis_scripts_with_dir(&scripts_root);
            serde_json::to_value(nodes).map_err(|e| e.to_string())
        })(),

        "read_analysis_script" => (|| {
            let path: String = param!("path", String)?;
            let scripts_root = state.data_dir.join("scripts");
            let code = scripts_fs::read_analysis_script_with_dir(&scripts_root, &path)?;
            Ok(Value::String(code))
        })(),

        "write_analysis_script" => (|| {
            let path: String = param!("path", String)?;
            let code: String = param!("code", String)?;
            let scripts_root = state.data_dir.join("scripts");
            scripts_fs::write_analysis_script_with_dir(&scripts_root, &path, &code)?;
            Ok(Value::Bool(true))
        })(),

        "mkdir_analysis_script_dir" => (|| {
            let path: String = param!("path", String)?;
            let scripts_root = state.data_dir.join("scripts");
            scripts_fs::mkdir_analysis_script_dir_with_dir(&scripts_root, &path)?;
            Ok(Value::Bool(true))
        })(),

        "delete_analysis_script_path" => (|| {
            let path: String = param!("path", String)?;
            let scripts_root = state.data_dir.join("scripts");
            scripts_fs::delete_analysis_script_path_with_dir(&scripts_root, &path)?;
            Ok(Value::Bool(true))
        })(),

        "rename_analysis_script_path" => (|| {
            let old_path: String = param!("oldPath", String)?;
            let new_path: String = param!("newPath", String)?;
            let scripts_root = state.data_dir.join("scripts");
            scripts_fs::rename_analysis_script_path_with_dir(&scripts_root, &old_path, &new_path)?;
            Ok(Value::Bool(true))
        })(),

        "ping" => Ok(Value::String("pong".into())),

        "scan_conditions" => (|| {
            let conditions: Vec<op_trace::ConditionGroup> =
                serde_json::from_value(params.get("conditions").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("param 'conditions': {}", e))?;
            let tid: Option<u32> = params.get("transactionId")
                .or_else(|| params.get("transaction_id"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let sid = extract_sid(&params)?;
            let guard = state.sessions.0.lock().map_err(|e| e.to_string())?;
            let session = get_session_by_sid(&guard, &sid)?;
            let hits = op_trace::scan_conditions_impl(session, &conditions, tid);
            serde_json::to_value(&hits).map_err(|e| e.to_string())
        })(),

        "cancel_analysis" => (|| {
            let sid = extract_sid(&params)?;
            let mut guard = state.cancel_flags.0.lock().map_err(|e| e.to_string())?;
            let flag = guard
                .entry(sid)
                .or_insert_with(|| Arc::new(std::sync::atomic::AtomicBool::new(false)))
                .clone();
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            Ok(Value::Null)
        })(),

        "decompile_frame_cmd" => (|| {
            let transaction_id: u32 = param!("transactionId", u32)
                .or_else(|_| param!("transaction_id", u32))?;
            let frame_id: u16 = param!("frameId", u16)
                .or_else(|_| param!("frame_id", u16))?;
            let calldata_hex: String = param!("calldataHex", String)
                .or_else(|_| param!("calldata_hex", String))?;
            let calldata_by_tx: Option<Vec<(u32, String)>> =
                serde_json::from_value(params.get("calldataByTx").cloned().unwrap_or(Value::Null)).ok();
            let options = serde_json::from_value(
                params.get("options").cloned().unwrap_or(Value::Null)
            ).ok();
            let sid = extract_sid(&params)?;
            let guard = state.sessions.0.lock().map_err(|e| e.to_string())?;
            let session = get_session_by_sid(&guard, &sid)?;
            fn parse_hex_bytes(name: &str, raw: &str) -> Result<Vec<u8>, String> {
                let clean = raw.trim_start_matches("0x").trim_start_matches("0X");
                if clean.len() % 2 != 0 {
                    return Err(format!("{name} odd length ({})", clean.len()));
                }
                clean.as_bytes().chunks(2).map(|c| {
                    let s = std::str::from_utf8(c).unwrap_or("??");
                    u8::from_str_radix(s, 16).map_err(|_| format!("{name} invalid hex: {s}"))
                }).collect()
            }
            let root_calldata = parse_hex_bytes("calldataHex", &calldata_hex)?;
            let mut cd_map: std::collections::HashMap<u32, Vec<u8>> = std::collections::HashMap::new();
            if let Some(entries) = calldata_by_tx {
                for (tx_id, hex) in entries {
                    cd_map.insert(tx_id, parse_hex_bytes(&format!("calldata[{tx_id}]"), &hex)?);
                }
            }
            let opts = options.unwrap_or_default();
            let result = op_trace::decompile::decompile_frame(
                session, transaction_id, frame_id, &root_calldata, &cd_map, &opts
            )?;
            serde_json::to_value(&result).map_err(|e| e.to_string())
        })(),

        "run_analysis" => (|| {
            let script: String = param!("script", String)?;
            let raw_filters: analysis::RawFilters =
                serde_json::from_value(params.get("filters").cloned().unwrap_or(Value::Null))
                    .unwrap_or_default();
            let chain_id: String = params.get("chainId")
                .and_then(|v| v.as_str()).unwrap_or("").to_owned();
            let tid: Option<u32> = params.get("transactionId")
                .or_else(|| params.get("transaction_id"))
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let sid = extract_sid(&params)?;
            let mut filters = raw_filters;
            if let Some(t) = tid { filters.transaction_id = Some(t); }

            let cancelled = {
                let mut guard = state.cancel_flags.0.lock().map_err(|e| e.to_string())?;
                let flag = guard
                    .entry(sid.clone())
                    .or_insert_with(|| Arc::new(std::sync::atomic::AtomicBool::new(false)))
                    .clone();
                flag.store(false, std::sync::atomic::Ordering::Relaxed);
                flag
            };
            let session_arc = Arc::clone(&state.sessions.0);
            let data_dir = state.data_dir.to_string_lossy().into_owned();
            let (tx, rx) = std::sync::mpsc::channel::<Result<Value, String>>();
            std::thread::spawn(move || {
                let result = (|| -> Result<Value, String> {
                    let guard = session_arc.lock().map_err(|e| e.to_string())?;
                    let session = get_session_by_sid(&guard, &sid)?;
                    analysis::run_analysis(session, &script, filters, cancelled, data_dir, chain_id)
                })();
                let _ = tx.send(result);
            });
            rx.recv().map_err(|e| e.to_string())?
        })(),

        "decompile_bytecode" => decompile_bytecode_handler(&params).await,

        other => Err(format!("Unknown method: {}", other)),
    };

    match result {
        Ok(v) => reply_ok(&stdout, id, v),
        Err(e) => reply_err(&stdout, id, e),
    }
}

// ─── op_trace dispatch (streaming) ───────────────────────────────────────────

async fn decompile_bytecode_handler(params: &Value) -> Result<Value, String> {
    let chain_id: u64 = serde_json::from_value(params.get("chainId").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("param 'chainId': {e}"))?;
    let address: String = serde_json::from_value(params.get("address").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("param 'address': {e}"))?;
    let bytecode: String = serde_json::from_value(params.get("bytecode").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("param 'bytecode': {e}"))?;
    sourcify::decompile_bytecode_impl(chain_id, address, bytecode)
        .await
        .map(Value::String)
}

async fn dispatch_foundry_debug(id: Value, params: Value, state: Arc<AppState>, stdout: Arc<Mutex<io::Stdout>>) {
    let folder_path = match params.get("folderPath").and_then(|v| v.as_str()).map(str::to_owned) {
        Some(p) => p,
        None => { reply_err(&stdout, id, "missing 'folderPath' param".into()); return; }
    };
    let session_id = params.get("sessionId").or_else(|| params.get("session_id"))
        .and_then(|v| v.as_str()).map(str::to_owned);

    let stdout_for_sender = Arc::clone(&stdout);
    let sender: BytesSender = Arc::new(move |data: Vec<u8>| {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        push_event(&stdout_for_sender, "op_trace_msg", Value::String(b64));
    });

    let result = start_foundry_debug_impl(
        folder_path, session_id, sender, Arc::clone(&state.sessions.0),
    ).await;

    match result {
        Ok(_) => reply_ok(&stdout, id, Value::Null),
        Err(e) => reply_err(&stdout, id, e),
    }
}

async fn dispatch_op_trace(id: Value, params: Value, state: Arc<AppState>, stdout: Arc<Mutex<io::Stdout>>) {
    let sid = match extract_sid(&params) {
        Ok(s) => s,
        Err(e) => { reply_err(&stdout, id, e); return; }
    };

    let tx = match params.get("tx").and_then(|v| v.as_str()).map(|s| s.to_owned()) {
        Some(s) => s,
        None => { reply_err(&stdout, id, "missing 'tx' param".into()); return; }
    };

    let tx_data = params.get("txData").and_then(|v| serde_json::from_value(v.clone()).ok());
    let tx_data_list = params.get("txDataList").and_then(|v| serde_json::from_value(v.clone()).ok());
    let block_data = params.get("blockData").and_then(|v| serde_json::from_value(v.clone()).ok());
    let rpc_url = params.get("rpcUrl").and_then(|v| v.as_str()).unwrap_or("").to_owned();
    let use_alloy_cache = params.get("useAlloyCache").and_then(|v| v.as_bool()).unwrap_or(false);
    let use_prestate = params.get("usePrestate").and_then(|v| v.as_bool()).unwrap_or(false);
    let enable_shadow = params.get("enableShadow").and_then(|v| v.as_bool()).unwrap_or(false);
    let readonly = params.get("readonly").and_then(|v| v.as_bool()).unwrap_or(false);
    let patches = params.get("patches").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    let hand_fill = params.get("handFill").and_then(|v| v.as_bool()).unwrap_or(false);
    let hardfork = params.get("hardfork").and_then(|v| v.as_str()).map(|s| s.to_owned());

    {
        let mut guard = match state.sessions.0.lock() {
            Ok(g) => g,
            Err(e) => { reply_err(&stdout, id, e.to_string()); return; }
        };
        cleanup_stale_sessions(&mut guard);
        let entry = guard.entry(sid.clone()).or_default();
        if entry.is_running {
            reply_err(&stdout, id, format!("Session {} already running", sid));
            return;
        }
        entry.is_running = true;
        entry.updated_at_ms = now_ms();
        entry.session = None;
    }

    // base64-encode each binary frame and push as an event
    let stdout_for_sender = Arc::clone(&stdout);
    let sender: BytesSender = Arc::new(move |data: Vec<u8>| {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        push_event(&stdout_for_sender, "op_trace_msg", Value::String(b64));
    });

    let data_dir = state.data_dir.clone();
    let session_arc = Arc::clone(&state.sessions.0);

    let result = op_trace::op_trace(
        &tx, tx_data, tx_data_list, block_data, &rpc_url,
        use_alloy_cache, use_prestate, enable_shadow, readonly,
        patches, hand_fill, hardfork,
        sender, &data_dir, session_arc.clone(), Some(sid.clone()),
    ).await;

    if let Ok(mut guard) = session_arc.lock() {
        if let Some(entry) = guard.get_mut(&sid) {
            entry.is_running = false;
            entry.updated_at_ms = now_ms();
        }
    }

    match result {
        Ok(_) => reply_ok(&stdout, id, Value::Null),
        Err(e) => reply_err(&stdout, id, e.to_string()),
    }
}

fn extract_sid(params: &Value) -> Result<String, String> {
    params.get("sessionId").or_else(|| params.get("session_id"))
        .and_then(|v| v.as_str()).map(|s| s.to_owned())
        .ok_or_else(|| "missing 'sessionId' param".to_string())
}

// ─── Main ─────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let data_dir = std::env::var("OPTRACE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(|h| PathBuf::from(h).join(".optrace"))
                .unwrap_or_else(|_| PathBuf::from("/tmp/optrace"))
        });
    std::fs::create_dir_all(&data_dir).ok();

    let state = Arc::new(AppState {
        sessions: DebugSessionState(Arc::new(Mutex::new(HashMap::new()))),
        cancel_flags: commands::AnalysisCancelFlags(Arc::new(Mutex::new(HashMap::new()))),
        data_dir,
    });

    let stdout = Arc::new(Mutex::new(io::stdout()));

    push_event(&stdout, "ready", serde_json::json!({"version": env!("CARGO_PKG_VERSION")}));

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim().to_owned();
        if line.is_empty() { continue; }

        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                send_line(&stdout, &Response {
                    id: Value::Null,
                    result: None,
                    error: Some(format!("JSON parse error: {}", e)),
                });
                continue;
            }
        };

        let s = Arc::clone(&state);
        let o = Arc::clone(&stdout);
        if req.method == "op_trace" {
            tokio::spawn(dispatch_op_trace(req.id, req.params, s, o));
        } else if req.method == "start_foundry_debug" {
            tokio::spawn(dispatch_foundry_debug(req.id, req.params, s, o));
        } else {
            tokio::spawn(dispatch(req, s, o));
        }
    }
}
