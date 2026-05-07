//! 反编译命令：从已执行 trace 的单个 frame 生成伪代码。

use std::collections::HashMap;

use crate::op_trace;
use crate::op_trace::decompile::{decompile_frame, DecompileOptions, DecompileResult};
use super::session::*;

#[tauri::command]
#[allow(non_snake_case)]
pub async fn decompile_frame_cmd(
    transaction_id: u32,
    frame_id: u16,
    calldata_hex: String,
    calldata_by_tx: Option<Vec<(u32, String)>>,
    session_id: Option<String>,
    sessionId: Option<String>,
    options: Option<DecompileOptions>,
    state: tauri::State<'_, op_trace::DebugSessionState>,
) -> Result<DecompileResult, String> {
    let sid = resolve_required_session_id(session_id, sessionId, "decompile_frame")?;
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let session = get_session_by_sid(&guard, &sid)?;

    fn parse_hex_bytes(name: &str, raw: &str) -> Result<Vec<u8>, String> {
        let clean = raw.trim_start_matches("0x").trim_start_matches("0X");
        if clean.len() % 2 != 0 {
            return Err(format!("{name} 长度为奇数（{}字符）", clean.len()));
        }
        clean
            .as_bytes()
            .chunks(2)
            .map(|c| {
                let s = std::str::from_utf8(c).unwrap_or("??");
                u8::from_str_radix(s, 16)
                    .map_err(|_| format!("{name} 含非法十六进制: {}", s))
            })
            .collect::<Result<Vec<u8>, String>>()
    }

    let root_calldata = parse_hex_bytes("calldata_hex", &calldata_hex)?;
    let mut cd_map: HashMap<u32, Vec<u8>> = HashMap::new();
    if let Some(entries) = calldata_by_tx {
        for (tx_id, hex) in entries {
            cd_map.insert(tx_id, parse_hex_bytes(&format!("calldata[{tx_id}]"), &hex)?);
        }
    }

    let opts = options.unwrap_or_default();
    decompile_frame(session, transaction_id, frame_id, &root_calldata, &cd_map, &opts)
}
