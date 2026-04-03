import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { BlockInfo } from "@/components/BlockInfo";
import { CallTreeViewer } from "@/components/CallTreeViewer";
import { BalanceChangesViewer } from "@/components/BalanceChangesViewer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, HelpCircle, FolderOpen, Info, Plus, Trash2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MultiTxListEditor } from "@/components/MultiTxListEditor";
import { TxInfo } from "@/components/TxInfo";
import {
  consecutiveTxSlotsReady,
  deriveFromTxSlots,
  emptyTxSlot,
  fetchLatestBlock,
  isValidTxListRow,
  type BlockData,
} from "@/lib/txFetcher";
import { fetchAllPendingTxSlots, fetchTxForSlot, slotNeedsTxFetch } from "@/lib/debugActions";
import { useDebugStore } from "@/store/debugStore";
import { useFloatingPanel } from "@/components/floating-panel";
import { setConfig } from "@/lib/appConfig";
import { setSelectedRpc } from "@/lib/rpcConfig";
interface MainInterfaceProps {
  onStartDebug: () => void;
  onReset: () => void;
  onOpenTestDialog: () => void;
  onBuildCallTree?: () => void;
  onSeekTo?: (index: number) => void;
  onSelectFrame?: (frameId: string) => void;
  onNavigateTo?: (stepIndex: number, frameId: string) => void;
}

export function MainInterface({
  onStartDebug,
  onReset,
  onOpenTestDialog,
  onBuildCallTree,
  onSeekTo,
  onSelectFrame,
  onNavigateTo,
}: MainInterfaceProps) {
  const tx = useDebugStore((s) => s.tx);
  const txData = useDebugStore((s) => s.txData);
  const blockData = useDebugStore((s) => s.blockData);
  const txDataList = useDebugStore((s) => s.txDataList);
  const txSlots = useDebugStore((s) => s.txSlots);
  const debugByTx = useDebugStore((s) => s.debugByTx);
  const isFetchingTx = useDebugStore((s) => s.isFetchingTx);
  const isDebugging = useDebugStore((s) => s.isDebugging);
  const stepCount = useDebugStore((s) => s.stepCount);
  const hasSession = !isDebugging && stepCount > 0;
  const locked = isDebugging || hasSession;
  const showTraceTabs = hasSession;
  const hasCallFrames = useDebugStore((s) => s.hasCallFrames);
  const callTreeNodes = useDebugStore((s) => s.callTreeNodes);
  const config = useDebugStore((s) => s.config);
  const callFrames = useDebugStore((s) => s.callFrames);
  const txBoundaries = useDebugStore((s) => s.txBoundaries);
  const showTxOnFrameList = Boolean(txBoundaries && txBoundaries.length > 0);
  const [activeTab, setActiveTab] = useState("info");
  useEffect(() => {
    if (!showTraceTabs && activeTab !== "info") setActiveTab("info");
  }, [showTraceTabs, activeTab]);
  const displayTab = showTraceTabs ? activeTab : "info";
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const hiddenFrameIds = useDebugStore((s) => s.hiddenFrameIds);
  const sync = useDebugStore.getState().sync;
  const updateConfig = useCallback((patch: Parameters<typeof setConfig>[0]) => {
    const next = setConfig(patch);
    sync({ config: next });
  }, [sync]);

  const { showPanel } = useFloatingPanel();
  const openCallTreeInFloating = useCallback(() => {
    showPanel({
      title: "Call Tree",
      children: (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <CallTreeViewer
            onSeekTo={onSeekTo}
            onSelectFrame={onSelectFrame}
            onNavigateTo={onNavigateTo}
            hideFloatingOpenButton
          />
        </div>
      ),
    });
  }, [showPanel, onSeekTo, onSelectFrame, onNavigateTo]);

  const patchBlockField = useCallback(
    (field: string, value: string) => {
      const slots = useDebugStore.getState().txSlots;
      const s0 = slots[0];
      if (!s0) return;
      const nextB = { ...(s0.blockData ?? {}), [field]: value };
      const next = slots.map((s, j) =>
        j === 0 ? { ...s, blockData: nextB } : s,
      );
      sync({ txSlots: next, ...deriveFromTxSlots(next) });
    },
    [sync],
  );

  const applyBlockData = useCallback(
    (b: BlockData) => {
      const slots = useDebugStore.getState().txSlots;
      const s0 = slots[0];
      if (!s0) return;
      const nextB: BlockData = { ...(s0.blockData ?? {}), ...b };
      const next = slots.map((s, j) =>
        j === 0 ? { ...s, blockData: nextB } : s,
      );
      sync({ txSlots: next, ...deriveFromTxSlots(next), txError: "" });
    },
    [sync],
  );

  const fetchLatestBlockIntoSlot = useCallback(async () => {
    try {
      const b = await fetchLatestBlock();
      applyBlockData(b);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "拉取最新块失败";
      console.error(msg);
      sync({ txError: msg });
    }
  }, [applyBlockData, sync]);

  const setSlotHash = useCallback(
    (slotIndex: number, value: string) => {
      const slots = useDebugStore.getState().txSlots;
      const next = slots.map((s, j) => {
        if (j !== slotIndex) return s;
        if (s.hash === value) return s;
        return { ...s, hash: value, txData: null, blockData: null, error: "" };
      });
      sync({ txSlots: next, ...deriveFromTxSlots(next) });
    },
    [sync],
  );

  const addTxSlot = useCallback(() => {
    const slots = useDebugStore.getState().txSlots;
    const next = [...slots, emptyTxSlot()];
    sync({ txSlots: next, ...deriveFromTxSlots(next) });
  }, [sync]);

  const removeTxSlot = useCallback(
    (slotIndex: number) => {
      const slots = useDebugStore.getState().txSlots;
      if (slots.length <= 1) return;
      const next = slots.filter((_, j) => j !== slotIndex);
      sync({ txSlots: next, ...deriveFromTxSlots(next) });
    },
    [sync],
  );

  const patchTxSlotField = useCallback(
    (slotIndex: number, field: string, value: string) => {
      const slots = useDebugStore.getState().txSlots;
      const slot = slots[slotIndex];
      if (!slot?.txData) return;
      const cur = slot.txData;
      let nextTx = { ...cur };
      try {
        if (field === "from") nextTx = { ...nextTx, from: value };
        else if (field === "to") nextTx = { ...nextTx, to: value || null };
        else if (field === "value") {
          const n = parseFloat(value);
          if (!Number.isNaN(n)) nextTx = { ...nextTx, value: BigInt(Math.round(n * 1e18)) };
        } else if (field === "gasPrice") {
          const n = parseFloat(value);
          if (!Number.isNaN(n)) nextTx = { ...nextTx, gasPrice: BigInt(Math.round(n * 1e9)) };
        } else if (field === "gasLimit") nextTx = { ...nextTx, gasLimit: BigInt(value || "0") };
        else if (field === "data") nextTx = { ...nextTx, data: value };
        else return;
      } catch {
        return;
      }
      const next = slots.map((s, j) =>
        j === slotIndex ? { ...s, txData: nextTx } : s,
      );
      sync({ txSlots: next, ...deriveFromTxSlots(next) });
    },
    [sync],
  );

  const chainReady = useMemo(
    () => consecutiveTxSlotsReady(txSlots),
    [txSlots],
  );
  const toggleGroup = (key: string) =>
    setCollapsedGroups(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const collapseAll = (keys: string[]) => setCollapsedGroups(new Set(keys));
  const expandAll = () => setCollapsedGroups(new Set());
  const validMultiTxRows = useMemo(
    () => txDataList.filter(isValidTxListRow).length,
    [txDataList],
  );
  const hasPendingTxFetch = useMemo(
    () => txSlots.some(slotNeedsTxFetch),
    [txSlots],
  );
  const validTxRef = tx.length >= 64;

  const canStartDebug = useMemo(() => {
    if (debugByTx) {
      if (chainReady.length >= 2) return true;
      if (chainReady.length === 1) return !!(txData && blockData);
      return false;
    }
    return validMultiTxRows >= 1 && validTxRef;
  }, [
    debugByTx,
    chainReady.length,
    txData,
    blockData,
    validMultiTxRows,
    validTxRef,
  ]);

  const toggleGroupVisibility = useCallback((frameIds: string[], currentlyHidden: boolean) => {
    const { hiddenFrameIds: cur } = useDebugStore.getState();
    const next = new Set(cur);
    if (currentlyHidden) {
      frameIds.forEach(id => next.delete(id));
    } else {
      frameIds.forEach(id => next.add(id));
    }
    sync({ hiddenFrameIds: next });
  }, [sync]);
  return (
    <>
      <div className="flex-shrink-0 px-4 py-2 border-b bg-muted/20">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Input
            value={config.rpcUrl}
            onChange={(e) => {
              updateConfig({ rpcUrl: e.target.value });
              setSelectedRpc(e.target.value);
            }}
            readOnly={locked}
            className="font-mono text-xs h-7 w-[min(100%,55ch)] shrink-0 max-w-full"
            placeholder="RPC URL"
          />
          <Input
            value={config.scanUrl}
            onChange={(e) => {
              updateConfig({ scanUrl: e.target.value });
            }}
            readOnly={locked}
            className="font-mono text-xs h-7 w-[min(100%,55ch)] shrink-0 max-w-full"
            placeholder="Scan URL"
          />
          {hasSession ? (
            <Button onClick={onReset} variant="destructive" size="sm" className="whitespace-nowrap h-7 px-3 shrink-0">
              Reset
            </Button>
          ) : (
            <Button
              onClick={onStartDebug}
              disabled={isDebugging || !canStartDebug}
              variant="default"
              size="sm"
              className="whitespace-nowrap h-7 px-3 shrink-0 shadow-sm"
            >
              {isDebugging ? (
                <>
                  <Spinner className="size-3.5" />
                  Debugging…
                </>
              ) : (
                "Start Debug"
              )}
            </Button>
          )}
          {config.isDebug && (
            <Button onClick={onOpenTestDialog} variant="outline" size="sm" className="whitespace-nowrap h-7 px-3 shrink-0">
              Test Parse
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        {isDebugging ? (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/70 backdrop-blur-[2px]"
            aria-busy="true"
            aria-live="polite"
          >
            <Spinner className="size-9 text-primary" />
            <p className="text-sm text-muted-foreground">Tracing transaction…</p>
          </div>
        ) : null}
        <Tabs value={displayTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <div className="flex-shrink-0 px-4 pt-2">
            <div className="relative grid grid-cols-1 min-[900px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 items-center min-h-7">
              <div
                className={`relative min-w-0 flex items-center min-h-7 ${activeTab === "info" ? "pr-[9.5rem]" : ""}`}
              >
                <TabsList className="h-7 bg-transparent p-0 flex flex-wrap gap-x-1 gap-y-1 min-w-0">
                  <TabsTrigger value="info" className="text-xs px-2 py-0.5">Info</TabsTrigger>
                  {showTraceTabs ? (
                    <>
                      <TabsTrigger value="calltree" className="text-xs px-2 py-0.5">Call Tree</TabsTrigger>
                      <TabsTrigger value="frames" className="text-xs px-2 py-0.5">Frames</TabsTrigger>
                      <TabsTrigger value="changes" className="text-xs px-2 py-0.5">Balance Changes</TabsTrigger>
                    </>
                  ) : null}
                </TabsList>
                {displayTab === "info" ? (
                  <label
                    className={`absolute right-0 top-1/2 -translate-y-1/2 flex items-center gap-2 text-xs text-muted-foreground select-none max-w-[min(100%,11rem)] sm:max-w-none ${locked ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                  >
                    <Checkbox
                      checked={debugByTx}
                      disabled={locked}
                      onCheckedChange={(v) => sync({ debugByTx: v === true })}
                    />
                    Debug By Tx
                  </label>
                ) : null}
              </div>
              <div className="hidden min-[900px]:block min-h-0" aria-hidden />
              <div className="hidden min-[900px]:block min-h-0" aria-hidden />
            </div>
          </div>

          <TabsContent value="info" className="flex-1 min-h-0 overflow-hidden px-4 pb-4 mt-0 flex flex-col">
            <div className="grid grid-cols-1 min-[900px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 flex-1 min-h-0 pt-3">
              <div className="min-w-0 overflow-y-auto flex flex-col gap-3">
                {debugByTx ? (
                  <div className="flex flex-col gap-2">
                    {/* <div className="space-y-1.5 shrink-0">
                      <p className="text-xs font-medium text-muted-foreground">Debug By Tx</p>
                    </div> */}
                    <div className="max-h-[min(58vh,460px)] overflow-y-auto pr-0.5">
                      <div className="flex flex-col gap-2">
                        {txSlots.map((slot, i) => (
                          <div key={i} className="flex items-center gap-2 w-full min-w-0">
                            {txSlots.length > 1 ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                title="Remove"
                                disabled={locked}
                                onClick={() => removeTxSlot(i)}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            ) : (
                              <span className="h-7 w-7 shrink-0" aria-hidden />
                            )}
                            <Input
                              placeholder="TX Hash"
                              value={slot.hash}
                              onChange={(e) => setSlotHash(i, e.target.value)}
                              disabled={isDebugging || hasSession}
                              className="font-mono text-xs h-7 flex-1 min-w-0"
                            />
                            <Button
                              type="button"
                              onClick={() => void fetchTxForSlot(i)}
                              disabled={
                                locked ||
                                slot.isFetching ||
                                !!(slot.txData && slot.blockData)
                              }
                              size="sm"
                              className="whitespace-nowrap h-7 px-2 shrink-0"
                            >
                              {slot.isFetching ? "…" : "GetInfo"}
                            </Button>
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="icon"
                                  className="h-7 w-7 shrink-0"
                                  title="Transaction details"
                                  disabled={locked || !slot.txData}
                                >
                                  <Info className="size-3.5" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent
                                className="w-[min(100vw-1.5rem,440px)] max-h-[min(75vh,600px)] overflow-y-auto p-2"
                                align="start"
                              >
                                <TxInfo
                                  className="border-0 shadow-none"
                                  txHash={slot.txData?.txHash ?? (slot.hash.trim() ? (slot.hash.trim().startsWith("0x") ? slot.hash.trim() : `0x${slot.hash.trim()}`) : undefined)}
                                  from={slot.txData?.from}
                                  to={slot.txData?.to ?? undefined}
                                  value={slot.txData?.value}
                                  gasPrice={slot.txData?.gasPrice}
                                  gasLimit={slot.txData?.gasLimit}
                                  gasUsed={slot.txData?.gasUsed}
                                  data={slot.txData?.data}
                                  status={slot.txData?.status}
                                  isLoading={slot.isFetching}
                                  error={slot.error || undefined}
                                  readOnly={locked}
                                  onFieldChange={(field, value) => patchTxSlotField(i, field, value)}
                                />
                              </PopoverContent>
                            </Popover>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-6">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 w-fit"
                        disabled={locked}
                        onClick={addTxSlot}
                        title="Add transaction"
                      >
                        <Plus className="size-3.5" />
                        Add TX
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 w-fit"
                        disabled={locked || isFetchingTx || !hasPendingTxFetch}
                        onClick={() => void fetchAllPendingTxSlots()}
                        title="依次拉取：尚未成功且 hash 合法的槽位"
                      >
                        Batch GetInfo
                      </Button>
                    </div>
                  </div>
                ) : (
                  <MultiTxListEditor readOnly={locked} />
                )}
              </div>

              <div className="min-w-0 overflow-y-auto">
                <BlockInfo
                  blockNumber={blockData?.blockNumber}
                  timestamp={blockData?.timestamp}
                  gasLimit={blockData?.gasLimit}
                  baseFeePerGas={blockData?.baseFeePerGas}
                  isLoading={isFetchingTx}
                  readOnly={locked}
                  showEmpty={!debugByTx}
                  onFieldChange={patchBlockField}
                  onFetchLatestBlock={fetchLatestBlockIntoSlot}
                />
              </div>

              <div className="min-w-0 overflow-y-auto border-l border-border pl-3">
                <Card className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-sm">Config</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground gap-1"
                      title="打开配置文件所在文件夹"
                      onClick={async () => {
                        try {
                          const { invoke } = await import('@tauri-apps/api/core');
                          await invoke('open_app_data_dir');
                        } catch (e) {
                          console.error('open config folder failed', e);
                        }
                      }}
                    >
                      <FolderOpen className="h-3 w-3" />
                      Open Folder
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    <label className={`flex items-center gap-1.5 text-xs ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <Checkbox
                        checked={config.useAlloyCache}
                        disabled={locked}
                        onCheckedChange={(v) => {
                          updateConfig({ useAlloyCache: !!v });
                        }}
                      />
                      <span>AlloyDB Cache</span>
                      <TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><span className="flex-shrink-0 cursor-default"><HelpCircle className="h-3 w-3 text-muted-foreground" /></span></TooltipTrigger><TooltipContent side="top" className="max-w-[260px] text-xs">Cache RPC responses to disk so subsequent runs of the same transaction skip RPC calls entirely.</TooltipContent></Tooltip></TooltipProvider>
                    </label>
                    <label className={`flex items-center gap-1.5 text-xs ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <Checkbox
                        checked={config.usePrestate}
                        disabled={locked}
                        onCheckedChange={(v) => {
                          updateConfig({ usePrestate: !!v });
                        }}
                      />
                      <span>Prestate</span>
                      <TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><span className="flex-shrink-0 cursor-default"><HelpCircle className="h-3 w-3 text-muted-foreground" /></span></TooltipTrigger><TooltipContent side="top" className="max-w-[260px] text-xs">Pre-fill state via debug_traceTransaction prestateTracer for accurate mid-block replay. Requires the node to support the debug namespace.</TooltipContent></Tooltip></TooltipProvider>
                    </label>
                    <label className={`flex items-center gap-1.5 text-xs ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <Checkbox
                        checked={config.forkMode}
                        disabled={locked}
                        onCheckedChange={(v) => {
                          updateConfig({ forkMode: !!v });
                        }}
                      />
                      <span>Fork Mode</span>
                      <TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><span className="flex-shrink-0 cursor-default"><HelpCircle className="h-3 w-3 text-muted-foreground" /></span></TooltipTrigger><TooltipContent side="top" className="max-w-[260px] text-xs">Enable fork mode to inject patches (stack/memory modifications) before re-running the transaction. Fork mode does not save cache.</TooltipContent></Tooltip></TooltipProvider>
                    </label>
                    <label className={`flex items-center gap-1.5 text-xs ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <Checkbox
                        checked={config.enableShadow}
                        disabled={locked}
                        onCheckedChange={(v) => {
                          updateConfig({ enableShadow: !!v });
                        }}
                      />
                      <span>Shadow Trace</span>
                      <TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><span className="flex-shrink-0 cursor-default"><HelpCircle className="h-3 w-3 text-muted-foreground" /></span></TooltipTrigger><TooltipContent side="top" className="max-w-[260px] text-xs">Enable backend shadow data-flow tracking. Turn off for performance baseline measurement.</TooltipContent></Tooltip></TooltipProvider>
                    </label>
                    <label className={`flex items-center gap-1.5 text-xs ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <Checkbox
                        checked={config.pauseOpJump}
                        disabled={locked}
                        onCheckedChange={(v) => {
                          updateConfig({ pauseOpJump: !!v });
                        }}
                      />
                      <span>PauseOp Jump</span>
                      <TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><span className="flex-shrink-0 cursor-default"><HelpCircle className="h-3 w-3 text-muted-foreground" /></span></TooltipTrigger><TooltipContent side="top" className="max-w-[260px] text-xs">During playback, jump directly to the nearest step matching a paused opcode instead of playing step-by-step.</TooltipContent></Tooltip></TooltipProvider>
                    </label>
                  </div>
                </Card>
              </div>
            </div>
          </TabsContent>

          {showTraceTabs ? (
          <TabsContent value="calltree" className="flex-1 min-h-0 overflow-hidden px-4 pb-4 mt-0">
            {callTreeNodes.length > 0 ? (
              <div className="h-full">
                <CallTreeViewer
                  onSeekTo={onSeekTo}
                  onSelectFrame={onSelectFrame}
                  onNavigateTo={onNavigateTo}
                  onOpenInFloating={openCallTreeInFloating}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <Button
                  onClick={onBuildCallTree}
                  variant="outline"
                  disabled={isDebugging || !hasCallFrames}
                >
                  Build Call Tree
                </Button>
              </div>
            )}
          </TabsContent>
          ) : null}
          {showTraceTabs ? (
          <TabsContent value="frames" className="flex-1 min-h-0 overflow-auto px-3 pb-4 mt-0">
            {callFrames.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
                No call frames, please start debugging and generate call tree first.
              </div>
            ) : (
              (() => {
                const groups = new Map<string, typeof callFrames>();
                for (const frame of callFrames) {
                  const key = frame.contract ?? frame.address ?? frame.target ?? "unknown";
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(frame);
                }
                const groupKeys = Array.from(groups.keys());
                return (
                  <>
                    {/* 工具栏 */}
                    <div className="flex items-center gap-2 pt-2 pb-1">
                      <button
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1 py-0.5 rounded hover:bg-muted/50"
                        onClick={() => collapseAll(groupKeys)}
                      >Collapse All</button>
                      <span className="text-muted-foreground/30 text-[10px]">|</span>
                      <button
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors px-1 py-0.5 rounded hover:bg-muted/50"
                        onClick={expandAll}
                      >Expand All</button>
                    </div>
                    <div className="space-y-0.5">
                      {Array.from(groups.entries()).map(([contract, frames]) => {
                        const collapsed = collapsedGroups.has(contract);
                        const frameIds = frames.map(f => f.id);
                        const isGroupHidden = frameIds.every(id => hiddenFrameIds.has(id));
                        return (
                          <div key={contract} className="mb-1">
                            {/* 合约地址折叠行 */}
                            <div
                              className="flex items-center gap-1.5 py-1 text-[11px] font-mono text-foreground/70 hover:text-foreground transition-colors cursor-pointer select-none"
                              onClick={() => toggleGroup(contract)}
                            >
                              <ChevronRight className={`h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform ${collapsed ? '' : 'rotate-90'}`} />
                              <span className="shrink min-w-0 truncate font-medium">{contract}</span>
                              <span className="flex-shrink-0 text-[10px] text-muted-foreground tabular-nums ml-1.5">{frames.length}</span>
                              <Checkbox
                                className="ml-1.5 flex-shrink-0 h-3 w-3"
                                checked={!isGroupHidden}
                                title={isGroupHidden ? "Show in tab bar" : "Hide from tab bar"}
                                onClick={(e) => e.stopPropagation()}
                                onCheckedChange={() => toggleGroupVisibility(frameIds, isGroupHidden)}
                              />
                            </div>
                            {/* frame 列表 */}
                            {!collapsed && (
                              <div className="pl-6 space-y-px">
                                {frames.map((frame) => (
                                  <div
                                    key={frame.id}
                                    className="flex items-center gap-1.5 py-0.5 pr-1 pl-2 text-[11px] font-mono cursor-pointer rounded hover:bg-muted/50 transition-colors group"
                                    onClick={() => onSelectFrame?.(frame.id)}
                                  >
                                    <span
                                      className="text-muted-foreground min-w-[2.25rem] text-right flex-shrink-0 group-hover:text-foreground/60 tabular-nums"
                                      title={showTxOnFrameList ? `transaction ${(frame.transactionId ?? 0) + 1}, frame ${frame.contextId}` : undefined}
                                    >
                                      {showTxOnFrameList && frame.transactionId !== undefined
                                        ? `Tx${frame.transactionId + 1}#${frame.contextId}`
                                        : frame.contextId}
                                    </span>
                                    {frame.callType && (
                                      <span className={`px-1 rounded-sm text-[10px] font-semibold flex-shrink-0 ${
                                        frame.callType === "delegatecall" ? "bg-yellow-500/20 text-yellow-400" :
                                        frame.callType === "staticcall" ? "bg-blue-500/20 text-blue-400" :
                                        frame.callType === "create" || frame.callType === "create2" ? "bg-purple-500/20 text-purple-400" :
                                        "bg-emerald-500/20 text-emerald-400"
                                      }`}>{frame.callType.toUpperCase()}</span>
                                    )}
                                    {frame.success === false && (
                                      <span className="px-1 rounded-sm text-[10px] font-semibold flex-shrink-0 bg-red-500/20 text-red-400">REVERT</span>
                                    )}
                                    {frame.input && frame.input !== "0x" && frame.input !== "" ? (
                                      <span className="text-muted-foreground/70 truncate group-hover:text-muted-foreground">{frame.input}</span>
                                    ) : (
                                      <span className="text-muted-foreground/30 text-[10px]">no calldata</span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()
            )}
          </TabsContent>
          ) : null}
          {showTraceTabs ? (
          <TabsContent value="changes" className="flex-1 min-h-0 overflow-hidden px-4 pb-4 mt-0">
            <BalanceChangesViewer />
          </TabsContent>
          ) : null}
        </Tabs>
      </div>
    </>
  );
}
