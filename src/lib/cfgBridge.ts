import { emit, listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { invoke, isRunningInVSCode } from "@/lib/ipc-bridge";

/** Cross-window sync (main ↔ CFG and future tools). Use `emit` so any webview can subscribe. */
export const EVT_CROSS_PLAYBACK = "optrace:cross:playback";
export const EVT_CROSS_CFG_SEQ_COMMIT = "optrace:cross:cfg_seq_commit";
export const EVT_CROSS_MAIN_STEP = "optrace:cross:main_step";

export interface CrossPlaybackPayload {
  sessionId: string;
  isPlaying: boolean;
}

/** CFG seq player committed a step (slider release/click, j/k). */
export interface CrossCfgSeqCommitPayload {
  sessionId: string;
  transactionId: number;
  contextId: number;
  seqStep: number;
  globalStepIndex: number;
}

/** Main trace step sync for CFG seq slider (any time the active step changes). */
export interface CrossMainStepPayload {
  sessionId: string;
  stepIndex: number;
  transactionId: number;
  contextId: number;
}

/** Map global trace index to 1-based seq step using parallel `blockEntryGlobalStepIndices`. */
export function globalStepToSeqStep(indices: number[] | undefined, globalStep: number): number {
  if (!indices || indices.length === 0) return 1;
  let best = 0;
  for (let i = 0; i < indices.length; i++) {
    if (indices[i]! <= globalStep) best = i;
    else break;
  }
  return Math.min(best + 1, indices.length);
}

export async function emitCrossPlaybackState(payload: CrossPlaybackPayload) {
  if (isRunningInVSCode()) return;
  await emit(EVT_CROSS_PLAYBACK, payload);
}

export async function emitCrossMainStepSync(payload: CrossMainStepPayload) {
  if (isRunningInVSCode()) return;
  await emit(EVT_CROSS_MAIN_STEP, payload);
}

export async function emitCrossCfgSeqCommit(payload: CrossCfgSeqCommitPayload) {
  if (isRunningInVSCode()) return;
  await emit(EVT_CROSS_CFG_SEQ_COMMIT, payload);
}

export function listenCrossPlayback(handler: (payload: CrossPlaybackPayload) => void) {
  if (isRunningInVSCode()) return Promise.resolve(() => {});
  return listen<CrossPlaybackPayload>(EVT_CROSS_PLAYBACK, (e) => handler(e.payload));
}

export function listenCrossMainStep(handler: (payload: CrossMainStepPayload) => void) {
  if (isRunningInVSCode()) return Promise.resolve(() => {});
  return listen<CrossMainStepPayload>(EVT_CROSS_MAIN_STEP, (e) => handler(e.payload));
}

export function listenCrossCfgSeqCommit(handler: (payload: CrossCfgSeqCommitPayload) => void) {
  if (isRunningInVSCode()) return Promise.resolve(() => {});
  return listen<CrossCfgSeqCommitPayload>(EVT_CROSS_CFG_SEQ_COMMIT, (e) => handler(e.payload));
}

export interface CfgLightStep {
  stepIndex: number;
  transactionId: number;
  contextId: number;
  pc: number;
  opcode: number;
  frameStepCount: number;
  depth: number;
}

/**
 * Aggregated frame entry — replaces raw step batches over IPC.
 * Sending 70万 CfgLightStep objects in one JSON message overflows Safari's JSON stack.
 * We only need unique (transactionId, contextId) pairs + step counts in the CFG window.
 */
export interface CfgFrameEntry {
  transactionId: number;
  contextId: number;
  count: number;
}

/** Build a stable string key from a transactionId + contextId pair. Format: "txId:ctxId" */
export function makeCfgFrameKey(transactionId: number, contextId: number): string {
  return `${transactionId}:${contextId}`;
}

/** Aggregate raw steps into CfgFrameEntry[] (used before emitting to the cfg window). */
export function aggregateStepsToFrames(steps: CfgLightStep[]): CfgFrameEntry[] {
  const map = new Map<string, CfgFrameEntry>();
  for (const s of steps) {
    const k = makeCfgFrameKey(s.transactionId, s.contextId);
    const e = map.get(k);
    if (e) {
      e.count++;
    } else {
      map.set(k, { transactionId: s.transactionId, contextId: s.contextId, count: 1 });
    }
  }
  return [...map.values()];
}

function isCfgWindow(label: string): boolean {
  // Keep backward compatibility for already-opened legacy cfg-* labels.
  return label.startsWith("debug-cfg-") || label.startsWith("cfg-");
}

export async function emitCfgInit(sessionId: string) {
  if (isRunningInVSCode()) {
    invoke('cfg_broadcast', { event: 'optrace:cfg:init', data: { sessionId } }).catch(() => {});
    return;
  }
  const windows = await getAllWebviewWindows();
  await Promise.all(
    windows
      .filter((w) => isCfgWindow(w.label))
      .map((w) => w.emit("optrace:cfg:init", { sessionId })),
  );
}

/**
 * Send aggregated frame entries instead of raw steps.
 * Payload is tiny: one entry per unique (tx, ctx) pair regardless of step count.
 */
export async function emitCfgFrameBatch(sessionId: string, frames: CfgFrameEntry[]) {
  if (frames.length === 0) return;
  if (isRunningInVSCode()) {
    invoke('cfg_broadcast', { event: 'optrace:cfg:frame_batch', data: { sessionId, frames } }).catch(() => {});
    return;
  }
  const windows = await getAllWebviewWindows();
  await Promise.all(
    windows
      .filter((w) => isCfgWindow(w.label))
      .map((w) => w.emit("optrace:cfg:frame_batch", { sessionId, frames })),
  );
}

/** @deprecated Use emitCfgFrameBatch — raw step batches overflow IPC on large traces. */
export async function emitCfgStepBatch(sessionId: string, steps: CfgLightStep[]) {
  if (steps.length === 0) return;
  const frames = aggregateStepsToFrames(steps);
  return emitCfgFrameBatch(sessionId, frames);
}

/** 主窗口播放指针；无 `pc` 时表示清除高亮（如 stepIndex 无效） */
export interface CfgCurrentStepPayload {
  sessionId: string;
  stepIndex: number;
  transactionId: number;
  contextId: number;
  pc?: number;
  prevPc?: number;
}

export async function emitCfgCurrentStep(payload: CfgCurrentStepPayload) {
  if (isRunningInVSCode()) {
    invoke('cfg_broadcast', { event: 'optrace:cfg:current_step', data: payload }).catch(() => {});
    return;
  }
  const windows = await getAllWebviewWindows();
  await Promise.all(
    windows
      .filter((w) => isCfgWindow(w.label))
      .map((w) => w.emit("optrace:cfg:current_step", payload)),
  );
}

