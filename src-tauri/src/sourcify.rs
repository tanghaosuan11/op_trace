//! Sourcify 本地缓存层 — 只负责文件读写，HTTP 请求在前端完成。
//! 缓存路径：{app_data_dir}/contract/{chain_id}/{address}.json

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn normalize_address(addr: &str) -> Result<String, String> {
    let s = addr.trim();
    let s = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
    if s.len() != 40 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Invalid contract address: {addr}"));
    }
    Ok(format!("0x{}", s.to_lowercase()))
}

fn cache_path(app: &AppHandle, chain_id: u64, address: &str) -> Result<PathBuf, String> {
    let addr = normalize_address(address)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("contract")
        .join(chain_id.to_string());
    Ok(dir.join(format!("{}.json", addr)))
}

/// 若存在缓存则返回原始 JSON 字符串，否则返回 None
#[tauri::command]
pub fn sourcify_read_cache(
    app: tauri::AppHandle,
    chain_id: u64,
    address: String,
) -> Result<Option<String>, String> {
    let path = cache_path(&app, chain_id, &address)?;
    if !path.is_file() {
        return Ok(None);
    }
    let s = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(Some(s))
}

/// 将前端获取到的 JSON 字符串写入缓存（校验 JSON 合法性后落盘）
#[tauri::command]
pub fn sourcify_write_cache(
    app: tauri::AppHandle,
    chain_id: u64,
    address: String,
    json: String,
) -> Result<(), String> {
    // 校验 JSON 合法性，拒绝写入损坏数据
    let _: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("Invalid JSON: {e}"))?;

    let path = cache_path(&app, chain_id, &address)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}
