import { useState, useMemo, useEffect } from "react";
import { OpcodeViewer } from "./OpcodeViewer";
import { StackViewer } from "./StackViewer";
import { MemoryViewer } from "./MemoryViewer";
import { StorageViewer } from "./StorageViewer";
// import { CallTreeViewer } from "./CallTreeViewer"; // 已隐藏
import { LogViewer } from "./LogViewer";
import { SourceViewer } from "./SourceViewer";
import { ReturnDataViewer } from "./ReturnDataViewer";
// import { StateDiffViewer } from "./StateDiffViewer";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { usePanelRef, Separator } from "react-resizable-panels";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OP_MAP, OPCODE_INFO, type MemoryAccessParam } from "@/lib/opcodes";
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, ChevronsRight, Search, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { InstructionResult } from "@/lib/types";
import { getFnLocal, lookupSignature4Byte, decodeCalldataEntry, DecodedCalldataArg } from "@/lib/fourbyteUtils";

const EXIT_CODE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(InstructionResult)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => [v as number, k])
);

import { useDebugStore } from "@/store/debugStore";

interface CallFrame {
  contextId: number;
  depth: number;
  callType?: "call" | "staticcall" | "delegatecall" | "create" | "create2";
  address?: string;
  caller?: string;
  target?: string;
  contract?: string;
  gasLimit?: number;
  gasUsed?: number;
  value?: string;
  input?: string;
  parentId?: number;
  startStep?: number;
  endStep?: number;
  exitCode?: number;
  success?: boolean;
  exitOutput?: string;
}

interface DebugPanelProps {
  callFrames: CallFrame[];
  activeFrameId: string;
  onSelectFrame: (frameId: string) => void;
  onToggleBreakpoint?: (pc: number) => void;
  scanUrl?: string;
  onSeekTo?: (index: number) => void;
  onBack?: () => void;
  canGoBack?: boolean;
}

export function DebugPanel({
  callFrames,
  activeFrameId,
  onSelectFrame,
  onToggleBreakpoint,
  scanUrl,
  onSeekTo,
  onBack,
  canGoBack = false,
}: DebugPanelProps) {
  // 从 store 读取调试数据
  const opcodes = useDebugStore((s) => s.opcodes);
  const stack = useDebugStore((s) => s.stack);
  const currentPc = useDebugStore((s) => s.currentPc);

  const [showStackFields, setShowStackFields] = useState(false);
  const [memoryHighlight, setMemoryHighlight] = useState<{ start: number; end: number } | null>(null);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const rightPanelRef = usePanelRef();
  const [calldataView, setCalldataView] = useState<"parse" | "origin">("parse");
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [onlineFn, setOnlineFn] = useState<string | null>(null);

  // 从 activeFrameId 找到当前 frame 取 frame info
  const currentFrameMeta = callFrames.find(f => `frame-${f.contextId}` === activeFrameId);

  // 步进时清除手动点击的内存高亮
  useEffect(() => {
    setMemoryHighlight(null);
  }, [currentPc]);

  // input 变化时清除 online 查询结果
  useEffect(() => {
    setOnlineFn(null);
  }, [currentFrameMeta?.input]);

  async function handleOnlineLookup() {
    const raw = currentFrameMeta?.input ?? '';
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
    if (!hex || hex.length < 8) return;
    const selector = '0x' + hex.slice(0, 8);
    setIsLookingUp(true);
    try {
      const { fn } = await lookupSignature4Byte(selector);
      if (fn) {
        setOnlineFn(fn);
      } else {
        toast.error('No matching function signature found');
      }
    } catch {
      toast.error('Lookup failed');
    } finally {
      setIsLookingUp(false);
    }
  }

  // 解析当前 frame 的 calldata
  const calldataParsed = useMemo(() => {
    const raw = currentFrameMeta?.input ?? '';
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
    if (!hex || hex.length < 8) return null;
    const selector = '0x' + hex.slice(0, 8);
    const fn = getFnLocal(selector) ?? onlineFn;
    if (!fn) return null;
    const calldataHex = (raw.startsWith('0x') ? raw : '0x' + raw);
    const decoded: DecodedCalldataArg[] | null = decodeCalldataEntry(fn, calldataHex);
    // fallback：raw 32字节词（decode 失败时显示）
    const dataHex = hex.slice(8);
    const words: string[] = [];
    for (let i = 0; i < dataHex.length; i += 64) {
      words.push(dataHex.slice(i, i + 64).padEnd(64, '0'));
    }
    return { fn, decoded, words };
  }, [currentFrameMeta?.input, onlineFn]);

  // 根据当前 opcode 计算栈参数名列表，将 "..." 展开为正确位置的空字符串
  const stackLabels = useMemo(() => {
    if (!showStackFields || currentPc < 0) return [];
    const opcode = opcodes.find((o) => o.pc === currentPc);
    if (!opcode) return [];
    const entry = Object.entries(OP_MAP).find(([, v]) => v.name === opcode.name);
    if (!entry) return [];
    const opByte = parseInt(entry[0]);
    const info = OPCODE_INFO[opByte];
    if (!info) return [];
    const rawInput = info.stackInput;
    const total = info.stackInputSize ?? rawInput.length;
    const result: string[] = new Array(total).fill("");
    let ri = 0;
    for (let i = 0; i < rawInput.length; i++) {
      const item = rawInput[i];
      if (item === "...") {
        const after = rawInput.slice(i + 1).filter(x => x !== "...").length;
        ri = total - after;
      } else {
        result[ri++] = item;
      }
    }
    return result;
  }, [showStackFields, currentPc, opcodes]);

  // 计算每个栈 item 对应的内存导航信息
  const stackMemoryAccess = useMemo<(MemoryAccessParam & { resolvedOffset: number; resolvedEnd: number } | null)[]>(() => {
    if (!showStackFields || currentPc < 0) return [];
    const opcode = opcodes.find((o) => o.pc === currentPc);
    if (!opcode) return [];
    const entry = Object.entries(OP_MAP).find(([, v]) => v.name === opcode.name);
    if (!entry) return [];
    const opByte = parseInt(entry[0]);
    const info = OPCODE_INFO[opByte];
    if (!info?.memoryAccess) return [];

    return info.stackInput.map((paramName, i) => {
      const access = info.memoryAccess!.find((a) => a.offsetParam === paramName);
      if (!access) return null;
      // stack 是正序（底部为 0），展示时是倒序，所以 i=0 对应 stack[stack.length-1]
      const offsetHex = stack[stack.length - 1 - i];
      if (!offsetHex) return null;
      const offset = parseInt(offsetHex, 16);
      if (isNaN(offset)) return null;

      let size: number;
      if (access.sizeParam) {
        const sizeIdx = info.stackInput.indexOf(access.sizeParam);
        const sizeHex = stack[stack.length - 1 - sizeIdx];
        size = sizeHex ? parseInt(sizeHex, 16) : 0;
      } else {
        size = access.fixedSize ?? 32;
      }

      return { ...access, resolvedOffset: offset, resolvedEnd: size > 0 ? offset + size - 1 : offset };
    });
  }, [showStackFields, currentPc, opcodes, stack]);

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      {/* 左侧: Opcode Viewer */}
      <ResizablePanel defaultSize={20} minSize={10} className="flex flex-col min-h-0">
        {/* Call Tree - 已隐藏 */}
        {/* <div className="flex-[0.3] min-h-0 overflow-hidden">
          <CallTreeViewer 
            frames={callFrames} 
            activeFrameId={activeFrameId}
            onSelectFrame={onSelectFrame}
          />
        </div> */}
        <div className="h-full min-h-0 overflow-hidden">
          <OpcodeViewer onStackFieldsToggle={setShowStackFields} onToggleBreakpoint={onToggleBreakpoint} />
        </div>
      </ResizablePanel>

      <ResizableHandle />

      {/* 中间: 核心状态 */}
      <ResizablePanel defaultSize={50} minSize={20} className="overflow-hidden">
        <ResizablePanelGroup orientation="vertical" className="h-full">
          {/* Stack */}
          <ResizablePanel defaultSize={27} minSize={10} className="overflow-hidden">
            <div className="h-full">
              <StackViewer stackLabels={stackLabels} stackMemoryAccess={stackMemoryAccess} onMemoryHighlight={setMemoryHighlight} onSeekTo={onSeekTo} />
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Memory */}
          <ResizablePanel defaultSize={30} minSize={10} className="overflow-hidden">
            <div className="h-full">
              <MemoryViewer highlightRanges={memoryHighlight ? [{ start: memoryHighlight.start, end: memoryHighlight.end, className: "bg-orange-400/50 rounded-sm" }] : []} />
            </div>
          </ResizablePanel>

          <ResizableHandle />

          {/* Storage */}
          <ResizablePanel defaultSize={43} minSize={10} className="overflow-hidden">
            <div className="h-full">
              <StorageViewer />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>

      {/* 中-右分隔线，内嵌折叠/展开按钮 */}
      <Separator
          className="relative w-2 shrink-0 cursor-col-resize transition-colors hover:bg-border/40 flex items-start justify-center"
      >
        <button
          onClick={() => rightCollapsed ? rightPanelRef.current?.expand() : rightPanelRef.current?.collapse()}
          className="mt-1 z-10 h-5 w-4 flex items-center justify-center rounded bg-background border border-border text-muted-foreground hover:text-foreground transition-colors shadow-sm"
          title={rightCollapsed ? "展开面板" : "折叠面板"}
        >
          {rightCollapsed ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
      </Separator>

      {/* 右侧: Tabs，支持折叠 */}
      <ResizablePanel
        defaultSize={30}
        minSize={0}
        collapsible
        collapsedSize={2}
        panelRef={rightPanelRef}
        onResize={(size) => setRightCollapsed(size.asPercentage <= 2)}
        className="flex flex-col min-h-0 overflow-hidden"
      >
        <Tabs defaultValue="frame" className="flex flex-col min-h-0 h-full">
          <div className="flex items-center flex-shrink-0 gap-1 mb-1">
            <TabsList className="h-7 flex-1 justify-center bg-transparent p-0 gap-0.5">
              <TabsTrigger value="frame" className="text-xs px-2 py-0.5">Frame</TabsTrigger>
              <TabsTrigger value="events" className="text-xs px-2 py-0.5">Events</TabsTrigger>
              <TabsTrigger value="source" className="text-xs px-2 py-0.5">Source</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="events" className="flex-1 min-h-0 overflow-hidden">
            <div className="h-full overflow-hidden"><LogViewer /></div>
          </TabsContent>

          <TabsContent value="source" className="flex-1 min-h-0 overflow-hidden">
            <div className="h-full min-h-0 overflow-hidden"><SourceViewer /></div>
          </TabsContent>

          <TabsContent value="frame" className="flex-1 min-h-0 overflow-hidden">
            <ResizablePanelGroup orientation="vertical" className="h-full">
            <ResizablePanel defaultSize={33} minSize={10} className="overflow-hidden">
              <Card className="h-full flex flex-col">
                <CardHeader className="py-1 px-3 flex-shrink-0 bg-muted/50 border-b">
                  <div className="flex items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5">
                      <CardTitle className="text-xs">Frame Info</CardTitle>
                      {currentFrameMeta?.callType && (() => {
                        const ct = currentFrameMeta.callType;
                        const cfg: Record<string, { label: string; cls: string }> = {
                          call:         { label: "CALL",         cls: "text-blue-400 bg-blue-400/10" },
                          staticcall:   { label: "STATICCALL",   cls: "text-green-500 bg-green-500/10" },
                          delegatecall: { label: "DELEGATECALL", cls: "text-amber-500 bg-amber-500/10" },
                          create:       { label: "CREATE",       cls: "text-purple-400 bg-purple-400/10" },
                          create2:      { label: "CREATE2",      cls: "text-purple-400 bg-purple-400/10" },
                        };
                        const c = cfg[ct];
                        return c ? (
                          <span className={`text-[9px] font-mono px-1 leading-4 rounded ${c.cls}`}>{c.label}</span>
                        ) : null;
                      })()}
                    </div>
                    <button
                      onClick={onBack}
                      disabled={!canGoBack}
                      className="h-4 w-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Back to previous frame"
                    >
                      <ArrowLeft className="h-3 w-3" />
                    </button>
                  </div>
                </CardHeader>
                <CardContent className="p-2 flex-1 min-h-0 overflow-auto scrollbar-hidden">
                  {/* 面包屑：contextId !== 1 时显示调用链 */}
                  {currentFrameMeta && currentFrameMeta.contextId !== 1 && (() => {
                    const chain: CallFrame[] = [];
                    let cur: CallFrame | undefined = currentFrameMeta;
                    while (cur) {
                      chain.unshift(cur);
                      cur = cur.parentId != null
                        ? callFrames.find(f => f.contextId === cur!.parentId)
                        : undefined;
                    }
                    return (
                      <div className="flex items-center flex-wrap gap-x-0.5 text-[10px] font-mono mb-1.5 leading-4">
                        {chain.map((f, i) => {
                          const isCurrent = f.contextId === currentFrameMeta.contextId;
                          const label = f.contextId === 1 ? 'Frame#1' : `Frame#${f.contextId}`;
                          return (
                            <span key={f.contextId} className="flex items-center gap-0.5">
                              {i > 0 && <span className="text-muted-foreground/50">›</span>}
                              {isCurrent
                                ? <span className="">{label}</span>
                                : <span className="text-blue-400 hover:text-blue-300 cursor-pointer transition-colors" onClick={() => onSelectFrame(`frame-${f.contextId}`)}>{label}</span>
                              }
                            </span>
                          );
                        })}
                      </div>
                    );
                  })()}
                  {(() => {
                    const scanBase = scanUrl?.replace(/\/$/, "");
                    const ScanLink = ({ addr }: { addr?: string }) => (
                      addr && scanBase
                        ? <a href={`${scanBase}/address/${addr}`} target="_blank" rel="noreferrer" className="inline-flex items-center ml-1 text-muted-foreground hover:text-foreground transition-colors" title={`在 Explorer 中查看 ${addr}`}><ExternalLink className="w-2.5 h-2.5" /></a>
                        : null
                    );
                    return (
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-px text-[11px] leading-4 font-mono">
                    <span className="text-muted-foreground">Contract</span>
                    <span className="truncate text-foreground flex items-center gap-0.5">{currentFrameMeta?.contract ?? '—'}<ScanLink addr={currentFrameMeta?.contract} /></span>
                    <span className="text-muted-foreground">Caller</span>
                    <span className="truncate text-foreground flex items-center gap-0.5">{currentFrameMeta?.caller ?? '—'}<ScanLink addr={currentFrameMeta?.caller} /></span>
                    <span className="text-muted-foreground">Target</span>
                    <span className="truncate text-foreground flex items-center gap-0.5">{currentFrameMeta?.target ?? '—'}<ScanLink addr={currentFrameMeta?.target} /></span>
                    <span className="text-muted-foreground">Value</span>
                    <span className="truncate text-foreground">{currentFrameMeta?.value ?? '—'}</span>
                    <span className="text-muted-foreground">Gas Limit</span>
                    <span className="truncate text-foreground">{currentFrameMeta?.gasLimit ?? '—'}</span>
                    <span className="text-muted-foreground">Gas Used</span>
                    <span className="truncate text-amber-500">{currentFrameMeta?.gasUsed ?? '—'}</span>
                    {currentFrameMeta?.success != null && (
                      <>
                        <span className="text-muted-foreground">Status</span>
                        <span className={currentFrameMeta.success ? 'text-green-400' : 'text-red-400'}>
                          {currentFrameMeta.success ? 'Success' : 'Reverted'}
                        </span>
                        <span className="text-muted-foreground">Exit Code</span>
                        <span className="truncate text-foreground font-mono">
                          {`0x${currentFrameMeta.exitCode!.toString(16).toUpperCase()} (${EXIT_CODE_NAMES[currentFrameMeta.exitCode!] ?? currentFrameMeta.exitCode})`}
                        </span>
                        {!currentFrameMeta.success && (
                          <>
                            <span className="text-muted-foreground">Output</span>
                            <span className="truncate text-red-400 font-mono" title={currentFrameMeta.exitOutput ?? ''}>
                              {(() => {
                                const hex = currentFrameMeta.exitOutput ?? '0x';
                                if (hex === '0x' || hex === '') return '(no output)';
                                // Error(string) selector = 0x08c379a0
                                if (hex.startsWith('0x08c379a0') && hex.length >= 138) {
                                  try {
                                    const offset = parseInt(hex.slice(10, 74), 16);
                                    const len = parseInt(hex.slice(10 + offset * 2, 10 + offset * 2 + 64), 16);
                                    const strHex = hex.slice(10 + offset * 2 + 64, 10 + offset * 2 + 64 + len * 2);
                                    const bytes = new Uint8Array(strHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
                                    return new TextDecoder().decode(bytes);
                                  } catch { /* fall through */ }
                                }
                                // Panic(uint256) selector = 0x4e487b71
                                if (hex.startsWith('0x4e487b71') && hex.length >= 74) {
                                  const code = parseInt(hex.slice(10, 74), 16);
                                  return `Panic(0x${code.toString(16).padStart(2, '0')})`;
                                }
                                return hex.length > 66 ? hex.slice(0, 66) + '…' : hex;
                              })()}
                            </span>
                          </>
                        )}
                      </>
                    )}
                    <span className="text-muted-foreground">Steps</span>
                    <span className="text-foreground flex items-center gap-1">
                      {currentFrameMeta?.startStep != null ? <>{currentFrameMeta.startStep + 1}<ChevronsRight className="w-2.5 h-2.5 text-muted-foreground hover:text-foreground cursor-pointer transition-colors" onClick={() => onSeekTo?.(currentFrameMeta.startStep!)} /></> : '—'}
                      <span className="text-muted-foreground">–</span>
                      {currentFrameMeta?.endStep != null ? <>{currentFrameMeta.endStep + 1}<ChevronsRight className="w-2.5 h-2.5 text-muted-foreground hover:text-foreground cursor-pointer transition-colors" onClick={() => onSeekTo?.(currentFrameMeta.endStep!)} /></> : '—'}
                    </span>
                  </div>
                    );
                  })()}
                </CardContent>
              </Card>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={33} minSize={10} className="overflow-hidden">
              <div className="h-full"><ReturnDataViewer /></div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={34} minSize={10} className="overflow-hidden">
              <Card className="h-full flex flex-col">
                <CardHeader className="py-1 px-3 flex-shrink-0 bg-muted/50 border-b">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-xs">Calldata</CardTitle>
                    <div className="flex items-center gap-0.5">
                      {(() => { const raw = currentFrameMeta?.input ?? ''; const hex = raw.startsWith('0x') ? raw.slice(2) : raw; return hex.length >= 8; })() && (
                        <button
                          className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          onClick={handleOnlineLookup}
                          disabled={isLookingUp || !!calldataParsed}
                          title="Lookup online"
                        >
                          {isLookingUp ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                        </button>
                      )}
                      <button
                        className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => setCalldataView(v => v === "parse" ? "origin" : "parse")}
                        disabled={!calldataParsed}
                        title={calldataView === "parse" ? "Show raw" : "Show parsed"}
                      >
                        <RefreshCw className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="p-2 flex-1 min-h-0 overflow-auto scrollbar-hidden">
                  {(() => {
                    const raw = currentFrameMeta?.input ?? '';
                    if (!raw) return <span className="text-[11px] font-mono text-muted-foreground">—</span>;

                    if (calldataView === "origin" || !calldataParsed) {
                      return <span className="text-[11px] font-mono break-all text-foreground">{raw}</span>;
                    }

                    return (
                      <div className="text-[11px] font-mono">
                        <div className="text-foreground font-semibold break-all">{calldataParsed.fn}</div>
                        <div className="mt-0.5">
                          {calldataParsed.decoded
                            ? calldataParsed.decoded.length === 0
                              ? <span className="text-muted-foreground">no args</span>
                              : calldataParsed.decoded.map((arg, i) => (
                                <div key={i} className="leading-tight break-all">
                                  <span className="text-muted-foreground">{arg.type}:</span>{' '}
                                  <span className="text-foreground">{arg.value}</span>
                                </div>
                              ))
                            : calldataParsed.words.length === 0
                              ? <span className="text-muted-foreground">no args</span>
                              : calldataParsed.words.map((word, i) => (
                                <div key={i} className="text-foreground leading-tight">0x{word}</div>
                              ))
                          }
                        </div>
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>
            </ResizablePanel>
            </ResizablePanelGroup>
          </TabsContent>
        </Tabs>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
