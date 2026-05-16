//! Foundry dump 调试命令（方案A+B：流式发送 + 同步写入 DebugSession）
//!
//! 读取文件夹中的 optrace_dump.json + optrace_calltree.json，
//! 加载 out/ 子目录中的字节码，通过 MessageEncoder 流式发送给前端（方案A），
//! 同时填充 DebugSession 并存入全局状态，使 seek_to 可用（方案B）。
//!
//! 关键：按 debug_arena 节点的 DFS 执行顺序回放，而非按逻辑帧顺序。
//! 每个 arena 节点是单个帧上下文的一段连续执行（直到下一次子调用为止）。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use revm::primitives::{Address, U256};
use revm_interpreter::InstructionResult;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::op_trace::message_encoder::BytesSender;
use crate::op_trace::{
    debug_session::{
        DebugSession, FrameRecord, FrameTerminalState, KeccakRecord, StorageChangeRecord,
        TraceStep, normalize_session_id,
    },
    foundry_calltree::{parse_calltree, CallTreeFrame},
    foundry_dump::{
        extract_keccak_ops, load_all_bytecodes_from_out, load_foundry_session,
        merge_dump_and_calltree, build_emit_texts_by_wire_fid, build_setup_wire_fids,
        FoundryArtifact, FoundryKeccakOp,
        FoundryLogicalFrame, FoundrySession, FoundrySourceMapEntry,
    },
    message_encoder::MessageEncoder,
    DebugSessionState, FrameInfo,
};

// ─── Tauri 命令 ───────────────────────────────────────────────────────────────

/// Shared replay implementation used by both the Tauri command and the daemon.
/// The `sender` callback receives raw binary frames (same format as op_trace).
pub async fn start_foundry_debug_impl(
    folder_path: String,
    session_id: Option<String>,
    sender: BytesSender,
    session_state: Arc<std::sync::Mutex<crate::op_trace::debug_session::DebugSessionMap>>,
) -> Result<(), String> {
    let dump_path = format!("{}/optrace_dump.json", folder_path);
    let calltree_path = format!("{}/optrace_calltree.json", folder_path);
    let out_dir = format!("{}/out", folder_path);

    let session = load_foundry_session(&dump_path)?;

    let calltree_frames: Vec<CallTreeFrame> = match std::fs::read_to_string(&calltree_path) {
        Ok(text) => parse_calltree(&text),
        Err(e) => {
            eprintln!("[foundry] cannot read calltree: {e}");
            Vec::new()
        }
    };

    let frame_info_map: HashMap<u16, FrameInfo> = if calltree_frames.is_empty() {
        HashMap::new()
    } else {
        match merge_dump_and_calltree(&session, &calltree_frames, 0) {
            Ok(fi_vec) => fi_vec.into_iter().map(|mut fi| {
                let old_id = fi.frame_id;
                fi.frame_id = old_id + 1;
                fi.parent_id = if fi.parent_id == u16::MAX { 0 } else { fi.parent_id + 1 };
                (old_id, fi)
            }).collect(),
            Err(e) => {
                eprintln!("[foundry] merge failed: {e}");
                HashMap::new()
            }
        }
    };

    let bytecodes = load_all_bytecodes_from_out(&session, &out_dir);
    let sid_norm = normalize_session_id(session_id.as_deref());
    let setup_wire_fids = build_setup_wire_fids(&session, &calltree_frames);

    tokio::task::spawn_blocking(move || {
        let mut debug_sess = DebugSession::new();
        replay_session(&session, &frame_info_map, &calltree_frames, &bytecodes, sender, 0, &mut debug_sess, &setup_wire_fids);

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let mut guard = session_state.lock().unwrap();
        let entry = guard.entry(sid_norm).or_default();
        entry.session = Some(debug_sess);
        entry.is_running = false;
        entry.updated_at_ms = now_ms;
    })
    .await
    .map_err(|e| format!("replay task panicked: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn start_foundry_debug(
    folder_path: String,
    session_id: Option<String>,
    channel: Channel,
    state: tauri::State<'_, DebugSessionState>,
) -> Result<(), String> {
    let sender: BytesSender = Arc::new(move |data: Vec<u8>| {
        let _ = channel.send(InvokeResponseBody::Raw(data));
    });
    start_foundry_debug_impl(
        folder_path,
        session_id,
        sender,
        Arc::clone(&state.0),
    ).await
}

// ─── 回放逻辑 ─────────────────────────────────────────────────────────────────

/// 按 debug_arena DFS 执行顺序流式回放。
///
/// 正确执行顺序（父→子→父续）：
///   arena[0]  → 父帧前段步骤
///   arena[1]  → 子帧全部步骤
///   arena[2]  → 父帧后段步骤（从 CALL 返回处继续）
///
/// FrameEnter 在首次遇到某帧时发送；FrameExit 在该帧最后一个 arena 节点处理完后发送。
/// setUp 子树帧（wire_fid 在 setup_wire_fids 中）会被跳过，不发送给前端。
fn replay_session(
    session: &FoundrySession,
    frame_info_map: &HashMap<u16, FrameInfo>,
    calltree_frames: &[CallTreeFrame],
    bytecodes: &HashMap<String, Vec<u8>>,
    sender: BytesSender,
    transaction_id: u32,
    debug_sess: &mut DebugSession,
    setup_wire_fids: &HashSet<u16>,
) {
    // ── 预计算辅助表 ──────────────────────────────────────────────────────────

    // arena_node_index → frame_id
    let mut node_to_fid = vec![0u16; session.arena.len()];
    for lf in &session.frames {
        for &ni in &lf.node_indices {
            node_to_fid[ni] = lf.frame_id;
        }
    }

    // arena_node_index → 该节点在其逻辑帧内的累计步骤起始偏移
    let mut frame_step_offset = vec![0usize; session.arena.len()];
    for lf in &session.frames {
        let mut cumulative = 0usize;
        for &ni in &lf.node_indices {
            frame_step_offset[ni] = cumulative;
            cumulative += session.arena[ni].steps.len();
        }
    }

    // frame_id → 该帧的最后一个 arena node index
    let last_node_for_frame: HashMap<u16, usize> = session
        .frames
        .iter()
        .filter_map(|f| f.node_indices.last().map(|&ni| (f.frame_id, ni)))
        .collect();

    // (frame_id, step_index_in_frame) → KeccakOp
    let keccak_ops = extract_keccak_ops(session);
    let keccak_by_step: HashMap<(u16, usize), &FoundryKeccakOp> = keccak_ops
        .iter()
        .map(|k| ((k.frame_id, k.step_index_in_frame), k))
        .collect();

    // wire_fid → emit 文本列表（来自 calltree，忽略 setUp 子树）
    let emit_texts_by_fid = build_emit_texts_by_wire_fid(session, calltree_frames);
    // 每帧 emit 消费指针
    let mut emit_ptr_by_fid: HashMap<u16, usize> = HashMap::new();

    let mut encoder = MessageEncoder::new(sender);
    let mut frame_entered = HashSet::<u16>::new();
    let mut global_step = 0usize;

    // ── 按 arena 节点顺序回放 ─────────────────────────────────────────────────

    for (ni, arena_node) in session.arena.iter().enumerate() {
        let fid = node_to_fid[ni];              // 0-based 内部索引（用于查表）
        let wire_fid = fid + 1;                 // 1-based wire frame_id（与 inspector 一致）
        let lf = &session.frames[fid as usize];

        // ── setUp 子树跳过：不发送给前端 ──────────────────────────────────
        if setup_wire_fids.contains(&wire_fid) {
            continue; // 不累计 global_step，发给前端的步骤索引必须连续
        }

        // ── FrameEnter（首次进入该帧）──────────────────────────────────────
        if frame_entered.insert(fid) {
            if let Some(fi) = frame_info_map.get(&fid) {
                // calltree 匹配到：使用带真实 value/caller 的 FrameInfo
                encoder.send_frame_enter(fi);
            } else {
                // 未匹配：从 FoundryLogicalFrame 构建回退信息
                let fallback = build_frame_enter(lf, session, transaction_id);
                encoder.send_frame_enter(&fallback);
            }

            // ContractSource（字节码）—— 必须发送，前端据此创建 CallFrame
            let bc = session
                .identified_contracts
                .get(&lf.address)
                .and_then(|name| bytecodes.get(name));
            // 没有字节码时发送 [0xfe]（INVALID），确保前端创建 CallFrame
            let dummy_bc: Vec<u8> = vec![0xfe];
            let bytecode = bc.map(|v| v.as_slice()).unwrap_or(&dummy_bc);
            encoder.send_contract_source(lf.depth, transaction_id, wire_fid, bytecode);

            // Foundry 模式源码+sourcemap（仅内存，不写磁盘）
            if let Some(json_bytes) = build_source_json_for_frame(session, lf) {
                encoder.send_foundry_source_json(transaction_id, wire_fid, &json_bytes);
            }

            let addr: Address = lf.address.parse().unwrap_or_default();
            let (fr_parent_id, fr_depth, fr_address, fr_caller, fr_target, fr_kind) =
                if let Some(fi) = frame_info_map.get(&fid) {
                    (fi.parent_id, fi.depth, fi.address, fi.caller, fi.target_address,
                     format!("{:?}", fi.kind))
                } else {
                    let caller_addr: Address = lf.parent_id
                        .and_then(|pid| session.frames.get(pid as usize))
                        .and_then(|pf| pf.address.parse::<Address>().ok())
                        .unwrap_or_default();
                    (lf.parent_id.map(|p| p + 1).unwrap_or(0), lf.depth,
                     addr, caller_addr, addr, lf.kind.clone())
                };
            debug_sess.push_frame_record(FrameRecord {
                transaction_id,
                frame_id: wire_fid,
                parent_id: fr_parent_id,
                depth: fr_depth,
                address: fr_address,
                caller: fr_caller,
                target_address: fr_target,
                kind: fr_kind,
                gas_limit: lf.gas_limit,
                gas_used: 0,
                step_count: 0,
                success: false,
                reverted_by_parent: false,
            });
            debug_sess.frame_bytecodes.insert((transaction_id, wire_fid), bytecode.to_vec());
        }

        // ── 发送该节点的所有步骤 ────────────────────────────────────────────
        let step_offset = frame_step_offset[ni];

        for (si_local, step) in arena_node.steps.iter().enumerate() {
            let si_frame = step_offset + si_local;

            let stack: Vec<U256> = step.stack.iter().map(|h| parse_hex_u256(h)).collect();

            encoder.pack_step(
                transaction_id,
                step.pc as u64,
                step.op,
                wire_fid,
                lf.depth,
                step.gas_remaining,
                &stack,
                si_frame,
            );
            encoder.backfill_gas_cost(step.gas_cost);

            let contract_addr: Address = lf.address.parse().unwrap_or_default();
            debug_sess.push_step(TraceStep {
                transaction_id,
                context_id: wire_fid,
                frame_step: si_frame as u32,
                pc: step.pc,
                opcode: step.op,
                gas_cost: step.gas_cost,
                gas_remaining: step.gas_remaining,
                stack: stack.clone(),
                contract_address: contract_addr,
                call_target: contract_addr,
            });
            // 每 50 步推一次完整内存快照（Foundry dump 有每步内存）
            if si_frame % 50 == 0 {
                let mem_bytes = step.memory.as_deref()
                    .map(|s| hex::decode(s.trim_start_matches("0x")).unwrap_or_default())
                    .unwrap_or_default();
                debug_sess.push_snapshot(transaction_id, wire_fid, si_frame as u32, mem_bytes);
            }

            // StorageChange（SLOAD / SSTORE / TLOAD / TSTORE）
            // step_index = global_step + 1，与 inspector 一致（step_end 中 step_count 已递增）
            if let Some(sc) = &step.storage_change {
                let key_val = parse_hex_u256(&sc.key);
                let old_val = sc.had_value.as_deref().map(parse_hex_u256).unwrap_or(U256::ZERO);
                let new_val = parse_hex_u256(&sc.value);
                let is_read = !sc.is_write.unwrap_or(true);
                let is_transient = step.op == 0x5c || step.op == 0x5d; // TLOAD / TSTORE
                let sc_addr: Address = lf.address.parse().unwrap_or_default();
                encoder.send_storage_change(
                    is_transient,
                    is_read,
                    wire_fid,
                    global_step + 1,
                    transaction_id,
                    sc_addr,
                    key_val,
                    old_val,
                    new_val,
                );
                debug_sess.push_storage_change(StorageChangeRecord {
                    step_index: global_step + 1,
                    transaction_id,
                    frame_id: wire_fid,
                    is_transient,
                    is_read,
                    address: sc_addr,
                    key: key_val,
                    old_value: old_val,
                    new_value: new_val,
                });
            }

            // KeccakOp（0x20 KECCAK256）
            if let Some(kop) = keccak_by_step.get(&(fid, si_frame)) {
                encoder.send_keccak_op(transaction_id, wire_fid, global_step, &kop.hash, &kop.input);
                debug_sess.push_keccak_op(KeccakRecord {
                    step_index: global_step,
                    transaction_id,
                    frame_id: wire_fid,
                    input: kop.input.clone(),
                    hash: kop.hash,
                });
            }

            // LOG0-4（0xa0-0xa4）— 从 calltree emit 列表中获取文本，从 EVM 栈提取真实 topics
            if step.op >= 0xa0 && step.op <= 0xa4 {
                let num_topics = (step.op - 0xa0) as usize;
                    let topics: Vec<String> = (0..num_topics)
                    .map(|i| {
                        let idx = step.stack.len().saturating_sub(3 + i);
                        let raw = step.stack.get(idx).map(|s| s.trim_start_matches("0x")).unwrap_or("");
                        format!("0x{:0>64}", raw)
                    })
                    .collect();
                let emit_text = emit_texts_by_fid
                    .get(&wire_fid)
                    .and_then(|v| {
                        let ptr = emit_ptr_by_fid.entry(wire_fid).or_insert(0);
                        let text = v.get(*ptr).map(|s| s.as_str());
                        if text.is_some() { *ptr += 1; }
                        text
                    });
                let data_hex = emit_text
                    .map(|t| format!("0x{}", hex::encode(t.as_bytes())))
                    .unwrap_or_else(|| "0x".to_string());
                let addr = lf.address.to_lowercase();
                let addr = if addr.starts_with("0x") { addr } else { format!("0x{}", addr) };
                let log_json = serde_json::json!({
                    "address": addr,
                    "topics": topics,
                    "data": data_hex,
                }).to_string();
                encoder.send_log_data(wire_fid, global_step, transaction_id, &log_json);
            }

            global_step += 1;
        }

        // ── FrameExit（该帧最后一个 arena 节点处理完）─────────────────────
        if last_node_for_frame.get(&fid) == Some(&ni) {
            encoder.flush_steps();

            let success = match lf.status.as_deref() {
                Some(s) => s == "Return" || s == "Stop",
                None => frame_info_map.get(&fid).map(|fi| fi.success).unwrap_or(false),
            };
            let output = lf
                .returndata
                .as_deref()
                .and_then(|hex| ::hex::decode(hex.trim_start_matches("0x")).ok())
                .unwrap_or_default();
            let result = if success {
                InstructionResult::Return
            } else {
                InstructionResult::Revert
            };

            encoder.send_frame_exit(transaction_id, wire_fid, result, success, lf.gas_used, &output);

            debug_sess.finalize_frame(transaction_id, wire_fid, lf.gas_used, success, lf.total_step_count);

            if let Some(last_step) = arena_node.steps.last() {
                let last_step_count = frame_step_offset[ni] + arena_node.steps.len();
                let terminal_frame_step = if last_step_count > 0 { last_step_count - 1 } else { 0 };
                let terminal_stack: Vec<U256> = last_step.stack.iter().map(|h| parse_hex_u256(h)).collect();
                let terminal_mem = last_step.memory.as_deref()
                    .map(|s| hex::decode(s.trim_start_matches("0x")).unwrap_or_default())
                    .unwrap_or_default();
                debug_sess.set_terminal_state(transaction_id, wire_fid, FrameTerminalState {
                    pc: last_step.pc,
                    opcode: last_step.op,
                    stack: terminal_stack,
                    memory: terminal_mem,
                });
                debug_sess.push_snapshot(
                    transaction_id, wire_fid,
                    terminal_frame_step as u32,
                    last_step.memory.as_deref()
                        .map(|s| hex::decode(s.trim_start_matches("0x")).unwrap_or_default())
                        .unwrap_or_default(),
                );
            }
        }
    }

    // ── VM helper 帧（calltree 中有但 dump 中无对应的帧，如 VM::assertEq）────────
    {
        // 建立 calltree_idx → wire_fid 映射（复用 match_frames 的匹配逻辑）
        let mut ci_to_wire_fid: HashMap<usize, u16> = HashMap::new();
        let mut used_ci: HashSet<usize> = HashSet::new();
        for (di, df) in session.frames.iter().enumerate() {
            for (ci, cf) in calltree_frames.iter().enumerate() {
                if used_ci.contains(&ci) { continue; }
                if cf.is_in_setup { continue; }  // setUp 帧不参与匹配
                if cf.depth as u16 != df.depth || cf.gas_used != df.gas_used { continue; }
                ci_to_wire_fid.insert(ci, di as u16 + 1); // 1-based wire_fid
                used_ci.insert(ci);
                break;
            }
        }

        let mut helper_local_idx = 0usize;
        for (ci, cf) in calltree_frames.iter().enumerate() {
            if cf.is_in_setup { continue; }           // setUp 帧不作为 VM helper 发给前端
            if ci_to_wire_fid.contains_key(&ci) { continue; }

            let helper_wire_fid = 0x8000u16 + helper_local_idx as u16;
            let parent_wire_fid = cf.parent_idx
                .and_then(|pi| ci_to_wire_fid.get(&pi).copied())
                .unwrap_or(1u16);
            // "Stop" 也是正常结束（无返回值），不能误判为 revert
            let success = matches!(cf.status.as_deref(), Some("Return") | Some("Stop"));

            // 找出 calltree 中在本 helper 之后的第一个真实 EVM 兄弟帧的 wire_fid
            // 前端据此把 helper 插到该兄弟帧 node 之前（而非全部追加末尾）
            let insert_before_ctx_id: u16 = cf.parent_idx
                .and_then(|parent_ci| {
                    let parent_cf = &calltree_frames[parent_ci];
                    let pos = parent_cf.children.iter().position(|&c| c == ci)?;
                    parent_cf.children[pos + 1..].iter()
                        .find_map(|&sib_ci| ci_to_wire_fid.get(&sib_ci).copied())
                })
                .unwrap_or(0u16);

            encoder.send_frame_enter(&serde_json::json!({
                "transaction_id": transaction_id,
                "frame_id": helper_wire_fid,
                "parent_id": parent_wire_fid,
                "depth": cf.depth,
                "address": "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d",
                "caller": "0x0000000000000000000000000000000000000000",
                "target_address": &cf.target,
                "kind": cf.call_type.as_deref().unwrap_or("staticcall"),
                "gas_limit": 0u64,
                "gas_used": cf.gas_used,
                "step_count": 0usize,
                "success": success,
                "value": "0x0000000000000000000000000000000000000000000000000000000000000000",
                "input": "0x",
                "output": "0x",
                "is_vm_helper": true,
                "args": cf.call_args.as_deref().unwrap_or(""),
                "insert_before_ctx_id": insert_before_ctx_id
            }));
            encoder.send_contract_source(cf.depth as u16, transaction_id, helper_wire_fid, &[0xfe]);
            encoder.send_frame_exit(
                transaction_id, helper_wire_fid,
                if success { InstructionResult::Return } else { InstructionResult::Revert },
                success, cf.gas_used, &[],
            );

            helper_local_idx += 1;
        }
    }

    encoder.send_finished(None);
}

// ─── 回退 FrameEnter JSON ─────────────────────────────────────────────────────

/// calltree 未匹配时用 FoundryLogicalFrame 构建最小 FrameEnter 信息
#[derive(serde::Serialize)]
struct FrameEnterFallback {
    transaction_id: u32,
    frame_id: u16,
    parent_id: u16,
    depth: u16,
    address: String,
    caller: String,
    target_address: String,
    /// lowercase call kind
    kind: String,
    gas_limit: u64,
    gas_used: u64,
    /// 默认 0 ETH（calltree 未知）
    value: &'static str,
    input: String,
    step_count: usize,
    success: bool,
    output: String,
}

fn build_frame_enter(
    lf: &FoundryLogicalFrame,
    session: &FoundrySession,
    transaction_id: u32,
) -> FrameEnterFallback {
    let caller = lf
        .parent_id
        .and_then(|pid| session.frames.get(pid as usize))
        .map(|pf| fmt_addr(&pf.address))
        .unwrap_or_else(|| "0x0000000000000000000000000000000000000000".to_string());

    let success = lf
        .status
        .as_deref()
        .map_or(false, |s| s == "Return" || s == "Stop");

    FrameEnterFallback {
        transaction_id,
        frame_id: lf.frame_id + 1,
        parent_id: lf.parent_id.map(|p| p + 1).unwrap_or(0),
        depth: lf.depth,
        address: fmt_addr(&lf.address),
        caller,
        target_address: fmt_addr(&lf.address),
        kind: lf.kind.to_lowercase(),
        gas_limit: lf.gas_limit,
        gas_used: lf.gas_used,
        value: "0x0000000000000000000000000000000000000000000000000000000000000000",
        input: lf.calldata.clone(),
        step_count: lf.total_step_count,
        success,
        output: lf.returndata.clone().unwrap_or_else(|| "0x".to_string()),
    }
}

// ─── 辅助函数 ────────────────────────────────────────────────────────────────

/// 重建 sourcemap 字符串（将 FoundrySourceMapEntry 列表列压成「s:l:f:j;...」格式）
fn reconstruct_sourcemap_str(entries: &[FoundrySourceMapEntry]) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(entries.len());
    let (mut pv_s, mut pv_l, mut pv_f, mut pv_j) = (u32::MAX, u32::MAX, i32::MIN, 0u8);
    for e in entries {
        let s = if e.offset != pv_s { e.offset.to_string() } else { String::new() };
        let l = if e.length != pv_l { e.length.to_string() } else { String::new() };
        let f = if e.index  != pv_f { e.index.to_string()  } else { String::new() };
        let jc = match e.jump { b'i' => 'i', b'o' => 'o', _ => '-' };
        let j = if e.jump != pv_j { jc.to_string() } else { String::new() };
        let mut raw = format!("{}:{}:{}:{}", s, l, f, j);
        while raw.ends_with(':') { raw.pop(); }
        parts.push(raw);
        pv_s = e.offset; pv_l = e.length; pv_f = e.index; pv_j = e.jump;
    }
    parts.join(";")
}

/// 为指定帧构建 Sourcify 兼容的 JSON（sources + sourceIds + runtimeBytecode.sourceMap）
/// 返回 None 表示该帧无法匹配到源码
fn build_source_json_for_frame(
    session: &FoundrySession,
    lf: &FoundryLogicalFrame,
) -> Option<Vec<u8>> {
    let contract_name = session.identified_contracts.get(&lf.address)?;
    let artifact: &FoundryArtifact = session.artifacts_by_name.get(contract_name)?.first()?;
    let build_sources = session.sources_by_id.get(&artifact.build_id)?;

    let mut sources_obj = serde_json::Map::new();
    let mut source_ids_obj = serde_json::Map::new();
    for (file_id_str, entry) in build_sources {
        if let Ok(file_id) = file_id_str.parse::<i64>() {
            sources_obj.insert(
                entry.path.clone(),
                serde_json::json!({ "content": entry.source }),
            );
            source_ids_obj.insert(
                entry.path.clone(),
                serde_json::json!({ "id": file_id }),
            );
        }
    }
    if sources_obj.is_empty() {
        return None;
    }

    let sourcemap_str = artifact
        .source_map_runtime
        .as_ref()
        .map(|v| reconstruct_sourcemap_str(v))
        .unwrap_or_default();

    let json_val = serde_json::json!({
        "sources": sources_obj,
        "sourceIds": source_ids_obj,
        "runtimeBytecode": { "sourceMap": sourcemap_str },
    });
    serde_json::to_vec(&json_val).ok()
}

fn fmt_addr(addr: &str) -> String {
    if addr.starts_with("0x") || addr.starts_with("0X") {
        addr.to_lowercase()
    } else {
        format!("0x{}", addr.to_lowercase())
    }
}

fn parse_hex_u256(hex: &str) -> U256 {
    let trimmed = hex.trim_start_matches("0x").trim_start_matches("0X");
    U256::from_str_radix(trimmed, 16).unwrap_or(U256::ZERO)
}


