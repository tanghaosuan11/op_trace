//! Filesystem-backed analysis scripts under `{app_data_dir}/scripts`.
//!
//! - Max depth: 3 levels
//! - Only `.js` files are treated as scripts
//! - All paths are relative to the scripts root; path traversal is rejected

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

const MAX_DEPTH: usize = 3;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisScriptTreeNode {
    pub kind: String, // "dir" | "file"
    pub name: String,
    /// Relative path from `{app_data_dir}/scripts`, using '/' separators.
    pub path: String,
    pub children: Option<Vec<AnalysisScriptTreeNode>>,
}

fn scripts_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("scripts"))
}

pub fn normalize_rel_path(rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err("Invalid path: absolute".into());
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::Normal(s) => out.push(s),
            // Reject ParentDir, RootDir, Prefix (Windows)
            _ => return Err("Invalid path".into()),
        }
    }
    Ok(out)
}

pub fn rel_depth(rel: &Path) -> usize {
    rel.components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count()
}

pub fn ensure_max_depth(rel: &Path, max_depth: usize) -> Result<(), String> {
    if rel_depth(rel) > max_depth {
        return Err(format!("Path too deep (max {max_depth} levels)"));
    }
    Ok(())
}

pub fn rel_path_to_slash(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn build_script_tree(dir: &Path, root_rel: &Path, depth: usize, max_depth: usize) -> Vec<AnalysisScriptTreeNode> {
    if depth > max_depth {
        return Vec::new();
    }
    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    let mut files: Vec<(String, PathBuf)> = Vec::new();

    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    for ent in rd.flatten() {
        let p = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            dirs.push((name, p));
        } else if p.is_file() {
            if p.extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("js"))
                .unwrap_or(false)
            {
                files.push((name, p));
            }
        }
    }
    dirs.sort_by(|a, b| a.0.cmp(&b.0));
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out: Vec<AnalysisScriptTreeNode> = Vec::new();

    // Dirs first (VSCode style)
    for (name, p) in dirs {
        let rel = p.strip_prefix(root_rel).unwrap_or(&p);
        let children = if depth == max_depth {
            Vec::new()
        } else {
            build_script_tree(&p, root_rel, depth + 1, max_depth)
        };
        out.push(AnalysisScriptTreeNode {
            kind: "dir".into(),
            name,
            path: rel_path_to_slash(rel),
            children: Some(children),
        });
    }
    for (name, p) in files {
        let rel = p.strip_prefix(root_rel).unwrap_or(&p);
        out.push(AnalysisScriptTreeNode {
            kind: "file".into(),
            name,
            path: rel_path_to_slash(rel),
            children: None,
        });
    }
    out
}

fn delete_dir_all_safe(p: &Path) -> Result<(), String> {
    if !p.exists() {
        return Ok(());
    }
    if p.is_file() {
        return std::fs::remove_file(p).map_err(|e| e.to_string());
    }
    for ent in std::fs::read_dir(p).map_err(|e| e.to_string())? {
        let ent = ent.map_err(|e| e.to_string())?;
        let child = ent.path();
        if child.is_dir() {
            delete_dir_all_safe(&child)?;
        } else {
            std::fs::remove_file(&child).map_err(|e| e.to_string())?;
        }
    }
    std::fs::remove_dir(p).map_err(|e| e.to_string())
}

// ─── Daemon-compatible variants (take PathBuf instead of AppHandle) ───────────

pub fn list_analysis_scripts_with_dir(scripts_root: &Path) -> Vec<AnalysisScriptTreeNode> {
    let _ = std::fs::create_dir_all(scripts_root);
    build_script_tree(scripts_root, scripts_root, 1, MAX_DEPTH)
}

pub fn read_analysis_script_with_dir(scripts_root: &Path, path: &str) -> Result<String, String> {
    let rel = normalize_rel_path(path.trim())?;
    ensure_max_depth(&rel, MAX_DEPTH)?;
    let full = scripts_root.join(&rel);
    if !full.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("js")).unwrap_or(false) {
        return Err("Only .js scripts are supported".into());
    }
    std::fs::read_to_string(&full).map_err(|e| e.to_string())
}

pub fn write_analysis_script_with_dir(scripts_root: &Path, path: &str, code: &str) -> Result<(), String> {
    std::fs::create_dir_all(scripts_root).map_err(|e| e.to_string())?;
    let rel = normalize_rel_path(path.trim())?;
    ensure_max_depth(&rel, MAX_DEPTH)?;
    let full = scripts_root.join(&rel);
    if !full.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("js")).unwrap_or(false) {
        return Err("Only .js scripts are supported".into());
    }
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&full, code.as_bytes()).map_err(|e| e.to_string())
}

pub fn mkdir_analysis_script_dir_with_dir(scripts_root: &Path, path: &str) -> Result<(), String> {
    std::fs::create_dir_all(scripts_root).map_err(|e| e.to_string())?;
    let rel = normalize_rel_path(path.trim())?;
    ensure_max_depth(&rel, MAX_DEPTH)?;
    let full = scripts_root.join(&rel);
    std::fs::create_dir_all(&full).map_err(|e| e.to_string())
}

pub fn delete_analysis_script_path_with_dir(scripts_root: &Path, path: &str) -> Result<(), String> {
    let rel = normalize_rel_path(path.trim())?;
    if rel.as_os_str().is_empty() {
        return Err("Refusing to delete scripts root".into());
    }
    ensure_max_depth(&rel, MAX_DEPTH)?;
    let full = scripts_root.join(&rel);
    delete_dir_all_safe(&full)
}

pub fn rename_analysis_script_path_with_dir(scripts_root: &Path, old_path: &str, new_path: &str) -> Result<(), String> {
    let old_rel = normalize_rel_path(old_path.trim())?;
    if old_rel.as_os_str().is_empty() {
        return Err("Refusing to rename scripts root".into());
    }
    ensure_max_depth(&old_rel, MAX_DEPTH)?;
    let new_rel = normalize_rel_path(new_path.trim())?;
    if new_rel.as_os_str().is_empty() {
        return Err("Target path is empty".into());
    }
    ensure_max_depth(&new_rel, MAX_DEPTH)?;
    if old_rel.parent() != new_rel.parent() {
        return Err("Source and destination must be in the same directory".into());
    }
    let full_old = scripts_root.join(&old_rel);
    let full_new = scripts_root.join(&new_rel);
    if !full_old.exists() {
        return Err("Source path does not exist".into());
    }
    if full_new.exists() {
        return Err("A file or folder with that name already exists".into());
    }
    std::fs::rename(&full_old, &full_new).map_err(|e| e.to_string())
}

/// List analysis scripts under `{app_data_dir}/scripts` as a directory tree (max depth = 3).
#[tauri::command]
pub async fn list_analysis_scripts(app: tauri::AppHandle) -> Result<Vec<AnalysisScriptTreeNode>, String> {
    eprintln!("[scripts_fs] list_analysis_scripts");
    let scripts_dir = scripts_dir(&app)?;
    std::fs::create_dir_all(&scripts_dir).map_err(|e| e.to_string())?;
    Ok(build_script_tree(&scripts_dir, &scripts_dir, 1, MAX_DEPTH))
}

/// Read a script file by relative path from `{app_data_dir}/scripts`.
#[tauri::command]
pub async fn read_analysis_script(app: tauri::AppHandle, path: String) -> Result<String, String> {
    eprintln!("[scripts_fs] read_analysis_script path={}", path);
    let scripts_dir = scripts_dir(&app)?;
    let rel = normalize_rel_path(path.trim())?;
    ensure_max_depth(&rel, MAX_DEPTH)?;
    let full = scripts_dir.join(&rel);
    if full.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("js"))
        .unwrap_or(false)
        == false
    {
        return Err("Only .js scripts are supported".into());
    }
    std::fs::read_to_string(&full).map_err(|e| e.to_string())
}

/// Write a script file by relative path from `{app_data_dir}/scripts` (creates parent dirs as needed).
#[tauri::command]
pub async fn write_analysis_script(app: tauri::AppHandle, path: String, code: String) -> Result<(), String> {
    eprintln!("[scripts_fs] write_analysis_script path={} bytes={}", path, code.len());
    let scripts_dir = scripts_dir(&app)?;
    std::fs::create_dir_all(&scripts_dir).map_err(|e| e.to_string())?;
    let rel = normalize_rel_path(path.trim())?;
    ensure_max_depth(&rel, MAX_DEPTH)?;
    let full = scripts_dir.join(&rel);
    if full.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("js"))
        .unwrap_or(false)
        == false
    {
        return Err("Only .js scripts are supported".into());
    }
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&full, code.as_bytes()).map_err(|e| e.to_string())
}

/// Create a directory under `{app_data_dir}/scripts` (max depth = 3).
#[tauri::command]
pub async fn mkdir_analysis_script_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    eprintln!("[scripts_fs] mkdir_analysis_script_dir path={}", path);
    let scripts_dir = scripts_dir(&app)?;
    std::fs::create_dir_all(&scripts_dir).map_err(|e| e.to_string())?;
    let rel = normalize_rel_path(path.trim())?;
    ensure_max_depth(&rel, MAX_DEPTH)?;
    let full = scripts_dir.join(&rel);
    std::fs::create_dir_all(&full).map_err(|e| e.to_string())
}

/// Delete a file or directory (recursively) under `{app_data_dir}/scripts` (max depth = 3).
#[tauri::command]
pub async fn delete_analysis_script_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    eprintln!("[scripts_fs] delete_analysis_script_path path={}", path);
    let scripts_dir = scripts_dir(&app)?;
    let rel = normalize_rel_path(path.trim())?;
    if rel.as_os_str().is_empty() {
        return Err("Refusing to delete scripts root".into());
    }
    ensure_max_depth(&rel, MAX_DEPTH)?;
    let full = scripts_dir.join(&rel);
    delete_dir_all_safe(&full)
}

/// Rename a file or directory within the same parent directory under `{app_data_dir}/scripts`.
#[tauri::command]
pub async fn rename_analysis_script_path(
    app: tauri::AppHandle,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    eprintln!("[scripts_fs] rename_analysis_script_path old={} new={}", old_path, new_path);
    let scripts_dir = scripts_dir(&app)?;

    let old_rel = normalize_rel_path(old_path.trim())?;
    if old_rel.as_os_str().is_empty() {
        return Err("Refusing to rename scripts root".into());
    }
    ensure_max_depth(&old_rel, MAX_DEPTH)?;

    let new_rel = normalize_rel_path(new_path.trim())?;
    if new_rel.as_os_str().is_empty() {
        return Err("Target path is empty".into());
    }
    ensure_max_depth(&new_rel, MAX_DEPTH)?;

    // Only rename within the same parent directory (no cross-directory moves).
    if old_rel.parent() != new_rel.parent() {
        return Err("Source and destination must be in the same directory".into());
    }

    let full_old = scripts_dir.join(&old_rel);
    let full_new = scripts_dir.join(&new_rel);

    if !full_old.exists() {
        return Err("Source path does not exist".into());
    }
    if full_new.exists() {
        return Err("A file or folder with that name already exists".into());
    }

    std::fs::rename(&full_old, &full_new).map_err(|e| e.to_string())
}

