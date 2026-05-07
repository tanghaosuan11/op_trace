import { useCallback, useEffect, useRef, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ipcCommands } from "@/lib/ipcConfig";
import { migrateFromLocalStorage } from "@/lib/tauriStore";
import { initUserFourbyteDb } from "@/lib/userFourbyteDb";
import { initRpcConfig } from "@/lib/rpcConfig";
import { DebugToolbar } from "@/components/DebugToolbar";
import { DebugPanel } from "@/components/DebugPanel";
import { TabBar } from "@/components/TabBar";
import { MainInterface } from "@/components/MainInterface";
import { DrawerHost } from "@/components/DrawerHost";
import { DataFlowDrawer } from "@/components/DataFlowModal";
import { CfgWindow } from "@/components/CfgWindow";
// import { NotesDrawer } from "@/components/NotesDrawer";
import { BookmarksDrawer } from "@/components/BookmarksDrawer";
import { StepPlaybackFloatingBar } from "@/components/StepPlaybackFloatingBar";
import { CondScanDrawer } from "@/components/CondScanDrawer";
import { FloatingPanelProvider } from "@/components/floating-panel";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import "./App.css";
import { type CallFrame, type CallTreeNode } from "./lib/types";
import { useDebugPlayback } from "./hooks/useDebugPlayback";
import { type TxData, type BlockData, type TxListRow, type TxSlot } from "./lib/txFetcher";
import { loadAppConfig, initAppConfig, setConfig } from "./lib/appConfig";
import { useDebugStore } from "./store/debugStore";
import { startDebugAction, resetAllAction, debugDump, startFoundryDebugAction } from "./lib/debugActions";
import { useNavigation } from "./hooks/useNavigation";
import { useConditionScan } from "./hooks/useConditionScan";
import { useBreakpoints } from "./hooks/useBreakpoints";
import { useStepPlayback } from "./hooks/useStepPlayback";
import { useTabSync } from "./hooks/useTabSync";
import { useFourbyteResolver } from "./hooks/useFourbyteResolver";
import { useActiveFrameProjection } from "./hooks/useActiveFrameProjection";
import { HintOverlay } from "@/components/HintOverlay";
import { PanelHintOverlay } from "@/components/PanelHintOverlay";
import { KeyboardShortcutsHelpDialog } from "@/components/KeyboardShortcutsHelpDialog";
import { CommandPaletteDialog } from "@/components/CommandPaletteDialog";
import { useDebugCommandBindings } from "./hooks/useDebugCommandBindings";
import { useDebugRuntimeRefs } from "./hooks/useDebugRuntimeRefs";
import { getWindowMode } from "./lib/windowMode";
import { openCfgWindow } from "./lib/windowActions";
import { useForkStore } from "./store/forkStore";
import {
  aggregateStepsToFrames,
  emitCfgCurrentStep,
  emitCfgFrameBatch,
  emitCfgInit,
  emitCrossMainStepSync,
  listenCrossCfgSeqCommit,
  makeCfgFrameKey,
  type CfgFrameEntry,
} from "./lib/cfgBridge";
import { extractStepIndicesFromAnalysisResult } from "@/lib/analysisResultStepIndices";
import { frameTabId } from "@/lib/frameScope";


function App() {
  const isWhatIfMode = getWindowMode().mode === "whatif";
  const isCfgMode = getWindowMode().mode === "cfg";
  const whatIfAutoStartedRef = useRef(false);
  const whatIfInitReceivedRef = useRef(false);
  const startDebugRef = useRef<() => void>(() => {});
  const [whatIfInitStatus, setWhatIfInitStatus] = useState<string>("Waiting for whatif init payload...");
  const [cfgSessionId, setCfgSessionId] = useState<string>("");
  // Map<frameKey, CfgFrameEntry> — replaces raw 700k-step array
  const [cfgFrames, setCfgFrames] = useState<Map<string, CfgFrameEntry>>(new Map());
  const cfgEmittedIndexRef = useRef(0);
  // State subscriptions
  const { sync: storeSync } = useDebugStore.getState();
  const activeTab = useDebugStore((s) => s.activeTab);
  const tabHistory = useDebugStore((s) => s.tabHistory);
  const callFrames = useDebugStore((s) => s.callFrames);
  const currentStepIndex = useDebugStore((s) => s.currentStepIndex);
  const stepCount = useDebugStore((s) => s.stepCount);
  const breakpointPcsMap = useDebugStore((s) => s.breakpointPcsMap);
  const scanUrl = useDebugStore((s) => s.config.scanUrl);
  const isDebugUi = useDebugStore((s) => s.config.isDebug);
  const isPlaying = useDebugStore((s) => s.isPlaying);
  const sessionIdFromStore = useDebugStore((s) => s.sessionId);

  const {
    sessionIdRef,
    allStepsRef,
    callFramesRef,
    callTreeRef,
    messageRuntimeRef,
    stepIndexByContextRef,
    opcodeIndexRef,
    isPlayingRef,
    currentStepIndexRef,
    activeTabRef,
    batchSizeRef,
    breakOpcodesRef,
    fullDataThresholdRef,
    fullDataCacheRef,
    cacheVersionRef,
    cacheTimerRef,
    breakpointPcsRef,
    conditionHitSetRef,
  } = useDebugRuntimeRefs();

  // Panel scroll container refs for keyboard scrolling
  const opcodeScrollRef = useRef<HTMLDivElement>(null);
  const stackScrollRef = useRef<HTMLDivElement>(null);
  const memoryScrollRef = useRef<HTMLDivElement>(null);
  const storageScrollRef = useRef<HTMLDivElement>(null);

  // 从 Tauri Store 加载各模块缓存 + 迁移 localStorage
  useEffect(() => {
    (async () => {
      await migrateFromLocalStorage();
      await Promise.all([initAppConfig(), initRpcConfig(), initUserFourbyteDb()]);
      storeSync(loadAppConfig());
    })();
    // breakOpcodes 持久化到 tauri store
    load("config.json", { autoSave: true, defaults: {} }).then(store => {
      store.get<number[]>("breakOpcodes").then(saved => {
        if (saved && saved.length > 0) {
          const s = new Set<number>(saved);
          breakOpcodesRef.current = s;
          storeSync({ breakOpcodes: s });
        }
      });
    });
    if (import.meta.env.DEV) {
      // @ts-ignore
      window.invoke = invoke; // for debug
    }
  }, []);

  useEffect(() => {
    storeSync({ sessionId: sessionIdRef.current });
  }, [sessionIdRef, storeSync]);

  // 仅 release 下关闭系统默认右键菜单；debug UI 开关可强制启用（便于 Inspect/Reload）
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__OPTRACE_ENABLE_CONTEXT_MENU__ = Boolean(import.meta.env.DEV || isDebugUi);
  }, [isDebugUi]);

  // Window close -> release backend session
  // CFG / readonly windows do NOT own the session — skip reset to avoid
  // deleting a session that the main debug window still needs.
  useEffect(() => {
    if (isCfgMode || getWindowMode().readonly) return;
    const w = getCurrentWindow();
    const unlistenP = w.onCloseRequested(() => {
      invoke(ipcCommands.resetSession, { sessionId: sessionIdRef.current }).catch(() => {});
    });
    return () => {
      unlistenP.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [sessionIdRef, isCfgMode]);

  // Window init payload (fork/whatif)
  useEffect(() => {
    const w = getCurrentWindow();
    const unlistenP = w.listen<{
      tx?: string;
      txData?: TxData;
      blockData?: BlockData;
      txDataList?: TxListRow[];
      txSlots?: TxSlot[];
      debugByTx?: boolean;
      condNodes?: unknown;
      forkPatches?: unknown;
      rpcUrl?: string;
    }>(
      "optrace:init",
      (ev) => {
        const p = ev.payload || {};
        const hasTxDataList = Array.isArray(p.txDataList) && p.txDataList.length > 0;
        whatIfInitReceivedRef.current = true;
        console.log("[whatif.init] received optrace:init", {
          isWhatIfMode,
          hasTx: !!p.tx,
          hasTxData: !!p.txData,
          hasBlockData: !!p.blockData,
          txDataListLen: hasTxDataList ? p.txDataList!.length : 0,
          txSlotsLen: Array.isArray(p.txSlots) ? p.txSlots.length : 0,
          debugByTx: p.debugByTx,
          condNodesLen: Array.isArray((p as any).condNodes) ? (p as any).condNodes.length : undefined,
          forkPatchesLen: Array.isArray((p as any).forkPatches) ? (p as any).forkPatches.length : undefined,
          rpcUrl: p.rpcUrl ? "(set)" : "(unset)",
        });
        setWhatIfInitStatus("Init payload received.");
        if (p.tx && p.txData && p.blockData) {
          const h = (p.tx as string).trim().startsWith("0x") ? (p.tx as string).trim() : `0x${p.tx}`;
          storeSync({
            tx: h.startsWith("0x") ? h.slice(2) : h,
            txData: p.txData as TxData,
            blockData: p.blockData as BlockData,
            txSlots: [
              {
                hash: h,
                txData: p.txData as TxData,
                blockData: p.blockData as BlockData,
                error: "",
                isFetching: false,
              },
            ],
            ...(hasTxDataList ? { txDataList: p.txDataList as TxListRow[], debugByTx: false } : {}),
            ...(Array.isArray(p.txSlots) ? { txSlots: p.txSlots as TxSlot[], debugByTx: !!p.debugByTx } : {}),
          });
        } else {
          if (p.tx) storeSync({ tx: p.tx });
          if (p.txData) storeSync({ txData: p.txData as TxData });
          if (p.blockData) storeSync({ blockData: p.blockData as BlockData });
          if (hasTxDataList) storeSync({ txDataList: p.txDataList as TxListRow[], debugByTx: false });
          if (Array.isArray(p.txSlots)) storeSync({ txSlots: p.txSlots as TxSlot[], debugByTx: !!p.debugByTx });
        }
        if (p.condNodes) storeSync({ condNodes: p.condNodes as any });
        if (p.forkPatches) useForkStore.setState({ patches: p.forkPatches as any });
        if (p.rpcUrl) {
          const next = setConfig({ rpcUrl: p.rpcUrl, forkMode: true });
          storeSync({ config: next });
        } else if (isWhatIfMode) {
          const next = setConfig({ forkMode: true });
          storeSync({ config: next });
        }
        const missing: string[] = [];
        if (!p.tx) missing.push("tx");
        if (!p.txData && !hasTxDataList) missing.push("txData/txDataList");
        if (!p.blockData) missing.push("blockData");
        if (missing.length > 0) {
          setWhatIfInitStatus(`Init payload missing required fields: ${missing.join(", ")}`);
          return;
        }
        if (isWhatIfMode && !whatIfAutoStartedRef.current) {
          whatIfAutoStartedRef.current = true;
          console.log("[whatif.init] autostart startDebug()");
          setWhatIfInitStatus("Starting trace...");
          setTimeout(() => {
            startDebugRef.current();
          }, 0);
        }
      },
    );
    return () => {
      unlistenP.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [isWhatIfMode, storeSync]);

  useEffect(() => {
    if (!isCfgMode) return;
    const w = getCurrentWindow();
    const unlistenInitP = w.listen<{ sessionId?: string }>("optrace:cfg:init", (ev) => {
      const sid = (ev.payload?.sessionId || "").trim();
      if (!sid) return;
      // Always reset frames on init — this is always a "fresh start" signal
      // (same sessionId on re-open must also reset, otherwise 3 snapshots×3 = triple counts).
      console.info("[cfg] optrace:cfg:init", { sid });
      setCfgFrames(new Map());
      setCfgSessionId(sid);
    });
    // Receive aggregated frame entries (tiny payload) instead of raw 700k step objects.
    const unlistenFramesP = w.listen<{ sessionId?: string; frames?: { transactionId: number; contextId: number; count: number }[] }>(
      "optrace:cfg:frame_batch",
      (ev) => {
        const sid = (ev.payload?.sessionId || "").trim();
        const incoming = Array.isArray(ev.payload?.frames) ? ev.payload!.frames! : [];
        if (!sid) return;
        if (incoming.length === 0) {
          console.info("[cfg] optrace:cfg:frame_batch (empty skipped)", { sid });
          return;
        }
        console.info("[cfg] optrace:cfg:frame_batch", {
          sid,
          entries: incoming.length,
          keys: incoming.map((f) => makeCfgFrameKey(f.transactionId, f.contextId)),
        });
        setCfgSessionId((prev) => prev || sid);
        setCfgFrames((prev) => {
          const next = new Map(prev);
          for (const f of incoming) {
            const k = makeCfgFrameKey(f.transactionId, f.contextId);
            const e = next.get(k);
            if (e) {
              next.set(k, { ...e, count: e.count + f.count });
            } else {
              next.set(k, f);
            }
          }
          return next;
        });
      },
    );
    return () => {
      unlistenInitP.then((u) => u()).catch(() => {});
      unlistenFramesP.then((u) => u()).catch(() => {});
    };
  }, [isCfgMode]);

  useEffect(() => {
    if (isCfgMode) return;
    const sid = sessionIdRef.current;
    if (!sid) return;

    const all = allStepsRef.current;
    if (stepCount < cfgEmittedIndexRef.current) cfgEmittedIndexRef.current = 0;
    const start = cfgEmittedIndexRef.current;
    if (all.length <= start) return;
    const slice = all.slice(start);
    cfgEmittedIndexRef.current = all.length;
    const frames = aggregateStepsToFrames(
      slice.map((s, i) => ({
        stepIndex: start + i,
        transactionId: s.transactionId ?? 0,
        contextId: s.contextId,
        pc: s.pc,
        opcode: s.opcode,
        frameStepCount: s.frameStepCount,
        depth: s.depth,
      }))
    );
    // 不要在这里 emitCfgInit：init 会清空 CFG 窗口的帧表，而本批只是增量切片；
    // 清空后若本批只有子帧（如 DELEGATECALL 后），会丢掉主界面里已有的其它 context。
    void emitCfgFrameBatch(sid, frames);
  }, [stepCount, isCfgMode, sessionIdRef, allStepsRef]);

  useEffect(() => {
    if (isCfgMode) return;
    const sid = sessionIdFromStore || sessionIdRef.current;
    if (!sid) return;
    const all = allStepsRef.current;
    const idx = currentStepIndex;
    if (idx < 0 || idx >= all.length) {
      void emitCfgCurrentStep({
        sessionId: sid,
        stepIndex: idx,
        transactionId: 0,
        contextId: 0,
      });
      return;
    }
    const s = all[idx];
    const tx = s.transactionId ?? 0;
    const ctx = s.contextId;
    let prevPc: number | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      const p = all[i];
      if ((p.transactionId ?? 0) === tx && p.contextId === ctx) {
        prevPc = p.pc;
        break;
      }
    }
    void emitCfgCurrentStep({
      sessionId: sid,
      stepIndex: idx,
      transactionId: tx,
      contextId: ctx,
      pc: s.pc,
      prevPc,
    });
  }, [currentStepIndex, isCfgMode, sessionIdFromStore, sessionIdRef, allStepsRef]);

  useEffect(() => {
    if (isCfgMode) return;
    const sid = sessionIdFromStore || sessionIdRef.current;
    if (!sid) return;
    const all = allStepsRef.current;
    const idx = currentStepIndex;
    if (idx < 0 || idx >= all.length) {
      void emitCrossMainStepSync({
        sessionId: sid,
        stepIndex: idx,
        transactionId: 0,
        contextId: 0,
      });
      return;
    }
    const s = all[idx]!;
    void emitCrossMainStepSync({
      sessionId: sid,
      stepIndex: idx,
      transactionId: s.transactionId ?? 0,
      contextId: s.contextId,
    });
  }, [currentStepIndex, isPlaying, isCfgMode, sessionIdFromStore, sessionIdRef, allStepsRef]);

  useEffect(() => {
    if (!isWhatIfMode) return;
    const t = setTimeout(() => {
      if (!whatIfInitReceivedRef.current) {
        setWhatIfInitStatus("Init payload not received. Open this window via Fork button, then retry.");
      }
    }, 3000);
    return () => clearTimeout(t);
  }, [isWhatIfMode]);

  useEffect(() => {
    if (!isWhatIfMode) return;
    if (activeTab !== "main") return;
    if (callFrames.length === 0) return;
    storeSync({ activeTab: callFrames[0].id });
  }, [activeTab, callFrames, isWhatIfMode, storeSync]);

  // Hooks
  const { runConditionScan, clearAllConditions } = useConditionScan(conditionHitSetRef);
  const {
    handleBreakOpcodesChange,
    handleToggleBreakpoint,
    handleRemoveBreakpoint,
    handleClearFrameBreakpoints,
    handleClearAllBreakpoints,
  } = useBreakpoints(breakOpcodesRef, breakpointPcsRef);

  const handleInsertBreakpointsFromAnalysis = useCallback((resultText: string) => {
    const indices = extractStepIndicesFromAnalysisResult(resultText);
    if (indices.length === 0) {
      toast.info("No stepIndex / global_step fields in result");
      return;
    }
    const all = allStepsRef.current;
    if (!all.length) {
      toast.error("No trace loaded");
      return;
    }
    const prev = useDebugStore.getState().breakpointPcsMap;
    const next = new Map(prev);
    let newPairs = 0;
    let skipped = 0;
    for (const idx of new Set(indices)) {
      if (idx < 0 || idx >= all.length) {
        skipped++;
        continue;
      }
      const step = all[idx];
      const frameId = frameTabId(step.transactionId, step.contextId);
      const pcs = new Set(next.get(frameId) || []);
      if (!pcs.has(step.pc)) newPairs++;
      pcs.add(step.pc);
      next.set(frameId, pcs);
    }
    breakpointPcsRef.current = next;
    storeSync({ breakpointPcsMap: next });
    if (newPairs === 0 && skipped === 0) {
      toast.info("Those PCs already have breakpoints");
      return;
    }
    if (newPairs === 0 && skipped > 0) {
      toast.error(`No breakpoints added (${skipped} invalid step index)`);
      return;
    }
    toast.success(
      `Added ${newPairs} breakpoint(s)` + (skipped ? ` (${skipped} invalid index skipped)` : ""),
    );
  }, [allStepsRef, breakpointPcsRef, storeSync]);

  useTabSync(activeTabRef);
  useFourbyteResolver();

  // Store write helpers
  const setActiveTab = useCallback((v: string) => storeSync({ activeTab: v }), []);
  const setCallTreeNodes = useCallback((v: CallTreeNode[]) => storeSync({ callTreeNodes: v }), []);
  const setIsDebugging = useCallback((v: boolean) => storeSync({ isDebugging: v }), []);
  const setCallFrames = useCallback((v: CallFrame[] | ((prev: CallFrame[]) => CallFrame[])) => {
    const next = typeof v === 'function' ? v(useDebugStore.getState().callFrames) : v;
    callFramesRef.current = next;
    storeSync({ callFrames: next, hasCallFrames: next.length > 0 });
  }, []);
  const setCurrentStepIndex = useCallback((v: number) => {
    currentStepIndexRef.current = v;
    storeSync({ currentStepIndex: v });
  }, []);
  const setStepCount = useCallback((v: number) => {
    storeSync({ stepCount: v });
    // 步数 <= 阈值时一次性预取全量数据，之后 applyStep 直接读缓存
    const threshold = fullDataThresholdRef.current;
    if (threshold > 0 && v <= threshold) {
      // 防抖：流式接收期间每 500 步触发一次，清掉上一个 timer，等稳定后再发 IPC
      if (cacheTimerRef.current) clearTimeout(cacheTimerRef.current);
      const ver = ++cacheVersionRef.current;
      cacheTimerRef.current = setTimeout(() => {
        cacheTimerRef.current = null;
        fullDataCacheRef.current = null;
        storeSync({ isCacheMode: false });
        invoke<Array<{
          step_index: number; transaction_id: number; context_id: number; pc: number; opcode: number;
          gas_cost: number; gas_remaining: number; stack: string[]; memory: string;
        }>>(ipcCommands.rangeFullData, { start: 0, end: v - 1, sessionId: sessionIdRef.current })
          .then((data) => {
            if (cacheVersionRef.current !== ver) return; // stale：stepCount 已超阈值或新 session
            fullDataCacheRef.current = data;
            storeSync({ isCacheMode: true });
            console.log(`[fullDataCache] 预取完成: ${data.length} 步`);
          })
          .catch((err) => {
            storeSync({ isCacheMode: false });
            console.warn("[fullDataCache] 预取失败:", err);
          });
      }, 400);
    } else {
      if (cacheTimerRef.current) { clearTimeout(cacheTimerRef.current); cacheTimerRef.current = null; }
      fullDataCacheRef.current = null;
      ++cacheVersionRef.current; // 让所有在途 IPC 失效
      storeSync({ isCacheMode: false });
    }
  }, []);
  const setIsPlaying = useCallback((v: boolean) => {
    isPlayingRef.current = v;
    storeSync({ isPlaying: v });
  }, []);
  const setPlaybackSpeed = useCallback((v: number) => {
    batchSizeRef.current = v;
    storeSync({ playbackSpeed: v });
  }, []);

  // 使用播放 hook
  const { applyStep, stepForward, stepBackward, stepOver, stepOut, togglePlayback, seekTo, reset } = useDebugPlayback(
    {
      sessionId: sessionIdRef,
      allSteps: allStepsRef,
      callFrames: callFramesRef,
      currentStepIndex: currentStepIndexRef,
      activeTab: activeTabRef,
      isPlaying: isPlayingRef,
      batchSize: batchSizeRef,
      breakOpcodes: breakOpcodesRef,
      breakpointPcs: breakpointPcsRef,
      conditionHitSet: conditionHitSetRef,
      stepIndexByContext: stepIndexByContextRef,
      opcodeIndex: opcodeIndexRef,
      fullDataCache: fullDataCacheRef,
    },
    {
      setCurrentStepIndex,
      setIsPlaying,
      setCallFrames,
      setActiveTab,
    }
  );

  useEffect(() => {
    if (isCfgMode) return;
    let unlisten: (() => void) | undefined;
    listenCrossCfgSeqCommit((payload) => {
      if (!payload?.sessionId || payload.sessionId !== sessionIdRef.current) return;
      seekTo(payload.globalStepIndex);
    })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [isCfgMode, seekTo]);

  // Expose seek callback to store
  useEffect(() => {
    useDebugStore.getState().registerSeekToStep(applyStep);
    return () => useDebugStore.getState().registerSeekToStep(null);
  }, [applyStep]);

  // Navigation
  const { navigateTo, seekToWithHistory, navBack, navForward, handleSelectFrame, handleGoBack, resetNav } = useNavigation(seekTo, activeTabRef);

  const stepPlayback = useStepPlayback(navigateTo, allStepsRef);

  // Start debug
  const startDebug = useCallback(() => startDebugAction({
    sessionId: sessionIdRef.current,
    allStepsRef, callFramesRef, callTreeRef, currentStepIndexRef,
    stepIndexByContext: stepIndexByContextRef,
    opcodeIndex: opcodeIndexRef,
    runtime: messageRuntimeRef.current,
    resetPlayback: reset, applyStep, resetNav,
    setStepCount, setCallFrames, setActiveTab, setIsDebugging,
    setCurrentStepIndex, setIsPlaying,
  }), [reset, applyStep, resetNav, sessionIdRef]);

  useEffect(() => {
    startDebugRef.current = startDebug;
  }, [startDebug]);

  // Foundry debug（方案A）
  const startFoundryDebug = useCallback(() => void startFoundryDebugAction({
    sessionIdRef, allStepsRef, callFramesRef, callTreeRef, currentStepIndexRef,
    stepIndexByContext: stepIndexByContextRef,
    opcodeIndex: opcodeIndexRef,
    runtime: messageRuntimeRef.current,
    resetPlayback: reset, applyStep, resetNav,
    setStepCount, setCallFrames, setActiveTab, setIsDebugging,
    setCurrentStepIndex, setIsPlaying,
  }), [reset, applyStep, resetNav]);

  // Reset all
  const resetAll = useCallback(() => {
    cfgEmittedIndexRef.current = 0;
    void resetAllAction({
      sessionId: sessionIdRef.current,
      allStepsRef, callFramesRef, callTreeRef,
      stepIndexByContext: stepIndexByContextRef,
      opcodeIndex: opcodeIndexRef,
      runtime: messageRuntimeRef.current,
      fullDataCache: fullDataCacheRef,
      resetPlayback: reset,
      resetNav,
    }).then(() => {
      const sid = sessionIdRef.current;
      if (sid) void emitCfgInit(sid);
    });
  }, [reset, resetNav, sessionIdRef]);

  // Debug dump
  const handleDebugDump = useCallback(
    () => debugDump(currentStepIndexRef, callFramesRef, activeTabRef, allStepsRef),
    [],
  );

  useDebugCommandBindings({
    stepForward,
    stepOver,
    stepOut,
    stepBackward,
    togglePlayback,
    seekTo,
    navBack,
    navForward,
    allStepsRef,
    opcodeIndexRef,
    currentStepIndexRef,
    panelRefs: {
      opcode: opcodeScrollRef,
      stack: stackScrollRef,
      memory: memoryScrollRef,
      storage: storageScrollRef,
    },
  });

  const activeFrame = callFrames.find((f) => f.id === activeTab);
  const handleOpenCfgWindow = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const { window } = openCfgWindow(sid, { readonly: true });
    console.log("[cfg.send] open", { sid, allSteps: allStepsRef.current.length });
    // Ensure late-opened cfg window receives existing trace.
    cfgEmittedIndexRef.current = 0;
    const sendSnapshot = (tag: string, withSessionReset: boolean) => {
      const all = allStepsRef.current;
      // Aggregate frames instead of sending 700k raw steps over IPC
      const frames = aggregateStepsToFrames(
        all.map((s, i) => ({
          stepIndex: i,
          transactionId: s.transactionId ?? 0,
          contextId: s.contextId,
          pc: s.pc,
          opcode: s.opcode,
          frameStepCount: s.frameStepCount,
          depth: s.depth,
        }))
      );
      console.log("[cfg.send] snapshot", { tag, sid, frameEntries: frames.length, steps: all.length });
      if (frames.length === 0) {
        console.warn("[cfg.send] aggregateStepsToFrames returned 0 entries — CFG list will stay empty until steps exist.");
      }
      if (withSessionReset) {
        void emitCfgInit(sid);
      }
      void emitCfgFrameBatch(sid, frames);
    };
    window.once("tauri://created", () => {
      sendSnapshot("created", true);
      setTimeout(() => sendSnapshot("t+300ms", false), 300);
      setTimeout(() => sendSnapshot("t+1200ms", false), 1200);
    });
  }, [sessionIdRef, allStepsRef]);

  if (isCfgMode) {
    const cfgFramesArr = [...cfgFrames.values()].map((f) => ({
      key: makeCfgFrameKey(f.transactionId, f.contextId),
      count: f.count,
    }));
    return <CfgWindow sessionId={cfgSessionId} frames={cfgFramesArr} />;
  }

  useActiveFrameProjection({
    callFramesRef,
    activeTab,
    currentStepIndex,
    breakpointPcsMap,
  });

  return (
    <FloatingPanelProvider>
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* 标签栏 */}
      <TabBar
        activeTab={activeTab}
        callFrames={callFrames}
        onTabChange={setActiveTab}
      />

      {/* 主内容 */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* 非 whatif 模式展示 main 界面 */}
        <div className={!isWhatIfMode && activeTab === "main" ? "flex-1 flex flex-col min-h-0 overflow-hidden" : "hidden"}>
          <MainInterface
            onStartDebug={startDebug}
            onReset={resetAll}
            onOpenTestDialog={() => storeSync({ isTestDialogOpen: true })}
            onBuildCallTree={() => setCallTreeNodes([...callTreeRef.current])}
            onSeekTo={seekToWithHistory}
            onSelectFrame={handleSelectFrame}
            onNavigateTo={navigateTo}
            onStartFoundryDebug={startFoundryDebug}
          />
        </div>
        {isWhatIfMode && activeTab === "main" ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            {whatIfInitStatus}
          </div>
        ) : null}
        {activeTab !== "main" && activeFrame ? (
          <>
            {/* 始终显示调试工具栏 */}
            <DebugToolbar
              onStepInto={stepForward}
              onStepOver={stepOver}
              onStepOut={stepOut}
              onContinue={togglePlayback}
              onStepBack={stepBackward}
              onDebugDump={handleDebugDump}
              onBreakOpcodesChange={handleBreakOpcodesChange}
              onSeekTo={seekTo}
              onSeekToWithHistory={seekToWithHistory}
              onSpeedChange={setPlaybackSpeed}
              onNavBack={navBack}
              onNavForward={navForward}
              onSelectFrame={handleSelectFrame}
              onNavigateTo={navigateTo}
              onStartDebug={startDebug}
              onOpenCfgWindow={handleOpenCfgWindow}
              allStepsRef={allStepsRef}
              fullDataCacheRef={fullDataCacheRef}
            />
            <StepPlaybackFloatingBar
              onLast={stepPlayback.onStepPlaybackLast}
              onToggleAutoPlay={stepPlayback.toggleStepQueueAutoPlay}
              onNext={stepPlayback.onStepPlaybackNext}
              onClose={stepPlayback.onStepPlaybackBarClose}
            />

            {/* Area below toolbar — drawers are anchored here */}
            <div className="flex-1 relative min-h-0 overflow-hidden">
              <div className="h-full p-2 overflow-hidden">
                <DebugPanel
                  callFrames={callFrames.map(f => ({
                    id: f.id,
                    transactionId: f.transactionId,
                    contextId: f.contextId,
                    depth: f.depth,
                    address: f.address,
                    caller: f.caller,
                    target: f.target,
                    contract: f.contract,
                    gasLimit: f.gasLimit,
                    gasUsed: f.gasUsed,
                    value: f.value,
                    input: f.input,
                    callType: f.callType,
                    parentId: f.parentId,
                    startStep: stepIndexByContextRef.current.get(
                      `${f.transactionId ?? 0}:${f.contextId}`,
                    )?.[0],
                    endStep: (() => {
                      const arr = stepIndexByContextRef.current.get(
                        `${f.transactionId ?? 0}:${f.contextId}`,
                      );
                      return arr?.[arr.length - 1];
                    })(),
                    exitCode: f.exitCode,
                    success: f.success,
                    exitOutput: f.exitOutput,
                  }))}
                  activeFrameId={activeTab}
                  onSelectFrame={handleSelectFrame}
                  onBack={handleGoBack}
                  canGoBack={tabHistory.length > 0}
                  onToggleBreakpoint={(pc) => handleToggleBreakpoint(activeTab, pc)}
                  scanUrl={scanUrl}
                  onSeekTo={seekToWithHistory}
                  scrollContainerRefs={{
                    opcode: opcodeScrollRef,
                    stack: stackScrollRef,
                    memory: memoryScrollRef,
                    storage: storageScrollRef,
                  }}
                />
              </div>
              <BookmarksDrawer
                onRemoveBreakpoint={handleRemoveBreakpoint}
                onClearFrameBreakpoints={handleClearFrameBreakpoints}
                onClearAllBreakpoints={handleClearAllBreakpoints}
                onNavigate={(frameId, pc) => {
                  const m = /^frame-(\d+)-(\d+)$/.exec(frameId);
                  const stepIndex = m
                    ? allStepsRef.current.findIndex(
                        (s) =>
                          s.transactionId === Number(m[1]) &&
                          s.contextId === Number(m[2]) &&
                          s.pc === pc,
                      )
                    : allStepsRef.current.findIndex(
                        (s) =>
                          s.contextId ===
                            parseInt(frameId.replace("frame-", ""), 10) &&
                          s.pc === pc,
                      );
                  if (stepIndex >= 0) navigateTo(stepIndex, frameId);
                }}
              />
              <CondScanDrawer
                onRunConditionScan={runConditionScan}
                onClearAllConditions={clearAllConditions}
                onSeekTo={seekToWithHistory}
                disabled={!useDebugStore.getState().stepCount}
              />
            </div>
          </>
        ) : null}
      </div>

      {/* 全局 Drawer 挂载点 */}
      <DrawerHost
        onSeekToWithHistory={seekToWithHistory}
        onInsertBreakpointsFromAnalysisResult={handleInsertBreakpointsFromAnalysis}
        onReplacePlaybackFromAnalysisResult={stepPlayback.replacePlaybackQueueFromAnalysisResult}
      />
      <DataFlowDrawer
        isOpen={useDebugStore((s) => s.isDataFlowModalOpen)}
        onClose={useCallback(() => useDebugStore.getState().closeDataFlowModal(), [])}
        rootId={useDebugStore((s) => s.dataFlowTreeRootId)}
        nodes={useDebugStore((s) => s.dataFlowTreeNodes)}
        onStepSelect={(globalStep) => {
          console.log('[DataFlowDrawer] Jumping to global_step:', globalStep);
          // global_step 对应 allStepsRef 的索引
          seekToWithHistory(globalStep);
        }}
      />
      {/* <NotesDrawer onSeekTo={seekToWithHistory} /> */}
      <HintOverlay />
      <PanelHintOverlay />
      <KeyboardShortcutsHelpDialog />
      <CommandPaletteDialog />
      <Toaster />
    </div>
    </FloatingPanelProvider>
  );
}

export default App;
