//! EVM CacheDB 磁盘缓存读写
//!
//! 负责 CacheDB 的序列化/反序列化、缓存路径计算、去重等。

use revm::database::Cache;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use super::types::TxDebugData;
use super::AlloyCacheDB;

/// 手填字段拼接后 SHA256，作缓存文件名第一段。
pub fn tx_debug_data_content_hash_hex(row: &TxDebugData) -> String {
    let payload = format!(
        "{}|{}|{}|{}|{}|{}",
        row.from.trim(),
        row.to.trim(),
        row.value.trim(),
        row.gas_price.trim(),
        row.gas_limit.trim(),
        row.data.trim(),
    );
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn resolve_cache_key(row: &TxDebugData, fallback_block: u64) -> (String, u64) {
    // If frontend provides a real tx hash (debug-by-tx), use it as the cache key prefix.
    // Only fall back to content hash for manual/debug-by-data runs where there is no tx hash.
    let hash = row
        .tx_hash
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| tx_debug_data_content_hash_hex(row));
    let block = row
        .cache_block
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| u64::from_str_radix(s, 10).ok())
        .unwrap_or(fallback_block);
    (hash, block)
}

pub(crate) fn get_cache_path(
    app: &AppHandle,
    name_tx_part: &str,
    chain_id: u64,
    block_num: u64,
    prestate: bool,
) -> PathBuf {
    let cache_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("optrace"));
    get_cache_path_with_dir(&cache_dir, name_tx_part, chain_id, block_num, prestate)
}

pub(crate) fn get_cache_path_with_dir(
    data_dir: &Path,
    name_tx_part: &str,
    chain_id: u64,
    block_num: u64,
    prestate: bool,
) -> PathBuf {
    let dir = data_dir.join("cache").join("evm_cache").join(chain_id.to_string());
    std::fs::create_dir_all(&dir).ok();
    let suffix = if prestate { "_pre" } else { "" };
    let clean_hash = name_tx_part
        .trim_start_matches("0x")
        .trim_start_matches("0X")
        .to_lowercase();
    dir.join(format!("{}_{}_{}{}.bin", clean_hash, block_num, "alloydb", suffix))
}

pub(crate) fn save_cache(db: &AlloyCacheDB, path: &Path) {
    match bincode::serialize(&db.cache) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(path, bytes) {
                eprintln!("[cache] ✗ write failed: {e}");
            } else {
                println!(
                    "[cache] ✓ saved to {:?} ({} accounts, {} contracts)",
                    path,
                    db.cache.accounts.len(),
                    db.cache.contracts.len()
                );
            }
        }
        Err(e) => eprintln!("[cache] ✗ serialize failed: {e}"),
    }
}

pub(crate) fn read_cache(path: &Path) -> Option<Cache> {
    let bytes = match std::fs::read(path) {
        Ok(b) => {
            println!("[cache] file found: {:?}", path);
            b
        }
        Err(e) => {
            println!("[cache] file not found: {:?} ({})", path, e);
            return None;
        }
    };
    match bincode::deserialize::<Cache>(&bytes) {
        Ok(loaded) => Some(loaded),
        Err(e) => {
            eprintln!("[cache] ✗ deserialize failed from {:?}: {e}", path);
            None
        }
    }
}

pub(crate) fn merge_cache_into(cache_db: &mut AlloyCacheDB, loaded: Cache, path: &Path) {
    let acct = loaded.accounts.len();
    let ctt = loaded.contracts.len();
    cache_db.cache.accounts.extend(loaded.accounts);
    cache_db.cache.contracts.extend(loaded.contracts);
    println!(
        "[cache] ✓ merged from {:?} ({} accounts, {} contracts)",
        path, acct, ctt
    );
}

pub fn dedup_cache_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in paths {
        if seen.insert(p.clone()) {
            out.push(p);
        }
    }
    out
}
