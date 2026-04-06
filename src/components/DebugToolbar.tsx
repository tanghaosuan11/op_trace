import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { BottomSheetShell } from "@/components/ui/bottom-sheet-shell";
import { Input } from "@/components/ui/input";
import { ProgressBar } from "@/components/ProgressBar";
import { CallTreeViewer } from "@/components/CallTreeViewer";
import { useDebugStore } from "@/store/debugStore";
import { useForkStore } from "@/store/forkStore";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { findCallPatterns, MatchResult } from "@/lib/patternMatcher";
import { ShadowDiagnosticsDialog } from "@/components/ShadowDiagnosticsDialog";
import { useDebugUiActions } from "@/hooks/useDebugUiActions";
import { openForkWindow } from "@/lib/windowActions";
import { getWindowMode } from "@/lib/windowMode";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  ArrowRightFromLine,
  ArrowUpFromLine,
  Play,
  Pause,
  StepBack,
  StepForward,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Bug,
} from "lucide-react";
import { frameScopeKeyFromFrame } from "@/lib/frameScope";
import { useFloatingPanel } from "@/components/floating-panel";
import { ipcCommands } from "@/lib/ipcConfig";
import {
  forkBalanceDecimalToWeiHex,
  type ForkBalanceUnit,
} from "@/lib/forkBalanceWei";

interface DebugToolbarProps {
  onStepInto: () => void;
  onStepOver: () => void;
  onStepOut: () => void;
  onContinue: () => void;
  onStepBack: () => void;
  onDebugDump?: () => void;
  onBreakOpcodesChange: (opcodes: Set<number>) => void;
  /** 进度条拖拽用，不记历史 */
  onSeekTo: (index: number) => void;
  /** CallTree 节点点击用，记入导航历史 */
  onSeekToWithHistory?: (index: number) => void;
  onSpeedChange: (speed: number) => void;
  onNavBack?: () => void;
  onNavForward?: () => void;
  onSelectFrame?: (frameId: string) => void;
  onNavigateTo?: (stepIndex: number, frameId: string) => void;
  onStartDebug?: () => void;
  onOpenCfgWindow?: () => void;
}

export function DebugToolbar({
  onStepInto,
  onStepOver,
  onStepOut,
  onContinue,
  onStepBack,
  onDebugDump,
  onBreakOpcodesChange,
  onSeekTo,
  onSeekToWithHistory,
  onSpeedChange,
  onNavBack,
  onNavForward,
  onSelectFrame,
  onNavigateTo,
  onStartDebug,
  onOpenCfgWindow,
}: DebugToolbarProps) {
  interface PatternCacheEntry {
    selector: string;
    opcodeSig: string;
    result: MatchResult;
  }
  const buildOpcodeSig = (ops: Array<{ pc: number; name: string; data?: string }>): string => {
    if (!ops.length) return "0";
    const first = ops[0];
    const last = ops[ops.length - 1];
    return `${ops.length}:${first.pc}:${last.pc}:${first.name}:${last.name}`;
  };

  const toJsonSafe = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(toJsonSafe);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) out[k] = toJsonSafe(o[k]);
      return out;
    }
    return v;
  };

  // store state
  const disabled = !useDebugStore((s) => s.stepCount);
  const traceFinished = useDebugStore((s) => s.traceFinished);
  const isPlaying = useDebugStore((s) => s.isPlaying);
  const breakOpcodes = useDebugStore((s) => s.breakOpcodes);
  const stepCount = useDebugStore((s) => s.stepCount);
  const canNavBack = useDebugStore((s) => s.canNavBack);
  const canNavForward = useDebugStore((s) => s.canNavForward);
  const isDebug = useDebugStore((s) => s.config.isDebug);
  const pauseConditions = useDebugStore((s) => s.condNodes);
  const tx = useDebugStore((s) => s.tx);
  const txData = useDebugStore((s) => s.txData);
  const blockData = useDebugStore((s) => s.blockData);
  const txDataList = useDebugStore((s) => s.txDataList);
  const txSlots = useDebugStore((s) => s.txSlots);
  const debugByTx = useDebugStore((s) => s.debugByTx);
  const rpcUrl = useDebugStore((s) => s.config.rpcUrl);
  const sessionId = useDebugStore((s) => s.sessionId);
  const hasCallTree = useDebugStore((s) => s.callTreeNodes.length > 0);
  const isCallTreeOpen = useDebugStore((s) => s.isCallTreeOpen);
  const activeTab = useDebugStore((s) => s.activeTab);
  const callFrames = useDebugStore((s) => s.callFrames);
  const activeFrame =
    callFrames.find((f) => f.id === activeTab) ??
    (callFrames.length > 0 ? callFrames[callFrames.length - 1] : undefined);
  const activeFrameKey = activeFrame ? frameScopeKeyFromFrame(activeFrame) : "frame:unknown";
  const [showPauseOn, setShowPauseOn] = useState(false);
  const [showFork, setShowFork] = useState(false);
  const [showPatterns] = useState(false);
  const [patternCacheByFrame, setPatternCacheByFrame] = useState<Record<string, PatternCacheEntry>>({});
  const [showProgress, setShowProgress] = useState(true);
  const [toolsCollapsed, setToolsCollapsed] = useState(false);
  const [forkMenuOpen, setForkMenuOpen] = useState(false);
  const forkMode = useDebugStore((s) => s.config.forkMode);
  const isWhatIfMode = getWindowMode().mode === "whatif";
  const forkPatches = useForkStore((s) => s.patches);
  const [patchStep, setPatchStep] = useState("");
  /** ForkConv：stack | memory | storage | value(ETH balance)；空字符串表示未选类型（PC 暂不开放） */
  const [forkPatchKind, setForkPatchKind] = useState<string>("");
  const [patchStackPos, setPatchStackPos] = useState("");
  const [patchStackVal, setPatchStackVal] = useState("");
  const [patchMemOffset, setPatchMemOffset] = useState("");
  const [patchMemVal, setPatchMemVal] = useState("");
  const [patchStorageAddr, setPatchStorageAddr] = useState("");
  const [patchStorageSlot, setPatchStorageSlot] = useState("");
  const [patchStorageVal, setPatchStorageVal] = useState("");
  const [patchValueAddr, setPatchValueAddr] = useState("");
  const [patchTxValue, setPatchTxValue] = useState("");
  const [patchBalanceUnit, setPatchBalanceUnit] = useState<ForkBalanceUnit>("eth");
  const [diagnosticsDialogOpen, setDiagnosticsDialogOpen] = useState(false);
  const activePatternResults = patternCacheByFrame[activeFrameKey]?.result ?? null;
  const hasSession = stepCount > 0;
  const {
    toggleCallTree,
    closeCallTree,
    openLogDrawer,
    openUtilities,
    openAnalysis,
    openCondList,
  } = useDebugUiActions();

  const { showPanel } = useFloatingPanel();
  const openCallTreeInFloating = useCallback(() => {
    showPanel({
      title: "Call Tree",
      children: (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <CallTreeViewer
            onSeekTo={onSeekToWithHistory ?? onSeekTo}
            onSelectFrame={onSelectFrame}
            onNavigateTo={onNavigateTo}
            hideFloatingOpenButton
          />
        </div>
      ),
    });
  }, [showPanel, onSeekToWithHistory, onSeekTo, onSelectFrame, onNavigateTo]);

  const openFork = (inherit: boolean) => {
    try {
      const payload = {
        tx,
        txData: toJsonSafe(txData),
        blockData: toJsonSafe(blockData),
        txDataList: toJsonSafe(txDataList),
        txSlots: toJsonSafe(txSlots),
        debugByTx,
        rpcUrl,
        condNodes: inherit ? pauseConditions : [],
        forkPatches: inherit ? useForkStore.getState().patches : [],
      };
      const { window } = openForkWindow(payload, { readonly: true });
      window.once("tauri://error", (e) => console.error(`[Fork Window(${inherit ? "inherit" : "blank"})] create failed:`, e));
    } catch (e) {
      console.error(`[Fork Window(${inherit ? "inherit" : "blank"})] create threw:`, e);
    }
  };


  return (
    <>
      <div className="flex items-center gap-0.5 px-1.5 py-1 bg-muted/50 border-b">

      <Button
        variant="ghost"
        size="sm"
        onClick={onStepOver}
        disabled={disabled || isPlaying}
        className="h-6 px-2 gap-1"
        title="Skip Call — skip sub-call, stop at next step in current frame"
      >
        <ArrowRightFromLine className="h-3 w-3" />
        <span className="text-[11px]">Skip Call</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onStepOut}
        disabled={disabled || isPlaying}
        className="h-6 px-2 gap-1"
        title="Frame Out — finish current frame, return to parent frame"
      >
        <ArrowUpFromLine className="h-3 w-3" />
        <span className="text-[11px]">Frame Out</span>
      </Button>

      <div className="w-px h-6 bg-border mx-1" />
      <Button
        variant="ghost"
        size="sm"
        onClick={onStepBack}
        disabled={disabled || isPlaying}
        className="h-6 px-2 gap-1"
        title="Last"
      >
        <StepBack className="h-3 w-3" />
        <span className="text-[11px]">Last</span>
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onContinue}
        disabled={disabled}
        className="h-6 px-2 gap-1"
        title={isPlaying ? "Pause" : "Continue (F5)"}
      >
        {isPlaying ? (
          <>
            <Pause className="h-3 w-3" />
            <span className="text-[11px]">Pause</span>
          </>
        ) : (
          <>
            <Play className="h-3 w-3" />
            <span className="text-[11px]">Continue</span>
          </>
        )}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onStepInto}
        disabled={disabled || isPlaying}
        className="h-6 px-2 gap-1"
        title="Next (F11)"
      >
        <StepForward className="h-3 w-3" />
        <span className="text-[11px]">Next</span>
      </Button>

      <Button
        variant={showProgress ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setShowProgress(v => !v)}
        className="h-6 px-2"
        title="Toggle Progress Bar"
      >
        <SlidersHorizontal className="h-3 w-3" />
      </Button>

      <div className="w-px h-6 bg-border mx-1" />
      <Button
        variant={showPauseOn ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setShowPauseOn(v => !v)}
        className="h-6 px-2"
        title="Toggle PauseOn breakpoints"
      >
        <span className="text-[11px]">PauseOp</span>
      </Button>

      <div className="w-px h-6 bg-border mx-0.5" />
      {/* <Button
        variant={showPatterns ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setShowPatterns(v => !v)}
        className="h-6 px-2"
        title="Pattern matcher for function calls and patterns"
      >
        <span className="text-[11px]">Patterns</span>
      </Button> */}

      {forkMode && (
        <>
          <div className="w-px h-6 bg-border mx-0.5" />
          <Popover open={forkMenuOpen} onOpenChange={setForkMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-[60px] px-2 text-[11px]"
                title="Open fork/whatif window"
              >
                Fork
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-auto border-0 p-0.5 shadow-md"
              align="start"
            >
              <div className="flex flex-col">
                <Button
                  variant="ghost"
                  className="h-7 justify-start rounded-sm px-2 text-[11px] font-normal shadow-none focus-visible:ring-0"
                  onClick={() => {
                    setForkMenuOpen(false);
                    openFork(false);
                  }}
                >
                  Blank
                </Button>
                <Button
                  variant="ghost"
                  className="h-7 justify-start rounded-sm px-2 text-[11px] font-normal shadow-none focus-visible:ring-0"
                  onClick={() => {
                    setForkMenuOpen(false);
                    openFork(true);
                  }}
                >
                  Inherit
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </>
      )}

      {forkMode && isWhatIfMode && (
        <Button
          variant={showFork ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setShowFork(v => !v)}
          className="h-6 px-2"
          title="Toggle Fork patch editor"
        >
          <span className="text-[11px]">ForkConv{forkPatches.length > 0 ? ` (${forkPatches.length})` : ""}</span>
        </Button>
      )}

      <div className="flex-1" />

      <Button
        variant="ghost"
        size="sm"
        onClick={() => setToolsCollapsed(v => !v)}
        className="h-6 w-6 p-0"
        title={toolsCollapsed ? "展开工具" : "收起工具"}
      >
        {toolsCollapsed ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </Button>

      {!toolsCollapsed && (<>
      {isDebug && (
        <Button
          variant="outline"
          size="sm"
          onClick={onDebugDump}
          className="h-6 px-2 text-[11px] font-mono"
          title="Dump current frame steps and memory updates to console"
          disabled={!onDebugDump}
        >
          Dump
        </Button>
      )}

      <div className="w-px h-6 bg-border mx-1" />

      {isDebug && hasSession && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button 
                onClick={() => setDiagnosticsDialogOpen(true)} 
                variant="outline" 
                size="sm" 
                className="h-6 px-2.5"
              >
                <Bug className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Shadow Stack Diagnostics</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      <Button
        variant={isCallTreeOpen ? "secondary" : "ghost"}
        size="sm"
        onClick={toggleCallTree}
        className="h-6 px-2 text-[11px]"
        title="Call Tree"
        disabled={!hasCallTree}
      >
        Tree
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={openLogDrawer}
        className="h-6 px-2 text-[11px]"
        title="All Logs (l)"
        disabled={disabled}
      >
        Logs
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={openCondList}
        className="h-6 px-2 relative text-[11px]"
        title="Scan — build conditions, scan trace, jump to hits"
      >
        Scan
        {pauseConditions.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-[9px] leading-none text-primary-foreground">
            {pauseConditions.reduce((sum, n) => {
              const count = (node: (typeof pauseConditions)[0]): number =>
                node.kind === "leaf" ? 1 : count(node.left) + count(node.right);
              return sum + count(n);
            }, 0)}
          </span>
        )}
      </Button>
      <div className="w-px h-6 bg-border mx-1" />

      <Button
        variant="ghost"
        size="sm"
        onClick={openUtilities}
        className="h-6 px-2 text-[11px]"
        title="Utilities (BaseConv, 4Byte, Keccak256)"
      >
        Utils
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={openAnalysis}
        className="h-6 px-2 text-[11px]"
        title="Analysis (JS sandbox)"
      >
        Analysis
      </Button>
      {/* <Button
        variant="ghost"
        size="sm"
        onClick={() => openSymbolicSolve()}
        className="h-6 px-2 text-[11px]"
        title="符号求解 (Z3) — 求满足指定 JUMPI 条件的 calldata"
        disabled={disabled}
      >
        Sym
      </Button> */}

      <Button
        variant="ghost"
        size="sm"
        onClick={onOpenCfgWindow}
        className="h-6 px-2 text-[11px]"
        title={traceFinished ? "Open CFG window" : "Wait until trace has finished loading"}
        disabled={!onOpenCfgWindow || !traceFinished}
      >
        Cfg
      </Button>
      {/* Notes button — hidden until feature is complete
      <Button
        variant="outline"
        size="sm"
        onClick={() => useDebugStore.getState().sync({ isNotesDrawerOpen: true })}
        className="h-6 px-2 text-[11px]"
        title="Notes & Records"
      >
        Notes
      </Button>
      */}
      </>)}
      </div>

      {/* Break opcodes */}
      {showPauseOn && (() => {
        const BREAK_OPCODE_OPTIONS: { opcode: number | number[]; name: string }[] = [
          { opcode: 0xfd, name: "REVERT" },
          { opcode: 0x00, name: "STOP" },
          { opcode: 0xf3, name: "RETURN" },
          { opcode: 0xf1, name: "CALL" },
          { opcode: 0xfa, name: "STATICCALL" },
          { opcode: 0xf4, name: "DELEGATECALL" },
          { opcode: 0xf5, name: "CREATE2" },
          { opcode: 0xf0, name: "CREATE" },
          { opcode: [0xa0, 0xa1, 0xa2, 0xa3, 0xa4], name: "LOG" },
          { opcode: 0x5e, name: "MCOPY" },
          { opcode: 0x51, name: "MLOAD" },
          { opcode: 0x52, name: "MSTORE" },
          { opcode: 0x53, name: "MSTORE8" },
          { opcode: 0x55, name: "SSTORE" },
          { opcode: 0x54, name: "SLOAD" },
          { opcode: 0x5d, name: "TSTORE" },
          { opcode: 0x5c, name: "TLOAD" },
          { opcode: 0x56, name: "JUMP" },
          { opcode: 0x5b, name: "JUMPDEST" },
          { opcode: 0x20, name: "KECCAK256" },
        ];
        return (
          <div className="flex items-center gap-1.5 px-2 py-1 border-b bg-muted/30 flex-wrap">
            <span className="text-xs text-muted-foreground shrink-0">PauseOn:</span>
            {BREAK_OPCODE_OPTIONS.map(({ opcode, name }) => {
              const opcodes = Array.isArray(opcode) ? opcode : [opcode];
              const checked = opcodes.some(op => breakOpcodes.has(op));
              return (
                <label key={name} className="flex items-center gap-0.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const next = new Set(breakOpcodes);
                      if (checked) opcodes.forEach(op => next.delete(op));
                      else opcodes.forEach(op => next.add(op));
                      onBreakOpcodesChange(next);
                    }}
                    className="h-3 w-3 rounded border cursor-pointer accent-primary"
                  />
                  <span className={`text-xs font-mono ${checked ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>{name}</span>
                </label>
              );
            })}
          </div>
        );
      })()}

      {/* Pattern matcher */}
      {showPatterns && (() => {
        const patternOptions = [
          { id: 'call_func', label: 'CallFunc', description: 'Function call pattern: PUSH4 EQ PUSH1 JUMPI' },
        ];
        return (
          <div className="flex items-center gap-1.5 px-2 py-1 border-b bg-muted/30 flex-wrap">
            <span className="text-xs text-muted-foreground shrink-0">Patterns:</span>
            {patternOptions.map(({ id, label, description }) => (
              <Button
                key={id}
                size="sm"
                variant={activePatternResults?.pc.length ? "default" : "outline"}
                className="h-6 px-2 text-xs"
                title={description}
                onClick={() => {
                  const state = useDebugStore.getState();
                  const currentFrame =
                    state.callFrames.find((f) => f.id === state.activeTab) ??
                    (state.callFrames.length > 0 ? state.callFrames[state.callFrames.length - 1] : undefined);
                  const frameKey = currentFrame ? frameScopeKeyFromFrame(currentFrame) : "frame:unknown";
                  const frameOpcodes = currentFrame?.opcodes ?? state.opcodes;
                  const instructionStrings = frameOpcodes.map(op =>
                    op.data ? `${op.name} ${op.data}` : op.name
                  );
                  const opcodeSig = buildOpcodeSig(frameOpcodes);
                  
                  // selector from current frame calldata
                  let selector: string | undefined;
                  if (currentFrame?.input && currentFrame.input.length >= 10) {
                    selector = currentFrame.input.slice(0, 10);
                  }
                  const selectorKey = selector ?? "";

                  const cached = patternCacheByFrame[frameKey];
                  if (cached && cached.selector === selectorKey && cached.opcodeSig === opcodeSig) {
                    console.log("Pattern cache hit:", { frameKey, selector: selectorKey, opcodeSig });
                    return;
                  }
                  
                  const results = findCallPatterns(instructionStrings, selector);
                  // 将索引转换为实际的 PC 地址
                  const pcResults = {
                    pc: results.pc.map(index => frameOpcodes[index].pc),
                    matches: results.matches
                  };
                  console.log("Pattern match results:", pcResults, "selector:", selector, "frame:", frameKey);
                  setPatternCacheByFrame((prev) => ({
                    ...prev,
                    [frameKey]: {
                      selector: selectorKey,
                      opcodeSig,
                      result: pcResults,
                    },
                  }));
                }}
              >
                {label} {activePatternResults?.pc.length ? `(${activePatternResults.pc.length})` : ""}
              </Button>
            ))}
            {activePatternResults?.pc.length ? (
              <div className="flex items-center gap-1 ml-2 pl-2 border-l">
                <span className="text-xs text-muted-foreground">Found at PC:</span>
                <div className="flex gap-1 flex-wrap max-w-sm">
                  {activePatternResults.pc.map((pc) => (
                    <Button
                      key={pc}
                      size="sm"
                      variant="outline"
                      className="h-5 px-1.5 text-[10px] font-mono cursor-default"
                    >
                      0x{pc.toString(16).padStart(4, '0')}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        );
      })()}

      {/* Fork patch editor */}
      {showFork && forkMode && isWhatIfMode && (
        <div className="flex flex-col border-b bg-muted/30">
          <div className="flex items-center gap-1.5 px-2 py-1 flex-wrap">
            <span className="text-xs text-muted-foreground shrink-0">ForkConv</span>
            <Input
              className="h-6 text-xs w-24"
              placeholder="step (1-based)"
              value={patchStep}
              onChange={(e) => setPatchStep(e.target.value)}
            />
            <Select
              value={forkPatchKind || undefined}
              onValueChange={(v) => setForkPatchKind(v)}
            >
              <SelectTrigger className="h-6 w-[100px] px-2 text-[11px]" title="Patch kind">
                <SelectValue placeholder="Kind" />
              </SelectTrigger>
              <SelectContent className="min-w-[100px] p-1 text-[11px]">
                <SelectItem value="stack" className="h-6 text-[11px]">Stack</SelectItem>
                <SelectItem value="memory" className="h-6 text-[11px]">Memory</SelectItem>
                <SelectItem value="storage" className="h-6 text-[11px]">Storage</SelectItem>
                <SelectItem value="value" className="h-6 text-[11px]">Balance</SelectItem>
              </SelectContent>
            </Select>

            {forkPatchKind === "stack" && (
              <>
                <Input
                  className="h-6 text-xs w-20"
                  placeholder="stack pos"
                  title="0 = stack top"
                  value={patchStackPos}
                  onChange={(e) => setPatchStackPos(e.target.value)}
                />
                <span className="text-[10px] text-muted-foreground shrink-0 max-w-[7rem] leading-tight" title="0 = stack top">
                  0 = stack top
                </span>
                <Input
                  className="h-6 text-xs min-w-[12rem] flex-1 max-w-md"
                  placeholder="value (0x...)"
                  value={patchStackVal}
                  onChange={(e) => setPatchStackVal(e.target.value)}
                />
              </>
            )}
            {forkPatchKind === "memory" && (
              <>
                <Input
                  className="h-6 text-xs w-24"
                  placeholder="mem offset"
                  value={patchMemOffset}
                  onChange={(e) => setPatchMemOffset(e.target.value)}
                />
                <Input
                  className="h-6 text-xs min-w-[12rem] flex-1 max-w-md"
                  placeholder="data (0x...)"
                  value={patchMemVal}
                  onChange={(e) => setPatchMemVal(e.target.value)}
                />
              </>
            )}
            {forkPatchKind === "storage" && (
              <>
                <Input
                  className="h-6 text-xs w-36 font-mono"
                  placeholder="address (0x...)"
                  value={patchStorageAddr}
                  onChange={(e) => setPatchStorageAddr(e.target.value)}
                />
                <Input
                  className="h-6 text-xs w-32 font-mono"
                  placeholder="slot (0x...)"
                  value={patchStorageSlot}
                  onChange={(e) => setPatchStorageSlot(e.target.value)}
                />
                <Input
                  className="h-6 text-xs min-w-[10rem] flex-1 max-w-md font-mono"
                  placeholder="value (0x...)"
                  value={patchStorageVal}
                  onChange={(e) => setPatchStorageVal(e.target.value)}
                />
              </>
            )}
            {forkPatchKind === "value" && (
              <>
                <Input
                  className="h-6 text-xs flex-1 min-w-[6rem] max-w-[18rem] font-mono"
                  placeholder="address (0x...)"
                  value={patchValueAddr}
                  onChange={(e) => setPatchValueAddr(e.target.value)}
                />
                <div className="flex shrink-0 items-center gap-0.5">
                  <Input
                    className="h-6 w-[5.25rem] text-xs px-1.5 tabular-nums"
                    placeholder="amount"
                    title="Decimal amount; converted to wei when adding"
                    value={patchTxValue}
                    onChange={(e) => setPatchTxValue(e.target.value)}
                  />
                  <Select
                    value={patchBalanceUnit}
                    onValueChange={(v) => setPatchBalanceUnit(v as ForkBalanceUnit)}
                  >
                    <SelectTrigger className="h-6 w-[4.25rem] px-1 text-[11px]" title="Unit (converted to wei)">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="min-w-[4.25rem] p-1 text-[11px]">
                      <SelectItem value="wei" className="h-6 text-[11px]">Wei</SelectItem>
                      <SelectItem value="gwei" className="h-6 text-[11px]">GWei</SelectItem>
                      <SelectItem value="eth" className="h-6 text-[11px]">ETH</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            <Button size="sm" className="h-6 px-2 text-xs" onClick={() => void (async () => {
              if (!forkPatchKind) {
                toast.error("Select a patch kind first");
                return;
              }
              const stepIdx = parseInt(patchStep, 10);
              if (isNaN(stepIdx) || stepIdx < 1) {
                toast.error("Invalid step (1-based)");
                return;
              }
              const stepIndex0 = stepIdx - 1;

              const sid = sessionId?.trim();
              if (!sid) {
                toast.error("No debug session — run a trace first to validate");
                return;
              }

              const stackPatches: { pos: number; value: string }[] = [];
              const memoryPatches: { offset: number; value: string }[] = [];
              const storagePatches: { address: string; slot: string; value: string }[] = [];
              const balancePatches: { address: string; value: string }[] = [];

              try {
                if (forkPatchKind === "value") {
                  if (!patchValueAddr.trim() || !patchTxValue.trim()) {
                    toast.error("Enter address and balance amount");
                    return;
                  }
                  let valueWeiHex: string;
                  try {
                    valueWeiHex = forkBalanceDecimalToWeiHex(patchTxValue, patchBalanceUnit);
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    toast.error(msg || "Invalid amount");
                    return;
                  }
                  await invoke(ipcCommands.validateForkPatch, {
                    sessionId: sid,
                    stepIndex: stepIndex0,
                    kind: "value",
                    balanceAddressHex: patchValueAddr.trim(),
                    valueHex: valueWeiHex,
                  });
                  balancePatches.push({
                    address: patchValueAddr.trim(),
                    value: valueWeiHex,
                  });
                }

                if (forkPatchKind === "stack") {
                  if (!patchStackPos.trim() || !patchStackVal.trim()) {
                    toast.error("Enter stack position and value");
                    return;
                  }
                  const pos = parseInt(patchStackPos, 10);
                  if (isNaN(pos) || pos < 0) {
                    toast.error("Invalid stack position");
                    return;
                  }
                  await invoke(ipcCommands.validateForkPatch, {
                    sessionId: sid,
                    stepIndex: stepIndex0,
                    kind: "stack",
                    stackPos: pos,
                  });
                  stackPatches.push({ pos, value: patchStackVal.trim() });
                }

                if (forkPatchKind === "memory") {
                  if (!patchMemOffset.trim() || !patchMemVal.trim()) {
                    toast.error("Enter memory offset and data");
                    return;
                  }
                  const offset = parseInt(patchMemOffset, 10);
                  if (isNaN(offset) || offset < 0) {
                    toast.error("Invalid memory offset");
                    return;
                  }
                  await invoke(ipcCommands.validateForkPatch, {
                    sessionId: sid,
                    stepIndex: stepIndex0,
                    kind: "memory",
                    memOffset: offset,
                    memHex: patchMemVal.trim(),
                  });
                  memoryPatches.push({ offset, value: patchMemVal.trim() });
                }

                if (forkPatchKind === "storage") {
                  if (!patchStorageAddr.trim() || !patchStorageSlot.trim() || !patchStorageVal.trim()) {
                    toast.error("Enter storage address, slot, and value");
                    return;
                  }
                  await invoke(ipcCommands.validateForkPatch, {
                    sessionId: sid,
                    stepIndex: stepIndex0,
                    kind: "storage",
                    storageAddressHex: patchStorageAddr.trim(),
                    storageSlotHex: patchStorageSlot.trim(),
                    storageValueHex: patchStorageVal.trim(),
                  });
                  storagePatches.push({
                    address: patchStorageAddr.trim(),
                    slot: patchStorageSlot.trim(),
                    value: patchStorageVal.trim(),
                  });
                }

                useForkStore.getState().addPatch({
                  id: crypto.randomUUID(),
                  stepIndex: stepIndex0,
                  stackPatches,
                  memoryPatches,
                  storagePatches,
                  balancePatches,
                });
                setForkPatchKind("");
                setPatchStackPos(""); setPatchStackVal(""); setPatchMemOffset(""); setPatchMemVal("");
                setPatchStorageAddr(""); setPatchStorageSlot(""); setPatchStorageVal("");
                setPatchValueAddr(""); setPatchTxValue("");
                setPatchBalanceUnit("eth");
              } catch (e) {
                const msg = typeof e === "string" ? e : (e instanceof Error ? e.message : String(e));
                toast.error(msg);
              }
            })()}>
              + Add
            </Button>
            <Button size="sm" variant="outline" className="h-6 px-2 text-xs bg-white hover:bg-gray-50 text-black" onClick={() => onStartDebug?.()} title="Rerun">
              ForkRun
            </Button>
          </div>
          {forkPatches.length > 0 && (
            <div className="flex items-center gap-0.5 px-1.5 py-px text-[10px] text-muted-foreground overflow-x-auto">
              {forkPatches.map((p, i) => (
                <Popover key={p.id}>
                  <PopoverTrigger asChild>
                    <span className="flex items-center gap-0.5 bg-muted px-1 py-px rounded whitespace-nowrap cursor-pointer hover:bg-muted-foreground/20">
                      #{i + 1} s={p.stepIndex + 1}
                      {p.stackPatches.length > 0 && ` k${p.stackPatches.length}`}
                      {p.memoryPatches.length > 0 && ` m${p.memoryPatches.length}`}
                      {(p.storagePatches?.length ?? 0) > 0 && ` st${p.storagePatches?.length ?? 0}`}
                      {(p.balancePatches?.length ?? 0) > 0 && ` b${p.balancePatches?.length ?? 0}`}
                      {i === forkPatches.length - 1 && (
                        <button
                          className="ml-1 text-muted-foreground hover:text-destructive leading-none"
                          title="Delete last patch"
                          onClick={(e) => {
                            e.stopPropagation();
                            useForkStore.getState().removeLastPatch();
                          }}
                        >×</button>
                      )}
                    </span>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto max-w-md text-xs">
                    <div className="space-y-1.5">
                      <div><span className="font-semibold">Step:</span> {p.stepIndex + 1} (0-based: {p.stepIndex})</div>
                      {p.stackPatches.length > 0 && (
                        <div>
                          <div className="font-semibold mb-0.5">Stack Patches:</div>
                          {p.stackPatches.map((sp, idx) => (
                            <div key={idx} className="ml-2 text-muted-foreground font-mono text-[10px]">pos {sp.pos}: {sp.value}</div>
                          ))}
                        </div>
                      )}
                      {p.memoryPatches.length > 0 && (
                        <div>
                          <div className="font-semibold mb-0.5">Memory Patches:</div>
                          {p.memoryPatches.map((mp, idx) => (
                            <div key={idx} className="ml-2 text-muted-foreground font-mono text-[10px] break-all">offset {mp.offset}: {mp.value}</div>
                          ))}
                        </div>
                      )}
                      {(p.storagePatches?.length ?? 0) > 0 && (
                        <div>
                          <div className="font-semibold mb-0.5">Storage Patches:</div>
                          {(p.storagePatches ?? []).map((sp, idx) => (
                            <div key={idx} className="ml-2 text-muted-foreground font-mono text-[10px] break-all">
                              {sp.address} · slot {sp.slot} → {sp.value}
                            </div>
                          ))}
                        </div>
                      )}
                      {(p.balancePatches?.length ?? 0) > 0 && (
                        <div>
                          <div className="font-semibold mb-0.5">Balance Patches (wei, hex):</div>
                          {(p.balancePatches ?? []).map((bp, idx) => (
                            <div key={idx} className="ml-2 text-muted-foreground font-mono text-[10px] break-all">
                              {bp.address} → {bp.value}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              ))}
            </div>
          )}
        </div>
      )}

      {showProgress && stepCount > 0 && (
        <div className="flex items-center gap-1 px-1">
          <Button
            variant="ghost"
            size="icon"
            className={`h-6 w-6 flex-shrink-0 transition-opacity ${!canNavBack ? "!opacity-20" : ""}`}
            disabled={!canNavBack}
            onClick={onNavBack}
            title="Navigate Back"
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={`h-6 w-6 flex-shrink-0 transition-opacity ${!canNavForward ? "!opacity-20" : ""}`}
            disabled={!canNavForward}
            onClick={onNavForward}
            title="Navigate Forward"
          >
            <ChevronRight className="h-3 w-3" />
          </Button>
          <div className="flex-1 min-w-0">
            <ProgressBar
              onSeekTo={onSeekTo}
              onSpeedChange={onSpeedChange}
            />
          </div>
        </div>
      )}

    {/* Bottom call tree sheet */}
    <BottomSheetShell
      open={isCallTreeOpen}
      onOpenChange={(o) => { if (!o) closeCallTree(); }}
      sheetTitle="Call Tree"
      defaultHeightVh={50}
    >
        <div className="flex-1 min-h-0 overflow-hidden">
          <CallTreeViewer
            onSeekTo={onSeekToWithHistory ?? onSeekTo}
            onSelectFrame={onSelectFrame}
            onNavigateTo={onNavigateTo}
            onOpenInFloating={hasCallTree ? openCallTreeInFloating : undefined}
          />
        </div>
    </BottomSheetShell>

    <ShadowDiagnosticsDialog open={diagnosticsDialogOpen} onOpenChange={setDiagnosticsDialogOpen} />
    </>
  );
}
