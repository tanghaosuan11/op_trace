import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { OP_MAP, OPCODE_INFO } from "@/lib/opcodes";
import { BookOpen, Layers, ListFilter, Bookmark } from "lucide-react";
import { useDebugStore } from "@/store/debugStore";
import {
  PanelContextMenu,
  PanelContextMenuTrigger,
  PanelContextMenuContent,
  PanelContextMenuItem,
} from "@/components/ui/panel-context-menu";
// import { addStepMarkFromOpcode } from "@/components/NotesDrawer";

interface OpcodeViewerProps {
  onStackFieldsToggle?: (on: boolean) => void;
  onToggleBreakpoint?: (pc: number) => void;
}

const ROW_HEIGHT = 20;

// opcode 名称 → 字节值（用于 executedOpcodeSet 查询）
const NAME_TO_BYTE = new Map<string, number>(
  Object.entries(OP_MAP).map(([key, info]) => [info.name, Number(key)])
);

// 弹窗中展示的固定过滤选项（与 DebugToolbar BREAK_OPCODE_OPTIONS 对应）
const OPCODE_FILTER_OPTIONS: { label: string; names: string[] }[] = [
  { label: "REVERT",       names: ["REVERT"] },
  { label: "STOP",         names: ["STOP"] },
  { label: "RETURN",       names: ["RETURN"] },
  { label: "CALL",         names: ["CALL"] },
  { label: "STATICCALL",   names: ["STATICCALL"] },
  { label: "DELEGATECALL", names: ["DELEGATECALL"] },
  { label: "CREATE2",      names: ["CREATE2"] },
  { label: "CREATE",       names: ["CREATE"] },
  { label: "LOG",          names: ["LOG0", "LOG1", "LOG2", "LOG3", "LOG4"] },
  { label: "MCOPY",        names: ["MCOPY"] },
  { label: "MLOAD",        names: ["MLOAD"] },
  { label: "MSTORE",       names: ["MSTORE"] },
  { label: "MSTORE8",      names: ["MSTORE8"] },
  { label: "SSTORE",       names: ["SSTORE"] },
  { label: "SLOAD",        names: ["SLOAD"] },
  { label: "TSTORE",       names: ["TSTORE"] },
  { label: "TLOAD",        names: ["TLOAD"] },
  { label: "JUMP",         names: ["JUMP"] },
  { label: "KECCAK256",    names: ["KECCAK256"] },
  { label: "JUMPDEST",     names: ["JUMPDEST"] },
];

export function OpcodeViewer({ onStackFieldsToggle, onToggleBreakpoint }: OpcodeViewerProps) {
  const opcodes = useDebugStore((s) => s.opcodes);
  const currentPc = useDebugStore((s) => s.currentPc);
  const currentGasCost = useDebugStore((s) => s.currentGasCost);
  const stack = useDebugStore((s) => s.stack);
  const breakpointPcs = useDebugStore((s) => s.breakpointPcs);
  const breakpointLabels = useDebugStore((s) => s.breakpointLabels);
  const backwardSliceHighlight = useDebugStore((s) => s.backwardSliceHighlight);
  const [searchPc, setSearchPc] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const [hoveredData, setHoveredData] = useState<{ data: string; x: number; y: number } | null>(null);
  const [infoOpcode, setInfoOpcode] = useState<{ op: number; name: string; pc: number } | null>(null);
  const [showStackFields, setShowStackFields] = useState(false);
  const [hiddenOpcodes, setHiddenOpcodes] = useState<Set<string>>(new Set());
  const [executedOnly, setExecutedOnly] = useState(false);
  const executedOpcodeSet = useDebugStore((s) => s.executedOpcodeSet);
  const parentRef = useRef<HTMLDivElement>(null);

  // 每个过滤选项在当前 bytecode 中的出现次数及是否被执行过
  const opcodeStatsByGroup = useMemo(() => {
    const nameCount = new Map<string, number>();
    for (const op of opcodes) {
      nameCount.set(op.name, (nameCount.get(op.name) ?? 0) + 1);
    }
    return OPCODE_FILTER_OPTIONS.map(group => ({
      ...group,
      count: group.names.reduce((s, n) => s + (nameCount.get(n) ?? 0), 0),
      executed: group.names.some(n => executedOpcodeSet.has(NAME_TO_BYTE.get(n) ?? -1)),
    }));
  }, [opcodes, executedOpcodeSet]);

  // 是否有激活的过滤
  const isFiltering = hiddenOpcodes.size > 0 || executedOnly;

  // 过滤后的 opcodes 列表
  const filteredOpcodes = useMemo(() => {
    if (!isFiltering) return opcodes;
    return opcodes.filter((op) => {
      if (hiddenOpcodes.size > 0) {
        // 过滤模式：只显示属于已勾选分组的 opcode；不在任何分组中的也一并隐藏
        const group = OPCODE_FILTER_OPTIONS.find(g => g.names.includes(op.name));
        if (!group || hiddenOpcodes.has(group.label)) return false;
      }
      if (executedOnly) {
        const byte = NAME_TO_BYTE.get(op.name) ?? -1;
        if (!executedOpcodeSet.has(byte)) return false;
      }
      return true;
    });
  }, [opcodes, hiddenOpcodes, executedOnly, executedOpcodeSet, isFiltering]);

  // 构建 PC 到过滤索引的映射表
  const pcToIndexMap = useMemo(() => {
    const map = new Map<number, number>();
    filteredOpcodes.forEach((op, index) => {
      map.set(op.pc, index);
    });
    return map;
  }, [filteredOpcodes]);

  const toggleOpcode = useCallback((name: string) => {
    setHiddenOpcodes((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const virtualizer = useVirtualizer({
    count: filteredOpcodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // 用于节流滚动
  const scrollTimeoutRef = useRef<number | null>(null);
  const lastScrollIndexRef = useRef<number>(-1);

  // 当 currentPc 变化时自动滚动到对应位置（带节流）
  useEffect(() => {
    if (currentPc !== undefined) {
      const index = pcToIndexMap.get(currentPc);
      if (index !== undefined && index !== lastScrollIndexRef.current) {
        // 清除之前的延迟滚动
        if (scrollTimeoutRef.current !== null) {
          clearTimeout(scrollTimeoutRef.current);
        }
        
        // 延迟 50ms 滚动，避免频繁滚动
        scrollTimeoutRef.current = window.setTimeout(() => {
          virtualizer.scrollToIndex(index, { align: "center", behavior: "auto" });
          lastScrollIndexRef.current = index;
          scrollTimeoutRef.current = null;
        }, 50);
      }
    }
    
    return () => {
      if (scrollTimeoutRef.current !== null) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [currentPc, pcToIndexMap, virtualizer]);

  // 跳转到指定 PC
  const jumpToPc = (pc: number) => {
    const index = pcToIndexMap.get(pc);
    if (index !== undefined) {
      virtualizer.scrollToIndex(index, { align: "center" });
      setHighlightedIndex(index);
      
      // 3 秒后取消高亮
      setTimeout(() => setHighlightedIndex(null), 3000);
    }
  };

  // 处理搜索输入
  const handleSearch = () => {
    // 支持十六进制（0x...）和十进制
    let pc: number;
    if (searchPc.trim().toLowerCase().startsWith("0x")) {
      pc = parseInt(searchPc, 16);
    } else {
      pc = parseInt(searchPc, 10);
    }
    if (!isNaN(pc)) {
      jumpToPc(pc);
    }
  };

  // 跳转到当前PC
  const jumpToCurrentPc = () => {
    if (currentPc >= 0) {
      jumpToPc(currentPc);
    }
  };

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="py-1 px-3 flex-shrink-0 bg-muted/50 border-b">
        <CardTitle className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-1">
            <span>Opcode</span>
            <Popover>
              <PopoverTrigger asChild>
                <ListFilter
                  size={13}
                  aria-label="Filter Opcodes"
                  className="cursor-pointer hover:opacity-70"
                />
              </PopoverTrigger>
              <PopoverContent align="start" className="w-52 p-2">
                {/* 只显示执行过 PC 的 */}
                <label className="flex items-center gap-1.5 cursor-pointer select-none py-1 px-1 rounded hover:bg-muted/50 mb-1 border-b border-border pb-2">
                  <Checkbox
                    checked={executedOnly}
                    onCheckedChange={(v) => setExecutedOnly(!!v)}
                    className="h-3 w-3 shrink-0"
                  />
                  <span className="text-[11px] font-medium">Only executed PCs</span>
                </label>
                {/* All / None / Invert */}
                <div className="flex items-center gap-1 mb-1.5">
                  <span className="text-[10px] text-muted-foreground mr-auto">Show:</span>
                  {([
                    ["All",  () => setHiddenOpcodes(new Set())],
                    ["None", () => setHiddenOpcodes(new Set(OPCODE_FILTER_OPTIONS.map(o => o.label)))],
                    ["Inv",  () => setHiddenOpcodes(prev => {
                      const next = new Set<string>();
                      for (const o of OPCODE_FILTER_OPTIONS) { if (!prev.has(o.label)) next.add(o.label); }
                      return next;
                    })],
                  ] as [string, () => void][]).map(([label, fn]) => (
                    <button key={label} onClick={fn}
                      className="h-5 px-2 text-[10px] rounded border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors font-medium"
                    >{label}</button>
                  ))}
                </div>
                {/* 两列复选框 */}
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 max-h-[240px] overflow-y-auto">
                  {opcodeStatsByGroup.map(({ label, count, executed }) => (
                    <label key={label} className="flex items-center gap-1 cursor-pointer select-none py-0.5 px-1 rounded hover:bg-muted/50">
                      <Checkbox
                        checked={!hiddenOpcodes.has(label)}
                        onCheckedChange={() => toggleOpcode(label)}
                        className="h-3 w-3 shrink-0"
                      />
                      <span className={`text-[10px] font-mono truncate ${hiddenOpcodes.has(label) ? "text-muted-foreground" : "text-foreground"}`}>
                        {label}
                      </span>
                      {count > 0 && (
                        <span className={`text-[9px] ml-auto shrink-0 ${executed ? "text-emerald-400" : "text-muted-foreground"}`}>
                          ×{count}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <Bookmark
              size={13}
              aria-label="Bookmarks"
              className="cursor-pointer hover:opacity-70"
              onClick={() => useDebugStore.getState().sync({ isBookmarksOpen: true })}
            />
          </div>
          <div className="flex items-center gap-1">
            <Input
              type="text"
              placeholder="PC (0x... or dec)"
              value={searchPc}
              onChange={(e) => setSearchPc(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="w-24 h-5 text-[10px]"
            />
            <svg
              xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke={currentPc < 0 ? "#555" : "currentColor"}
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              onClick={currentPc >= 0 ? jumpToCurrentPc : undefined}
              className={currentPc >= 0 ? "cursor-pointer hover:opacity-70" : "opacity-30"}
              aria-label="Jump to current PC"
            >
              <circle cx="12" cy="12" r="10"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <Popover open={!!infoOpcode} onOpenChange={(open) => !open && setInfoOpcode(null)}>
              <PopoverTrigger asChild>
                <BookOpen
                  size={13}
                  aria-label="Opcode Info"
                  className="cursor-pointer hover:opacity-70"
                  onClick={() => {
                    let pcVal: number;
                    if (searchPc !== "") {
                      if (searchPc.trim().toLowerCase().startsWith("0x")) {
                        pcVal = parseInt(searchPc, 16);
                      } else {
                        pcVal = parseInt(searchPc, 10);
                      }
                    } else {
                      pcVal = currentPc;
                    }
                    if (pcVal < 0 || isNaN(pcVal)) return;
                    const target = opcodes.find((o) => o.pc === pcVal);
                    if (!target) return;
                    const entry = Object.entries(OP_MAP).find(([, v]) => v.name === target.name);
                    const opByte = entry ? parseInt(entry[0]) : -1;
                    setInfoOpcode({ op: opByte, name: target.name, pc: target.pc });
                  }}
                />
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" className="w-[730px] max-h-[70vh] overflow-y-auto p-0 shadow-2xl ring-1 ring-border">
                {infoOpcode && (() => {
                  const info = OPCODE_INFO[infoOpcode.op];
                  return (
                    <div className="p-4 space-y-4 text-sm">
                      <div className="flex items-center gap-2 font-semibold text-sm">
                        <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block"></span>
                        {infoOpcode.name}
                      </div>
                      {info ? (
                        <div className="space-y-4">
                          <p className="text-muted-foreground text-xs">{info.description}</p>
                          <div className="border rounded-lg overflow-hidden">
                            <div className="px-3 py-2 text-xs font-semibold bg-muted/50 border-b">
                              Stack Operations
                            </div>
                            {info.stackInput.length > 0 && (
                              <div className="px-3 pt-2 pb-1">
                                <div className="text-xs text-red-500 font-medium mb-1">Input (consumed before execution):</div>
                                <div className="space-y-1">
                                  {(() => {
                                    let ri = 0;
                                    const total = info.stackInputSize ?? info.stackInput.length;
                                    return info.stackInput.map((name, i) => {
                                      if (name === "...") {
                                        const after = info.stackInput.slice(i + 1).filter(x => x !== "...").length;
                                        ri = total - after;
                                        return (
                                          <div key={i} className="flex items-center px-3 py-0.5 font-mono text-xs text-muted-foreground select-none">
                                            <span className="w-14 shrink-0" />
                                            <span>···</span>
                                          </div>
                                        );
                                      }
                                      const idx = ri++;
                                      const val = stack[stack.length - 1 - idx];
                                      return (
                                        <div key={i} className="flex items-center gap-2 bg-red-50 dark:bg-red-950/30 border border-red-100 dark:border-red-900/40 rounded px-3 py-1.5 font-mono text-xs min-w-0">
                                          <span className="text-muted-foreground w-14 shrink-0">stack[{idx}]</span>
                                          <span className="text-red-500 w-20 shrink-0">{name}</span>
                                          <span className="text-foreground truncate min-w-0 flex-1">{val ?? "—"}</span>
                                        </div>
                                      );
                                    });
                                  })()}
                                </div>
                              </div>
                            )}
                            {info.stackOutput.length > 0 && (
                              <div className="px-3 pt-2 pb-2">
                                <div className="text-xs text-green-600 font-medium mb-1">Output (pushed after execution):</div>
                                <div className="space-y-1">
                                  {(() => {
                                    let ri = 0;
                                    const total = info.stackOutputSize ?? info.stackOutput.length;
                                    return info.stackOutput.map((expr, i) => {
                                      if (expr === "...") {
                                        const after = info.stackOutput.slice(i + 1).filter(x => x !== "...").length;
                                        ri = total - after;
                                        return (
                                          <div key={i} className="flex items-center px-3 py-0.5 font-mono text-xs text-muted-foreground select-none">
                                            <span className="w-14 shrink-0" />
                                            <span>···</span>
                                          </div>
                                        );
                                      }
                                      const idx = ri++;
                                      return (
                                        <div key={i} className="flex items-center gap-3 bg-green-50 dark:bg-green-950/30 border border-green-100 dark:border-green-900/40 rounded px-3 py-1.5 font-mono text-xs">
                                          <span className="text-muted-foreground w-14 shrink-0">stack[{idx}]</span>
                                          <span className="text-green-600">{expr}</span>
                                        </div>
                                      );
                                    });
                                  })()}
                                </div>
                              </div>
                            )}
                            {info.stackInput.length === 0 && info.stackOutput.length === 0 && (
                              <div className="px-3 py-2 text-xs text-muted-foreground">No stack effect</div>
                            )}
                          </div>
                          {(info.memoryEffect || info.storageEffect) && (
                            <div className="border rounded-lg overflow-hidden">
                              <div className="px-3 py-2 text-xs font-semibold bg-muted/50 border-b">Side Effects</div>
                              <div className="px-3 py-2 space-y-1">
                                {info.memoryEffect && (
                                  <div className="font-mono text-xs">
                                    <span className="text-muted-foreground mr-2">Memory:</span>{info.memoryEffect}
                                  </div>
                                )}
                                {info.storageEffect && (
                                  <div className="font-mono text-xs">
                                    <span className="text-muted-foreground mr-2">Storage:</span>{info.storageEffect}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">No info available for this opcode.</p>
                      )}
                    </div>
                  );
                })()}
              </PopoverContent>
            </Popover>
            <Layers
              size={13}
              aria-label={showStackFields ? "Hide Stack Fields" : "Show Stack Fields"}
              className={`cursor-pointer hover:opacity-70 ${showStackFields ? "text-blue-400" : ""}`}
              onClick={() => {
                const next = !showStackFields;
                setShowStackFields(next);
                onStackFieldsToggle?.(next);
              }}
            />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex-1 min-h-0">
        {opcodes.length > 0 ? (
          <div
            ref={parentRef}
            className="h-full overflow-auto border-t"
          >
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const opcode = filteredOpcodes[virtualRow.index];
                const isCurrentPc = opcode.pc === currentPc;
                const isHighlighted = virtualRow.index === highlightedIndex;
                const isBackwardSliceHit = backwardSliceHighlight.has(opcode.pc);

                return (
                  <PanelContextMenu key={virtualRow.key}>
                    <PanelContextMenuTrigger asChild>
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    className={`flex items-center px-3 border-b transition-colors ${
                      isCurrentPc
                        ? "bg-blue-200 dark:bg-blue-900"
                        : isHighlighted
                        ? "bg-yellow-200 dark:bg-yellow-800"
                        : isBackwardSliceHit
                        ? "bg-purple-200 dark:bg-purple-900"
                        : virtualRow.index % 2 === 0
                        ? "bg-muted/30"
                        : ""
                    } hover:bg-muted/50 cursor-pointer`}
                    onClick={() => onToggleBreakpoint?.(opcode.pc)}
                  >
                    {/* 断点红点 */}
                    <span className="w-3 flex-shrink-0 flex items-center justify-center mr-0.5">
                      {breakpointPcs.has(opcode.pc) ? (
                        <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />
                      ) : null}
                    </span>
                    {isCurrentPc && (
                      <span className="mr-1 text-blue-600 dark:text-blue-400">▶</span>
                    )}
                    <div className="w-16 font-mono text-[11px] text-muted-foreground flex-shrink-0">
                      0x{opcode.pc.toString(16).padStart(4, '0')}
                    </div>
                    <div className="w-24 font-mono text-[11px] font-medium flex-shrink-0">
                      {opcode.name}
                    </div>
                    <div 
                      className="flex-1 font-mono text-[11px] text-muted-foreground truncate relative"
                      onMouseEnter={(e) => {
                        if (opcode.data) {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setHoveredData({
                            data: opcode.data,
                            x: rect.left,
                            y: rect.bottom + 5
                          });
                        }
                      }}
                      onMouseLeave={() => setHoveredData(null)}
                    >
                      {opcode.data || ''}
                    </div>
                    <div className="w-16 font-mono text-[11px] flex-shrink-0 text-right truncate">
                      {isCurrentPc && currentGasCost > 0 ? (
                        <span className="text-amber-500">{currentGasCost}</span>
                      ) : breakpointLabels.get(opcode.pc) ? (
                        <span className="text-violet-400" title={breakpointLabels.get(opcode.pc)}>
                          {breakpointLabels.get(opcode.pc)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                    </PanelContextMenuTrigger>
                    <PanelContextMenuContent>
                      <PanelContextMenuItem onSelect={() => useDebugStore.getState().clearBackwardSliceHighlight()}>
                        Clear Data Flow Highlight
                      </PanelContextMenuItem>
                      {/* Notes: hidden until feature is complete
                      <PanelContextMenuItem
                        onSelect={() => {
                          const stepIndex = useDebugStore.getState().currentStepIndex;
                          const opcodeNum = Object.entries(OP_MAP).find(([, v]) => v.name === opcode.name)?.[0];
                          addStepMarkFromOpcode(stepIndex, opcodeNum ? parseInt(opcodeNum) : 0);
                        }}
                      >
                        Mark This Step
                      </PanelContextMenuItem>
                      */}
                    </PanelContextMenuContent>
                  </PanelContextMenu>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm border-t">
            No opcode data
          </div>
        )}
        
        {/* 悬浮提示框 */}
        {hoveredData && (
          <div
            className="fixed z-50 px-3 py-2 bg-popover text-popover-foreground border rounded-md shadow-lg max-w-md break-all font-mono text-xs"
            style={{
              left: `${hoveredData.x}px`,
              top: `${hoveredData.y}px`,
            }}
          >
            {hoveredData.data}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
