//! Sourcify 本地缓存层 — 只负责文件读写，HTTP 请求在前端完成。
//! 缓存路径：{app_data_dir}/contract/{chain_id}/{address}.json

use std::path::PathBuf;
use std::sync::Mutex;
use std::collections::HashMap;
use tauri::{AppHandle, Manager};
use heimdall_decompiler::{decompile, DecompilerArgsBuilder};

// ──── 全局内存缓存，避免重复反编译 ────────────────────────────────────────
// Key: "{chain_id}:{address}", Value: 反编译结果 JSON 字符串
lazy_static::lazy_static! {
    static ref DECOMPILE_CACHE: Mutex<HashMap<String, String>> = Mutex::new(HashMap::new());
}

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

// ──── Decompile 内存缓存 ────────────────────────────────────────────────────

/// 读取反编译结果内存缓存
#[tauri::command]
pub fn decompile_read_cache(
    _app: tauri::AppHandle,
    chain_id: u64,
    address: String,
) -> Result<Option<String>, String> {
    let normalized_addr = normalize_address(&address)?;
    let cache_key = format!("{}:{}", chain_id, normalized_addr);
    
    let cache = DECOMPILE_CACHE.lock()
        .map_err(|e| format!("Failed to lock cache: {e}"))?;
    
    Ok(cache.get(&cache_key).cloned())
}

/// 写入反编译结果内存缓存
#[tauri::command]
pub fn decompile_write_cache(
    _app: tauri::AppHandle,
    chain_id: u64,
    address: String,
    json: String,
) -> Result<(), String> {
    // 校验 JSON 合法性
    let _: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("Invalid JSON: {e}"))?;

    let normalized_addr = normalize_address(&address)?;
    let cache_key = format!("{}:{}", chain_id, normalized_addr);
    
    let mut cache = DECOMPILE_CACHE.lock()
        .map_err(|e| format!("Failed to lock cache: {e}"))?;
    
    cache.insert(cache_key, json);
    Ok(())
}

/// 调用 heimdall-decompiler 反编译字节码
#[tauri::command]
pub async fn decompile_bytecode(
    _app: tauri::AppHandle,
    chain_id: u64,
    address: String,
    bytecode: String,
) -> Result<String, String> {
    // 规范化地址并生成 cache key
    let normalized_addr = normalize_address(&address)?;
    let cache_key = format!("{}:{}", chain_id, normalized_addr);
    
    // 优先检查内存缓存，避免重复反编译
    {
        let cache = DECOMPILE_CACHE.lock()
            .map_err(|e| format!("Failed to lock cache: {e}"))?;
        
        if let Some(cached) = cache.get(&cache_key) {
            return Ok(cached.clone());
        }
    }
    
    // 验证字节码格式（允许有 0x 前缀）
    let bytecode_clean = bytecode.trim_start_matches("0x").trim_start_matches("0X");
    if bytecode_clean.len() % 2 != 0 || !bytecode_clean.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid bytecode format".to_string());
    }

    // 构建 heimdall-decompiler 参数，使用提供的字节码进行反编译
    let args = DecompilerArgsBuilder::new()
        .target(bytecode_clean.to_string())  // 直接传入 bytecode
        .skip_resolving(true)                // 跳过 4byte 解析（加速）
        .include_solidity(true)              // 生成 Solidity 源代码
        .timeout(30000)                      // 30 秒超时
        .build()
        .map_err(|e| format!("Failed to build decompiler args: {e}"))?;

    // 调用 heimdall-decompiler
    let result = decompile(args).await
        .map_err(|e| format!("Decompilation failed: {e}"))?;

    // 将反编译结果转换为 JSON（格式类似 Sourcify 响应）
    let decompiled_source = result.source.clone().unwrap_or_else(|| 
        "// Decompilation failed to generate Solidity output".to_string()
    );

    // 手动序列化结果（DecompileResult 没有 Serialize 实现）
    let response = serde_json::json!({
        "sources": {
            "decompiled.sol": {
                "content": decompiled_source
            }
        },
        "compilation": {
            "decompiler": "heimdall-rs",
            "bytecodeLength": bytecode_clean.len() / 2,
            "address": normalized_addr,
            "chainId": chain_id,
            "abi": result.abi_with_details
        }
    });

    // 序列化为 JSON 字符串
    let cache_json = serde_json::to_string(&response)
        .map_err(|e| format!("JSON serialization failed: {e}"))?;
    
    // 写入内存缓存
    {
        let mut cache = DECOMPILE_CACHE.lock()
            .map_err(|e| format!("Failed to lock cache: {e}"))?;
        cache.insert(cache_key, cache_json.clone());
    }

    Ok(cache_json)
}
