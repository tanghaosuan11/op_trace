//! Session lifecycle utilities shared by all command modules.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::op_trace::debug_session::{DebugSession, SessionEntry};

const SESSION_TTL_MS: u64 = 30 * 60 * 1000; // 30 minutes

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn resolve_required_session_id(
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

pub fn cleanup_stale_sessions(
    sessions: &mut HashMap<String, SessionEntry>,
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

pub fn get_session_by_sid<'a>(
    sessions: &'a HashMap<String, SessionEntry>,
    sid: &str,
) -> Result<&'a DebugSession, String> {
    if let Some(e) = sessions.get(sid) {
        if let Some(ref s) = e.session {
            return Ok(s);
        }
        if e.is_running {
            return Err(format!("Debug session is running for session_id={}", sid));
        }
        return Err(crate::op_trace::debug_session::no_session_error(sid));
    }
    Err(crate::op_trace::debug_session::no_session_error(sid))
}

pub fn get_session_mut_by_sid<'a>(
    sessions: &'a mut HashMap<String, SessionEntry>,
    sid: &str,
) -> Result<&'a mut DebugSession, String> {
    if let Some(e) = sessions.get_mut(sid) {
        if let Some(ref mut s) = e.session {
            return Ok(s);
        }
        if e.is_running {
            return Err(format!("Debug session is running for session_id={}", sid));
        }
        return Err(crate::op_trace::debug_session::no_session_error(sid));
    }
    Err(crate::op_trace::debug_session::no_session_error(sid))
}
