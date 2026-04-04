import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export type ForkInitPayload = {
  tx?: string;
  txData?: unknown;
  blockData?: unknown;
  txDataList?: unknown;
  txSlots?: unknown;
  debugByTx?: boolean;
  condNodes?: unknown;
  forkPatches?: unknown;
  rpcUrl?: string;
};

export function createNewSessionId() {
  return `sess_${crypto.randomUUID()}`;
}

export function openDebugWindow(
  sessionId = createNewSessionId(),
  opts?: { readonly?: boolean; mode?: "normal" | "whatif" | "cfg" },
) {
  const label = `debug-${sessionId}`;
  const readonly = opts?.readonly ?? false;
  const mode = opts?.mode ?? "normal";
  const url = `/?sessionId=${encodeURIComponent(sessionId)}${readonly ? "&readonly=1" : ""}${mode !== "normal" ? `&mode=${encodeURIComponent(mode)}` : ""}`;
  const w = new WebviewWindow(label, {
    url,
    title: `OpTrace (${sessionId.slice(0, 8)})${readonly ? " [readonly]" : ""}`,
    width: 1500,
    height: 900,
  });
  // best-effort focus
  w.once("tauri://created", () => {
    w.setFocus().catch(() => {});
  });
  return { window: w, sessionId };
}

export function openForkWindow(payload: ForkInitPayload, opts?: { readonly?: boolean }) {
  const { window, sessionId } = openDebugWindow(undefined, { readonly: opts?.readonly ?? true, mode: "whatif" });
  window.once("tauri://created", () => {
    const init = { ...payload, sessionId };
    console.log("[fork.window] emitting optrace:init", {
      sessionId,
      hasTx: !!init.tx,
      hasTxData: !!init.txData,
      hasBlockData: !!init.blockData,
      txDataListLen: Array.isArray((init as { txDataList?: unknown[] }).txDataList)
        ? (init as { txDataList?: unknown[] }).txDataList?.length
        : undefined,
      txSlotsLen: Array.isArray((init as { txSlots?: unknown[] }).txSlots)
        ? (init as { txSlots?: unknown[] }).txSlots?.length
        : undefined,
      debugByTx: (init as { debugByTx?: boolean }).debugByTx,
      condNodesLen: Array.isArray((init as any).condNodes) ? (init as any).condNodes.length : undefined,
      forkPatchesLen: Array.isArray((init as any).forkPatches) ? (init as any).forkPatches.length : undefined,
    });
    // Avoid race: receiver may not have installed listener yet.
    const emitOnce = (tag: string) =>
      window.emit("optrace:init", init).then(
        () => console.log(`[fork.window] emit optrace:init ok (${tag})`),
        (e) => console.error(`[fork.window] emit optrace:init failed (${tag})`, e),
      );
    setTimeout(() => emitOnce("t+250ms"), 250);
    setTimeout(() => emitOnce("t+1250ms"), 1250);
  });
  return { window, sessionId };
}

export function openCfgWindow(sessionId: string, opts?: { readonly?: boolean }) {
  // Use debug-* prefix to satisfy existing tauri plugin allowlist.
  // Append timestamp so re-opening after close always creates a fresh window
  // (same label on a closed window may silently skip tauri://created in Tauri v2).
  const label = `debug-cfg-${sessionId}-${Date.now()}`;
  const readonly = opts?.readonly ?? true;
  const url = `/?sessionId=${encodeURIComponent(sessionId)}${readonly ? "&readonly=1" : ""}&mode=cfg`;
  const window = new WebviewWindow(label, {
    url,
    title: `OpTrace CFG (${sessionId.slice(0, 8)})`,
    width: 1300,
    height: 820,
  });
  window.once("tauri://created", () => {
    window.setFocus().catch(() => {});
  });
  // 不要在这里发 optrace:cfg:init：init 会清空 CFG 帧表，且此处没有配套的 frame_batch，
  // 会在主进程已推送数据之后再次清空列表（常见现象：闪一下又变空）。
  // 会话同步由主窗口 handleOpenCfgWindow 的 emitCfgInit + emitCfgFrameBatch 负责。
  return { window, sessionId };
}

