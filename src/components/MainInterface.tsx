import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { TxInfo } from "@/components/TxInfo";
import { BlockInfo } from "@/components/BlockInfo";
import { CallTreeViewer } from "@/components/CallTreeViewer";
import { BalanceChangesViewer } from "@/components/BalanceChangesViewer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState } from "react";
import { ChevronRight, HelpCircle, FolderOpen } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebugStore } from "@/store/debugStore";
import { setConfig } from "@/lib/appConfig";
import { setSelectedRpc } from "@/lib/rpcConfig";

interface MainInterfaceProps {
  onTxChange: (value: string) => void;
  onFetchTx: () => void;
  onStartDebug: () => void;
  onReset: () => void;
  onOpenTestDialog: () => void;
  onTxFieldChange: (field: string, value: string) => void;
  onBlockFieldChange: (field: string, value: string) => void;
  onBuildCallTree?: () => void;
  onSeekTo?: (index: number) => void;
  onSelectFrame?: (frameId: string) => void;
  onNavigateTo?: (stepIndex: number, frameId: string) => void;
}

export function MainInterface({
  onTxChange,
  onFetchTx,
  onStartDebug,
  onReset,
  onOpenTestDialog,
  onTxFieldChange,
  onBlockFieldChange,
  onBuildCallTree,
  onSeekTo,
  onSelectFrame,
  onNavigateTo,
}: MainInterfaceProps) {
  // 从 store 读取数据状态
  const tx = useDebugStore((s) => s.tx);
  const txData = useDebugStore((s) => s.txData);
  const blockData = useDebugStore((s) => s.blockData);
  const isFetchingTx = useDebugStore((s) => s.isFetchingTx);
  const txError = useDebugStore((s) => s.txError);
  const isDebugging = useDebugStore((s) => s.isDebugging);
  const stepCount = useDebugStore((s) => s.stepCount);
  // 调试完成 = 不在调试中且有步数数据（isDebugging 在 invoke 结束后变 false）
  const hasSession = !isDebugging && stepCount > 0;
  // 锁定所有输入：正在调试 or 已有 session（需 Reset 才能解锁）
  const locked = isDebugging || hasSession;
  const hasCallFrames = useDebugStore((s) => s.hasCallFrames);
  const callTreeNodes = useDebugStore((s) => s.callTreeNodes);
  const config = useDebugStore((s) => s.config);
  const callFrames = useDebugStore((s) => s.callFrames);
  const [activeTab, setActiveTab] = useState("info");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const hiddenFrameIds = useDebugStore((s) => s.hiddenFrameIds);
  const toggleGroup = (key: string) =>
    setCollapsedGroups(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const collapseAll = (keys: string[]) => setCollapsedGroups(new Set(keys));
  const expandAll = () => setCollapsedGroups(new Set());
  const toggleGroupVisibility = (frameIds: string[], currentlyHidden: boolean) => {
    const { hiddenFrameIds: cur, sync } = useDebugStore.getState();
    const next = new Set(cur);
    if (currentlyHidden) {
      frameIds.forEach(id => next.delete(id));
    } else {
      frameIds.forEach(id => next.add(id));
    }
    sync({ hiddenFrameIds: next });
  };
  return (
    <>
      <div className="flex-shrink-0 px-4 py-2 border-b bg-muted/20">
        <div className="flex items-center gap-2 justify-center">
          <Input
            value={config.rpcUrl}
            onChange={(e) => {
              const next = setConfig({ rpcUrl: e.target.value });
              useDebugStore.getState().sync({ config: next });
              setSelectedRpc(e.target.value);
            }}
            readOnly={locked}
            className="font-mono text-xs h-7 w-[40ch] flex-none"
            placeholder="RPC URL"
          />
          <Input
            value={config.scanUrl}
            onChange={(e) => {
              const next = setConfig({ scanUrl: e.target.value });
              useDebugStore.getState().sync({ config: next });
            }}
            readOnly={locked}
            className="font-mono text-xs h-7 flex-none min-w-0 w-[30ch]"
            placeholder="Scan URL"
          />
          <div className="h-5 w-px bg-border flex-shrink-0" />
          <Input
            placeholder="TX Hash"
            value={tx}
            onChange={(e) => onTxChange(e.target.value)}
            disabled={isDebugging || hasSession}
            className="font-mono text-xs h-7 w-[70ch] flex-none"
          />
          <Button onClick={onFetchTx} disabled={isFetchingTx || isDebugging || hasSession} size="sm" className="whitespace-nowrap h-7 px-3">
            {isFetchingTx ? "Fetching..." : "Get Tx"}
          </Button>
          {hasSession ? (
            <Button onClick={onReset} variant="destructive" size="sm" className="whitespace-nowrap h-7 px-3">
              Reset
            </Button>
          ) : (
            <Button onClick={onStartDebug} disabled={isDebugging || !txData} variant="outline" size="sm" className="whitespace-nowrap h-7 px-3">
              {isDebugging ? "Debugging..." : "Start Debug"}
            </Button>
          )}
          {config.isDebug && (
            <Button onClick={onOpenTestDialog} variant="outline" size="sm" className="whitespace-nowrap h-7 px-3">
              Test Parse
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <div className="flex-shrink-0 px-4 pt-2">
            <TabsList className="h-7 bg-transparent p-0">
              <TabsTrigger value="info" className="text-xs px-2 py-0.5">Info</TabsTrigger>
              <TabsTrigger value="calltree" className="text-xs px-2 py-0.5">Call Tree</TabsTrigger>
              <TabsTrigger value="frames" className="text-xs px-2 py-0.5">Frames</TabsTrigger>
              <TabsTrigger value="changes" className="text-xs px-2 py-0.5">Balance Changes</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="info" className="flex-1 min-h-0 overflow-hidden px-4 pb-4 mt-0">
            <div className="flex gap-3 h-full pt-3">
              {/* Left: Transaction */}
              <div className="flex-[2.5] min-w-0 overflow-y-auto">
                <TxInfo
                  txHash={txData?.txHash}
                  from={txData?.from}
                  to={txData?.to ?? undefined}
                  value={txData?.value}
                  gasPrice={txData?.gasPrice}
                  gasLimit={txData?.gasLimit}
                  gasUsed={txData?.gasUsed}
                  data={txData?.data}
                  status={txData?.status}
                  isLoading={isFetchingTx}
                  error={txError}
                  readOnly={locked}
                  onFieldChange={onTxFieldChange}
                />
              </div>

              {/* Middle: Block */}
              <div className="flex-[2] min-w-0 overflow-y-auto">
                <BlockInfo
                  blockNumber={blockData?.blockNumber}
                  timestamp={blockData?.timestamp}
                  gasLimit={blockData?.gasLimit}
                  baseFeePerGas={blockData?.baseFeePerGas}
                  isLoading={isFetchingTx}
                  readOnly={locked}
                  onFieldChange={onBlockFieldChange}
                />
              </div>

              {/* Right: Config */}
              <div className="flex-[2] min-w-0 overflow-y-auto">
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
                          const next = setConfig({ useAlloyCache: !!v });
                          useDebugStore.getState().sync({ config: next });
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
                          const next = setConfig({ usePrestate: !!v });
                          useDebugStore.getState().sync({ config: next });
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
                          const next = setConfig({ forkMode: !!v });
                          useDebugStore.getState().sync({ config: next });
                        }}
                      />
                      <span>Fork Mode</span>
                      <TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><span className="flex-shrink-0 cursor-default"><HelpCircle className="h-3 w-3 text-muted-foreground" /></span></TooltipTrigger><TooltipContent side="top" className="max-w-[260px] text-xs">Enable fork mode to inject patches (stack/memory modifications) before re-running the transaction. Fork mode does not save cache.</TooltipContent></Tooltip></TooltipProvider>
                    </label>
                    <label className={`flex items-center gap-1.5 text-xs ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <Checkbox
                        checked={config.pauseOpJump}
                        disabled={locked}
                        onCheckedChange={(v) => {
                          const next = setConfig({ pauseOpJump: !!v });
                          useDebugStore.getState().sync({ config: next });
                        }}
                      />
                      <span>PauseOp Jump</span>
                      <TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><span className="flex-shrink-0 cursor-default"><HelpCircle className="h-3 w-3 text-muted-foreground" /></span></TooltipTrigger><TooltipContent side="top" className="max-w-[260px] text-xs">During playback, jump directly to the nearest step matching a paused opcode instead of playing step-by-step.</TooltipContent></Tooltip></TooltipProvider>
                    </label>
                    <label className={`flex items-center gap-1.5 text-xs ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <Checkbox
                        checked={config.pauseCondJump}
                        disabled={locked}
                        onCheckedChange={(v) => {
                          const next = setConfig({ pauseCondJump: !!v });
                          useDebugStore.getState().sync({ config: next });
                        }}
                      />
                      <span>PauseConv Jump</span>
                      <TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><span className="flex-shrink-0 cursor-default"><HelpCircle className="h-3 w-3 text-muted-foreground" /></span></TooltipTrigger><TooltipContent side="top" className="max-w-[260px] text-xs">During playback, jump directly to the nearest condition-matched step instead of playing step-by-step.</TooltipContent></Tooltip></TooltipProvider>
                    </label>
                  </div>
                </Card>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="calltree" className="flex-1 min-h-0 overflow-hidden px-4 pb-4 mt-0">
            {callTreeNodes.length > 0 ? (
              <div className="h-full">
                <CallTreeViewer
                  onSeekTo={onSeekTo}
                  onSelectFrame={onSelectFrame}
                  onNavigateTo={onNavigateTo}
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
                                    <span className="text-muted-foreground w-5 text-right flex-shrink-0 group-hover:text-foreground/60">{frame.contextId}</span>
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
          <TabsContent value="changes" className="flex-1 min-h-0 overflow-hidden px-4 pb-4 mt-0">
            <BalanceChangesViewer />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
