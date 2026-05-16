//! Data persistence & external API proxy commands.

/// 代理请求 eth-labels.com API，绕过浏览器 CORS 限制（daemon 可直接调用）
pub async fn fetch_address_labels_impl(address: String) -> Result<Vec<serde_json::Value>, String> {
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
        return Ok(Vec::new());
    }

    let labels: Vec<serde_json::Value> = response.json().await.unwrap_or_default();
    Ok(labels)
}

/// 代理请求 eth-labels.com API，绕过浏览器 CORS 限制
#[tauri::command]
pub async fn fetch_address_labels(address: String) -> Result<Vec<serde_json::Value>, String> {
    fetch_address_labels_impl(address).await
}

// 打开应用数据目录
#[tauri::command]
pub async fn open_app_data_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).ok();
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

/// 保存数据到 {app_data_dir}/save_data/{chain_id}/{filename}。
/// 若同名文件已存在，在扩展名前插入时间戳（如 foo.1711234567890.json）。
/// 返回实际写入的完整路径。
#[tauri::command]
pub async fn save_data(
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
