import { useRef, useCallback, useEffect } from "react";
import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { ipcCommands } from "@/lib/ipcConfig";
import { migrateFromLocalStorage } from "@/lib/tauriStore";
import { initUserFourbyteDb } from "@/lib/userFourbyteDb";
import { initRpcConfig } from "@/lib/rpcConfig";
import { DebugToolbar } from "@/components/DebugToolbar";
import { DebugPanel } from "@/components/DebugPanel";
import { TabBar } from "@/components/TabBar";
import { MainInterface } from "@/components/MainInterface";
import { TestDialog } from "@/components/TestDialog";
import { GlobalLogDrawer } from "@/components/GlobalLogDrawer";
import { UtilitiesDrawer } from "@/components/UtilitiesDrawer";
import { AnalysisDrawer } from "@/components/AnalysisDrawer";
import { DataFlowDrawer } from "@/components/DataFlowModal";
// import { NotesDrawer } from "@/components/NotesDrawer";
import { BookmarksDrawer } from "@/components/BookmarksDrawer";
import { CondListDrawer } from "@/components/CondListDrawer";
import { Toaster } from "@/components/ui/sonner";
import "./App.css";
import { type StepData } from "./lib/stepPlayer";
import { type CallFrame, type CallTreeNode } from "./lib/types";
import { useDebugPlayback } from "./hooks/useDebugPlayback";
import { type TxData, type BlockData } from "./lib/txFetcher";
import { loadAppConfig, initAppConfig } from "./lib/appConfig";
import { useDebugStore } from "./store/debugStore";
import { fetchTxAction, startDebugAction, resetAllAction, debugDump } from "./lib/debugActions";
import { useNavigation } from "./hooks/useNavigation";
import { useConditionScan } from "./hooks/useConditionScan";
import { useBreakpoints } from "./hooks/useBreakpoints";
import { useTabSync } from "./hooks/useTabSync";
import { useFourbyteResolver } from "./hooks/useFourbyteResolver";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { registerCommands, unregisterCommands } from "./lib/commands";


function App() {
  // 0x68d251ca722d3949d453899b5b515b61b216c1eb726526fcbb7b95e186c54248
  // 0x4fd0406120dca30ea8e3d7994136e5d5eaac0f67c82441b872731b3973492e1d
  // 0x6a743ad6fe0e1c9914f355d7294f2cab5b77ca273e3210523f1df0239407f1ea
  // 0x569733b8016ef9418f0b6bde8c14224d9e759e79301499908ecbcd956a0651f5

  // ── Phase 3.1/3.2: 从 store 读取（不再用 useState）────────
  const { sync: storeSync } = useDebugStore.getState();
  const activeTab = useDebugStore((s) => s.activeTab);
  const tabHistory = useDebugStore((s) => s.tabHistory);
  const txData = useDebugStore((s) => s.txData);
  const blockData = useDebugStore((s) => s.blockData);
  const callFrames = useDebugStore((s) => s.callFrames);
  const currentStepIndex = useDebugStore((s) => s.currentStepIndex);
  const breakpointPcsMap = useDebugStore((s) => s.breakpointPcsMap);
  const scanUrl = useDebugStore((s) => s.config.scanUrl);

  // 使用 ref 存储数据和状态，避免闭包问题
  const allStepsRef = useRef<StepData[]>([]);
  const callFramesRef = useRef<CallFrame[]>([]);
  const callTreeRef = useRef<CallTreeNode[]>([]);
  // per-context 步骤索引（方案一：O(log N) seek）
  const stepIndexByContextRef = useRef<Map<number, number[]>>(new Map());
  // opcode 步骤索引：opcode → 全局步骤下标数组，用于 O(log N) 跳转
  const opcodeIndexRef = useRef<Map<number, number[]>>(new Map());
  const isPlayingRef = useRef(false);
  const currentStepIndexRef = useRef(-1);
  const activeTabRef = useRef<string>("main"); // 追踪当前激活的标签
  const batchSizeRef = useRef(10); // 批量大小，用 ref 避免闭包问题

  // 断点 opcode
  const breakOpcodesRef = useRef<Set<number>>(new Set());

  // 全量数据缓存（步数 <= fullDataThreshold 时预取）── 暂时禁用，写死 0
  const fullDataThresholdRef = useRef(0);
  const fullDataCacheRef = useRef<Array<{
    step_index: number; context_id: number; pc: number; opcode: number;
    gas_cost: number; gas_remaining: number; stack: string[]; memory: string;
  }> | null>(null);
  // 版本号：IPC 返回时如果版本已变则丢弃（防止旧请求在 stepCount 超阈值后仍写入缓存）
  const cacheVersionRef = useRef(0);
  // 防抖 timer：流式接收期间只在最后一次 setStepCount 后才真正发 IPC
  const cacheTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, []);

  // PC 断点（每个 frame 独立）: Map<frameId, Set<pc>>
  const breakpointPcsRef = useRef<Map<string, Set<number>>>(new Map());

  // 条件断点
  const conditionHitSetRef = useRef<Set<number>>(new Set());

  // 提取的 hooks
  const { runConditionScan } = useConditionScan(conditionHitSetRef);
  const { handleBreakOpcodesChange, handleToggleBreakpoint } = useBreakpoints(breakOpcodesRef, breakpointPcsRef);
  useTabSync(activeTabRef);
  useFourbyteResolver();

  // ── Store-writing helpers (替代已删除的 useState setters) ────
  const setActiveTab = useCallback((v: string) => storeSync({ activeTab: v }), []);
  const setTx = useCallback((v: string) => storeSync({ tx: v }), []);
  const setTxData = useCallback((v: TxData | null) => storeSync({ txData: v }), []);
  const setBlockData = useCallback((v: BlockData | null) => storeSync({ blockData: v }), []);
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
          step_index: number; context_id: number; pc: number; opcode: number;
          gas_cost: number; gas_remaining: number; stack: string[]; memory: string;
        }>>(ipcCommands.rangeFullData, { start: 0, end: v - 1 })
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

  // 注册 applyStep 到 store，供 AnalysisDrawer 等跨组件跳转使用
  useEffect(() => {
    storeSync({ } as never);
    useDebugStore.getState().registerSeekToStep(applyStep);
    return () => useDebugStore.getState().registerSeekToStep(null);
  }, [applyStep]);

  // Navigation hook
  const { navigateTo, seekToWithHistory, navBack, navForward, handleSelectFrame, handleGoBack, resetNav } = useNavigation(seekTo, activeTabRef);

  // 启动调试
  const startDebug = useCallback(() => startDebugAction({
    allStepsRef, callFramesRef, callTreeRef, currentStepIndexRef,
    stepIndexByContext: stepIndexByContextRef,
    opcodeIndex: opcodeIndexRef,
    resetPlayback: reset, applyStep, resetNav,
    setStepCount, setCallFrames, setActiveTab, setIsDebugging,
    setCurrentStepIndex, setIsPlaying,
  }), [reset, applyStep, resetNav]);

  // 完全重置
  const resetAll = useCallback(() => resetAllAction({
    allStepsRef, callFramesRef, callTreeRef,
    stepIndexByContext: stepIndexByContextRef,
    opcodeIndex: opcodeIndexRef,
    fullDataCache: fullDataCacheRef,
    resetPlayback: reset,
    resetNav,
  }), [reset, resetNav]);

  // Debug dump
  const handleDebugDump = useCallback(
    () => debugDump(currentStepIndexRef, callFramesRef, activeTabRef, allStepsRef),
    [],
  );

  // ── 命令注册：将回调绑定到命令注册表，供 useKeyboardShortcuts 调用 ──────────
  useEffect(() => {
    registerCommands({
      "debug.stepInto":    stepForward,
      "debug.stepOver":    stepOver,
      "debug.stepOut":     stepOut,
      "debug.stepBack":    stepBackward,
      "debug.continue":    togglePlayback,
      "debug.seekToStart": () => seekTo(0),
      "debug.seekToEnd":   () => {
        const total = useDebugStore.getState().stepCount;
        if (total > 0) seekTo(total - 1);
      },
      "nav.back":          navBack,
      "nav.forward":       navForward,
      "ui.toggleUtilities": () => {
        const s = useDebugStore.getState();
        s.sync({ isUtilitiesOpen: !s.isUtilitiesOpen });
      },
      "ui.toggleLogs": () => {
        const s = useDebugStore.getState();
        s.sync({ isLogDrawerOpen: !s.isLogDrawerOpen });
      },
      "ui.toggleAnalysis": () => {
        const s = useDebugStore.getState();
        s.sync({ isAnalysisOpen: !s.isAnalysisOpen });
      },
      "ui.toggleBookmarks": () => {
        const s = useDebugStore.getState();
        s.sync({ isBookmarksOpen: !s.isBookmarksOpen });
      },
      "ui.toggleCondList": () => {
        const s = useDebugStore.getState();
        s.sync({ isCondListOpen: !s.isCondListOpen });
      },
      "ui.toggleCallTree": () => {
        const s = useDebugStore.getState();
        s.sync({ isCallTreeOpen: !s.isCallTreeOpen });
      },
    });
    return () => unregisterCommands([
      "debug.stepInto", "debug.stepOver", "debug.stepOut",
      "debug.stepBack", "debug.continue", "debug.seekToStart", "debug.seekToEnd",
      "nav.back", "nav.forward",
      "ui.toggleUtilities", "ui.toggleLogs", "ui.toggleAnalysis",
      "ui.toggleBookmarks", "ui.toggleCondList", "ui.toggleCallTree",
    ]);
  }, [stepForward, stepOver, stepOut, stepBackward, togglePlayback, seekTo, navBack, navForward]);

  useKeyboardShortcuts();

  const activeFrame = callFrames.find((f) => f.id === activeTab);

  // ── 桥接：同步数据到 Zustand store（Phase 1 临时方案）────────
  useEffect(() => {
    // 直接从 ref 读取最新数据，applyStep 已原地更新，无需依赖 activeFrame 对象
    const frame = callFramesRef.current.find(f => f.id === activeTab);
    if (!frame) return;

    // logs 按 stepIndex 顺序追加，二分截取 <= currentStepIndex 的部分
    const logs = frame.logs;
    let logEnd = logs.length;
    if (logs.length > 0 && logs[logs.length - 1].stepIndex > currentStepIndex) {
      let lo = 0, hi = logs.length - 1;
      logEnd = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (logs[mid].stepIndex <= currentStepIndex) { logEnd = mid + 1; lo = mid + 1; }
        else hi = mid - 1;
      }
    }

    // returnDataList 按顺序追加，从尾部倒找第一个 <= currentStepIndex
    const rdList = frame.returnDataList ?? [];
    let returnData = "";
    for (let i = rdList.length - 1; i >= 0; i--) {
      if (rdList[i].stepIndex <= currentStepIndex) { returnData = rdList[i].data; break; }
    }

    useDebugStore.getState().sync({
      opcodes: frame.opcodes,
      stack: frame.stack,
      memory: frame.memory,
      currentPc: frame.currentPc ?? -1,
      currentGasCost: frame.currentGasCost ?? 0,
      storageChanges: frame.storageChanges,
      logs: logs.slice(0, logEnd),
      returnData,
      returnError: "",
      stateDiffs: [],
      currentStepIndex,
      breakpointPcs: breakpointPcsMap.get(activeTab) || new Set(),
      callType: frame.callType,
      callerAddress: frame.caller,
    });
  }, [currentStepIndex, activeTab, breakpointPcsMap]);

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* 标签栏 */}
      <TabBar
        activeTab={activeTab}
        callFrames={callFrames}
        onTabChange={setActiveTab}
      />

      {/* 主内容 */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* MainInterface 始终挂载，避免切换 frame 时 state 丢失 */}
        <div className={activeTab === "main" ? "flex-1 flex flex-col min-h-0 overflow-hidden" : "hidden"}>
          <MainInterface
            onTxChange={setTx}
            onFetchTx={fetchTxAction}
            onStartDebug={startDebug}
            onReset={resetAll}
            onOpenTestDialog={() => storeSync({ isTestDialogOpen: true })}
            onTxFieldChange={(field, value) => {
              if (txData) {
                setTxData({ ...txData, [field]: value });
              }
            }}
            onBlockFieldChange={(field, value) => {
              if (blockData) {
                setBlockData({ ...blockData, [field]: value });
              }
            }}
            onBuildCallTree={() => setCallTreeNodes([...callTreeRef.current])}
            onSeekTo={seekToWithHistory}
            onSelectFrame={handleSelectFrame}
            onNavigateTo={navigateTo}
          />
        </div>
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
              onRunConditionScan={runConditionScan}
              onStartDebug={startDebug}
            />

            {/* Area below toolbar — drawers are anchored here */}
            <div className="flex-1 relative min-h-0 overflow-hidden">
              <div className="h-full p-2 overflow-hidden">
                <DebugPanel
                callFrames={callFrames.map(f => ({
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
                  startStep: stepIndexByContextRef.current.get(f.contextId)?.[0],
                  endStep: (() => { const arr = stepIndexByContextRef.current.get(f.contextId); return arr?.[arr.length - 1]; })(),
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
                />
              </div>
              <BookmarksDrawer
                onNavigate={(frameId, pc) => {
                  const contextId = parseInt(frameId.replace("frame-", ""), 10);
                  const stepIndex = allStepsRef.current.findIndex(
                    (s) => s.contextId === contextId && s.pc === pc
                  );
                  if (stepIndex >= 0) navigateTo(stepIndex, frameId);
                }}
              />
              <CondListDrawer
                onRunConditionScan={runConditionScan}
                disabled={!useDebugStore.getState().stepCount}
              />
            </div>
          </>
        ) : null}
      </div>

      {/* 测试对话框 */}
      <TestDialog />
      <GlobalLogDrawer onSeekTo={seekToWithHistory} />
      <UtilitiesDrawer />
      <AnalysisDrawer />
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
      <Toaster />
    </div>
  );
}

export default App;
