import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { ProgressBar } from "@/components/ProgressBar";
import { CallTreeViewer } from "@/components/CallTreeViewer";
import { useDebugStore } from "@/store/debugStore";
import { useForkStore } from "@/store/forkStore";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import {
  PauseConditionType,
  PauseCondition,
  PAUSE_CONDITION_LABELS,
} from "@/lib/pauseConditions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  ArrowDownToLine, 
  ArrowRightFromLine,
  ArrowUpFromLine,
  Play,
  Pause,
  Undo2,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

interface DebugToolbarProps {
  onStepInto: () => void;
  onStepOver: () => void;
  onStepOut: () => void;
  onContinue: () => void;
  onStepBack: () => void;
  onDebugDump?: () => void;
  onBreakOpcodesChange: (opcodes: Set<number>) => void;
  onSeekTo: (index: number) => void;
  onSpeedChange: (speed: number) => void;
  onNavBack?: () => void;
  onNavForward?: () => void;
  onSelectFrame?: (frameId: string) => void;
  onNavigateTo?: (stepIndex: number, frameId: string) => void;
  onRunConditionScan?: () => void;
  onStartDebug?: () => void;
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
  onSpeedChange,
  onNavBack,
  onNavForward,
  onSelectFrame,
  onNavigateTo,
  onRunConditionScan,
  onStartDebug,
}: DebugToolbarProps) {
  // 从 store 读取 data 状态
  const disabled = !useDebugStore((s) => s.stepCount);
  const isPlaying = useDebugStore((s) => s.isPlaying);
  const breakOpcodes = useDebugStore((s) => s.breakOpcodes);
  const stepCount = useDebugStore((s) => s.stepCount);
  const canNavBack = useDebugStore((s) => s.canNavBack);
  const canNavForward = useDebugStore((s) => s.canNavForward);
  const isDebug = useDebugStore((s) => s.config.isDebug);
  const pauseConditions = useDebugStore((s) => s.condNodes);
  const hasCallTree = useDebugStore((s) => s.callTreeNodes.length > 0);
  const [activeDrawer, setActiveDrawer] = useState<string | null>(null);
  const [showPauseOn, setShowPauseOn] = useState(false);
  const [showCond, setShowCond] = useState(false);
  const [showFork, setShowFork] = useState(false);
  const [condType, setCondType] = useState<PauseConditionType>("sstore_slot");
  const [condValue, setCondValue] = useState("");
  const [showProgress, setShowProgress] = useState(true);
  const [toolsCollapsed, setToolsCollapsed] = useState(false);
  const forkMode = useDebugStore((s) => s.config.forkMode);
  const forkPatches = useForkStore((s) => s.patches);
  const [patchStep, setPatchStep] = useState("");
  const [patchStackPos, setPatchStackPos] = useState("");
  const [patchStackVal, setPatchStackVal] = useState("");
  const [patchMemOffset, setPatchMemOffset] = useState("");
  const [patchMemVal, setPatchMemVal] = useState("");

  // 快捷键：j=上一步, n=下一步, 空格=播放/暂停（仅 frame 页生效，DebugToolbar 本身在 frame 页才挂载）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;
      if (disabled) return;
      if (e.key === "j") {
        e.preventDefault();
        onStepBack();
      } else if (e.key === "k") {
        e.preventDefault();
        onStepInto();
      } else if (e.key === " ") {
        e.preventDefault();
        onContinue();
      } else if (e.key === "t") {
        if (!hasCallTree) return;
        e.preventDefault();
        setActiveDrawer(v => v === "calltree" ? null : "calltree");
      } else if (e.key === "l") {
        if (disabled) return;
        e.preventDefault();
        useDebugStore.getState().sync({ isLogDrawerOpen: true });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [disabled, onStepBack, onStepInto, onContinue, hasCallTree]);

  return (
    <>
      <div className="flex items-center gap-0.5 px-1.5 py-1 bg-muted/50 border-b">

      <Button
        variant="ghost"
        size="sm"
        onClick={onStepOver}
        disabled={disabled || isPlaying}
        className="h-6 px-2 gap-1"
        title="Step Over — skip sub-call, stop at next step in current frame"
      >
        <ArrowRightFromLine className="h-3 w-3" />
        <span className="text-[11px]">Step Over</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onStepOut}
        disabled={disabled || isPlaying}
        className="h-6 px-2 gap-1"
        title="Step Out — finish current frame, return to parent frame"
      >
        <ArrowUpFromLine className="h-3 w-3" />
        <span className="text-[11px]">Step Out</span>
      </Button>

      <div className="w-px h-6 bg-border mx-1" />
      <Button
        variant="ghost"
        size="sm"
        onClick={onStepBack}
        disabled={disabled || isPlaying}
        className="h-6 px-2 gap-1"
        title="Step Back"
      >
        <Undo2 className="h-3 w-3" />
        <span className="text-[11px]">Step Back</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onStepInto}
        disabled={disabled || isPlaying}
        className="h-6 px-2 gap-1"
        title="Step Into (F11)"
      >
        <ArrowDownToLine className="h-3 w-3" />
        <span className="text-[11px]">Step Into</span>
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
      <div className="w-px h-6 bg-border mx-1" />

      <Button
        variant={showProgress ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setShowProgress(v => !v)}
        className="h-6 px-2"
        title="Toggle Progress Bar"
      >
        <SlidersHorizontal className="h-3 w-3" />
      </Button>

      <Button
        variant={showPauseOn ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setShowPauseOn(v => !v)}
        className="h-6 px-2"
        title="Toggle PauseOn breakpoints"
      >
        <span className="text-[11px]">PauseOp</span>
      </Button>

      <Button
        variant={showCond ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setShowCond(v => !v)}
        className="h-6 px-2"
        title="Add conditional pause"
      >
        <span className="text-[11px]">PauseCond</span>
      </Button>

      <div className="w-px h-6 bg-border mx-0.5" />

      {forkMode && (
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

      <Button
        variant={activeDrawer === "calltree" ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setActiveDrawer(v => v === "calltree" ? null : "calltree")}
        className="h-6 px-2 text-[11px]"
        title="Call Tree"
        disabled={!hasCallTree}
      >
        Tree
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => useDebugStore.getState().sync({ isLogDrawerOpen: true })}
        className="h-6 px-2 text-[11px]"
        title="All Logs (l)"
        disabled={disabled}
      >
        Logs
      </Button>
      <div className="w-px h-6 bg-border mx-1" />

      <Button
        variant="outline"
        size="sm"
        onClick={() => useDebugStore.getState().sync({ isUtilitiesOpen: true })}
        className="h-6 px-2 text-[11px]"
        title="Utilities (BaseConv, 4Byte, Keccak256)"
      >
        Utils
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => useDebugStore.getState().sync({ isAnalysisOpen: true })}
        className="h-6 px-2 text-[11px]"
        title="Analysis (JS sandbox)"
      >
        Analysis
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

      {/* Break Opcodes 多选 */}
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

      {/* 条件断点内联添加行 */}
      {showCond && (() => {
        // 叶子总数 = 所有根节点的叶子和
        const totalLeaves = pauseConditions.reduce((sum, n) => {
          const count = (node: typeof n): number =>
            node.kind === 'leaf' ? 1 : count(node.left) + count(node.right);
          return sum + count(n);
        }, 0);
        const canAdd = totalLeaves < 3;
        const placeholders: Record<PauseConditionType, string> = {
          sstore_slot:      "slot (0x... 或十进制)",
          sload_slot:       "slot (0x... 或十进制)",
          call_address:     "address (0x...)",
          call_selector:    "selector (0x12345678)",
          log_topic:        "topic0 (0x...)",
          contract_address: "address (0x...)",
          target_address:   "address (0x...)",
        };
        return (
        <div className="flex items-center gap-1.5 px-2 py-1 border-b bg-muted/30 flex-wrap">
          <span className="text-xs text-muted-foreground shrink-0">Cond:</span>
          <Select value={condType} onValueChange={v => setCondType(v as PauseConditionType)}>
            <SelectTrigger className="h-6 text-xs w-36 px-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(PAUSE_CONDITION_LABELS) as [PauseConditionType, string][]).map(([k, v]) => (
                <SelectItem key={k} value={k} className="text-xs">{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={condValue}
            onChange={e => setCondValue(e.target.value)}
            placeholder={placeholders[condType]}
            className="h-6 text-xs font-mono w-[22rem]"
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                const trimmed = condValue.trim();
                if (!trimmed || !canAdd) return;
                const cond: PauseCondition = { id: crypto.randomUUID(), type: condType, value: trimmed, enabled: true };
                const node = { kind: 'leaf' as const, id: cond.id, cond };
                useDebugStore.getState().sync({ condNodes: [...pauseConditions, node] });
                setCondValue("");
              }
            }}
          />
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!canAdd}
            title={canAdd ? undefined : '最多 3 个条件'}
            onClick={() => {
              const trimmed = condValue.trim();
              if (!trimmed || !canAdd) return;
              const cond: PauseCondition = { id: crypto.randomUUID(), type: condType, value: trimmed, enabled: true };
              const node = { kind: 'leaf' as const, id: cond.id, cond };
              useDebugStore.getState().sync({ condNodes: [...pauseConditions, node] });
              setCondValue("");
            }}
          >
            + Add
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => useDebugStore.getState().sync({ isCondListOpen: true })}
            className="h-6 px-2 relative"
            title="View condition list"
          >
            <span className="text-[11px]">CondList</span>
            {pauseConditions.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 text-[9px] bg-primary text-primary-foreground rounded-full flex items-center justify-center leading-none">
                {totalLeaves}
              </span>
            )}
          </Button>
          <Button
            size="sm"
            className="h-6 px-2 text-xs ml-3"
            onClick={() => onRunConditionScan?.()}
            title="Scan conditions"
            disabled={disabled || pauseConditions.length === 0}
          >
            Scan
          </Button>
        </div>
        );
      })()}

      {/* Fork Patch Editor — 可收缩 */}
      {showFork && forkMode && (
        <div className="flex flex-col border-b bg-muted/30">
          <div className="flex items-center gap-1.5 px-2 py-1 flex-wrap">
            <span className="text-xs text-muted-foreground shrink-0">Patch:</span>
            <Input
              className="h-5 text-[11px] w-20"
              placeholder="step"
              value={patchStep}
              onChange={(e) => setPatchStep(e.target.value)}
            />
            <Input
              className="h-5 text-[11px] w-16"
              placeholder="stack pos"
              value={patchStackPos}
              onChange={(e) => setPatchStackPos(e.target.value)}
            />
            <Input
              className="h-5 text-[11px] w-48"
              placeholder="stack value (0x...)"
              value={patchStackVal}
              onChange={(e) => setPatchStackVal(e.target.value)}
            />
            <Input
              className="h-5 text-[11px] w-20"
              placeholder="mem offset"
              value={patchMemOffset}
              onChange={(e) => setPatchMemOffset(e.target.value)}
            />
            <Input
              className="h-5 text-[11px] w-48"
              placeholder="mem data (0x...)"
              value={patchMemVal}
              onChange={(e) => setPatchMemVal(e.target.value)}
            />
            <Button size="sm" className="h-5 px-2 text-[10px]" onClick={() => {
              const stepIdx = parseInt(patchStep, 10);
              if (isNaN(stepIdx) || stepIdx < 1) { toast.error("Invalid step (1-based)"); return; }
              const stackPatches: { pos: number; value: string }[] = [];
              const memoryPatches: { offset: number; value: string }[] = [];
              if (patchStackPos.trim() && patchStackVal.trim()) {
                const pos = parseInt(patchStackPos, 10);
                if (isNaN(pos) || pos < 0) { toast.error("Invalid stack position"); return; }
                stackPatches.push({ pos, value: patchStackVal.trim() });
              }
              if (patchMemOffset.trim() && patchMemVal.trim()) {
                const offset = parseInt(patchMemOffset, 10);
                if (isNaN(offset) || offset < 0) { toast.error("Invalid memory offset"); return; }
                memoryPatches.push({ offset, value: patchMemVal.trim() });
              }
              if (stackPatches.length === 0 && memoryPatches.length === 0) { toast.error("At least one stack or memory patch required"); return; }
              useForkStore.getState().addPatch({
                id: crypto.randomUUID(),
                stepIndex: stepIdx - 1,
                stackPatches,
                memoryPatches,
              });
              setPatchStep(""); setPatchStackPos(""); setPatchStackVal(""); setPatchMemOffset(""); setPatchMemVal("");
            }}>
              + Add
            </Button>
            <Button size="sm" variant="default" className="h-5 px-2 text-[10px] bg-orange-500 hover:bg-orange-600 text-white font-semibold" onClick={() => onStartDebug?.()} title="重跑">
              ↺ 重跑
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
            className="h-6 w-6 flex-shrink-0"
            disabled={!canNavBack}
            onClick={onNavBack}
            title="Navigate Back"
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 flex-shrink-0"
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

    {/* Call Tree Sheet — 从底部弹出，占半屏 */}
    <Sheet open={activeDrawer === "calltree"} onOpenChange={(o) => { if (!o) setActiveDrawer(null); }}>
      <SheetContent side="bottom" className="h-[50vh] flex flex-col p-0 [&>button]:hidden border-t border-border shadow-[0_-4px_12px_rgba(0,0,0,0.18)]" aria-describedby={undefined}>
        <SheetTitle className="sr-only">Call Tree</SheetTitle>
        <div className="flex-1 min-h-0 overflow-hidden">
          <CallTreeViewer
            onSeekTo={onSeekTo}
            onSelectFrame={onSelectFrame}
            onNavigateTo={onNavigateTo}
          />
        </div>
      </SheetContent>
    </Sheet>
    </>
  );
}
