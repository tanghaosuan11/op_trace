import { useState, useMemo, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown, Copy, Check } from "lucide-react";
import type { CallTreeNode } from "@/lib/types";
import fourbyteDb from "@/lib/fourbyteDb.json";
import { getUserFn } from "@/lib/userFourbyteDb";
import { useDebugStore } from "@/store/debugStore";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Inject / update a <style> tag to highlight all [data-addr="..."] elements globally
const STYLE_ID = "calltree-addr-highlight";
function setGlobalAddrHighlight(addr: string | null) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!addr) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = `[data-addr="${addr}"] { background-color: rgb(251 191 36 / 0.52); border-radius: 3px; }`;
}

const ROW_H = 26;
const GUIDE_COL_W = 20; // width per depth level (vertical guide lines)
const ROW_NUM_W = 36;   // row index column width

interface CallTreeViewerProps {
  onSeekTo?: (index: number) => void;
  onSelectFrame?: (frameId: string) => void;
  onNavigateTo?: (stepIndex: number, frameId: string) => void;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fullAddr(addr?: string): string {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return '—';
  return addr;
}

function fullHex(h?: string): string {
  if (!h) return '—';
  const c = h.replace(/^0x/, '');
  return '0x' + (c || '0');
}

function badgeClass(type?: string): string {
  switch (type) {
    case 'delegatecall': return 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/30';
    case 'staticcall':   return 'bg-green-100 text-green-700 border-green-200 dark:bg-green-500/15 dark:text-green-400 dark:border-green-500/30';
    case 'create':
    case 'create2':      return 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-500/15 dark:text-purple-400 dark:border-purple-500/30';
    case 'sstore':       return 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-400 dark:border-rose-500/30';
    case 'sload':        return 'bg-pink-100 text-pink-700 border-pink-200 dark:bg-pink-500/15 dark:text-pink-400 dark:border-pink-500/30';
    case 'tstore':       return 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-500/15 dark:text-fuchsia-400 dark:border-fuchsia-500/30';
    case 'tload':        return 'bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-400 dark:border-cyan-500/30';
    case 'log':          return 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/30';
    default:             return 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/30';
  }
}

function badgeLabel(type?: string, extra?: string | number): string {
  if (type === 'log') return `LOG${extra ?? ''}`;
  return (type ?? 'call').toUpperCase();
}

function OpBadge({ type, depth, extra }: { type?: string; depth: number; extra?: string | number }) {
  return (
    <span className={`inline-flex items-center gap-1 flex-shrink-0 border rounded-sm px-2 py-0.5 leading-none text-[11px] ${badgeClass(type)}`} style={{textDecoration:'none'}}>
      <span className="opacity-60">{depth - 1}</span>
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="opacity-70"><path d="M1 4h6M5 1.5l2.5 2.5L5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      {badgeLabel(type, extra)}
    </span>
  );
}

function CalldataPopover({ input }: { input: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(input);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const hex = input.startsWith('0x') ? input.slice(2) : input;
  const selector = '0x' + hex.slice(0, 8);
  const rest = hex.slice(8);
  const color = { color: 'rgb(80 157 224 / 0.85)', borderColor: 'rgb(80 157 224 / 0.4)' };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
          className="inline-flex items-center font-mono flex-shrink-0 border rounded-sm px-2 py-0.5 leading-none text-[11px] cursor-pointer transition-colors"
          style={color}
        >
          calldata
          <span onClick={handleCopy} className="ml-0.5 opacity-50 hover:opacity-100 transition-opacity">
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          </span>
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="w-auto max-w-[560px] p-2 font-mono text-[11px]"
        onOpenAutoFocus={e => e.preventDefault()}
      >
        <div className="flex flex-col gap-px">
          <div><span style={{color:'rgb(80 157 224)'}}>{selector}</span></div>
          {rest && <div><span className="text-foreground/80 break-all">{rest}</span></div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function getFnLabel(input?: string): string | null {
  if (!input) return null;
  const hex = input.startsWith('0x') ? input.slice(2) : input;
  if (hex.length < 8) return null;
  const selector = '0x' + hex.slice(0, 8).toLowerCase();
  const db = fourbyteDb as Record<string, { fn?: string; ev?: string } | null>;
  return db[selector]?.fn ?? getUserFn(selector) ?? ('0x' + hex.slice(0, 8));
}

// ── node row ──────────────────────────────────────────────────────────────────

interface NodeRowProps {
  node: CallTreeNode;
  rowIndex: number | string;
  isCollapsed: boolean;
  isActive: boolean;
  isActiveEvent: boolean;
  hoveredAddr: string | null;
  onHoverAddr: (addr: string | null) => void;
  onToggle: () => void;
  onSeekTo?: (index: number) => void;
  onSelectFrame?: (frameId: string) => void;
  onNavigateTo?: (stepIndex: number, frameId: string) => void;
  showGas: boolean;
  txGasUsed?: bigint;
}

/** Renders the row-number cell + depth guide columns (vertical bars) */
function RowPrefix({ rowIndex, depth }: { rowIndex: number | string; depth: number }) {
  return (
    <>
      {/* row index */}
      <div
        className="flex-shrink-0 flex items-center justify-end text-muted-foreground/65 border-r border-border/40 pr-1"
        style={{ width: ROW_NUM_W, height: '100%' }}
      >
        {rowIndex}
      </div>
      {/* depth guide columns */}
      {Array.from({ length: depth }, (_, i) => (
        <div
          key={i}
          className="flex-shrink-0 border-r border-border/40"
          style={{ width: GUIDE_COL_W, height: '100%' }}
        />
      ))}
    </>
  );
}

function NodeRow({ node, rowIndex, isCollapsed, isActive, isActiveEvent, hoveredAddr: _hoveredAddr, onHoverAddr, onToggle, onSeekTo, onSelectFrame, onNavigateTo, showGas, txGasUsed }: NodeRowProps) {
  if (node.type === 'frame') {
    const fnLabel = getFnLabel(node.input);
    const isCreateType = node.callType === 'create' || node.callType === 'create2';
    const targetAddr = (node.target ?? node.address)?.toLowerCase() ?? null;
    const gasDisplay = node.depth === 1 && txGasUsed != null
      ? Number(txGasUsed)
      : node.gasUsed;
    return (
      <div
        className={`flex items-center h-full cursor-pointer select-none ${
          isActive ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/40'
        }`}
        onClick={() => {
          if (onNavigateTo) {
            onNavigateTo(node.stepIndex, `frame-${node.contextId}`);
          } else {
            onSelectFrame?.(`frame-${node.contextId}`);
            onSeekTo?.(node.stepIndex);
          }
        }}
      >
        <RowPrefix rowIndex={rowIndex} depth={node.depth} />
        {/* toggle */}
        <span
          className="flex-shrink-0 w-[14px] h-full flex items-center justify-center text-muted-foreground hover:text-foreground border-r border-border/40"
          onClick={e => { e.stopPropagation(); onToggle(); }}
        >
          {isCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </span>
        {/* content */}
        <div className="flex items-center gap-1.5 px-1.5 min-w-0">
          <OpBadge type={node.callType} depth={node.depth} />
          {showGas && gasDisplay != null && (
            <span className="inline-flex items-center font-mono flex-shrink-0 border border-muted-foreground/50 rounded-sm px-2 py-0.5 leading-none text-[11px] text-muted-foreground">
              {gasDisplay.toLocaleString()}
            </span>
          )}
          {targetAddr && targetAddr !== '0x0000000000000000000000000000000000000000' ? (
            <span
              className="inline-flex items-center font-mono font-semibold flex-shrink-0 border rounded-sm px-2 py-0.5 leading-none text-[11px] cursor-default"
              style={{color:'rgb(37 131 224)', borderColor:'rgb(20 90 160 / 0.4)'}}
              data-addr={targetAddr}
              onMouseEnter={() => onHoverAddr(targetAddr)}
              onMouseLeave={() => onHoverAddr(null)}
            >
              {fullAddr(node.target ?? node.address)}
            </span>
          ) : (
            <span className="inline-flex items-center font-mono font-semibold flex-shrink-0 border rounded-sm px-2 py-0.5 leading-none text-[11px]" style={{color:'rgb(20 90 160)', borderColor:'rgb(20 90 160 / 0.4)'}}>
              {fullAddr(node.target ?? node.address)}
            </span>
          )}
          {!isCreateType && fnLabel && (
            <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px]" style={{color:'rgb(255 118 35)', borderColor:'rgb(255 118 35 / 0.3)'}}>
              {fnLabel}
            </span>
          )}
          {!isCreateType && node.input && node.input.replace(/^0x/, '').length >= 8 && (
            <CalldataPopover input={node.input} />
          )}
          {node.selfdestructTarget ? (
            <span className="flex-shrink-0 text-[9px] font-bold text-orange-300 bg-orange-400/10 px-1 rounded ml-0.5">
              💀 SELFDESTRUCT → {node.selfdestructTarget.slice(0, 6)}…{node.selfdestructTarget.slice(-4)}
              {node.selfdestructValue && node.selfdestructValue !== '0' && (
                <span className="ml-1 text-yellow-300">({node.selfdestructValue} wei)</span>
              )}
            </span>
          ) : node.success === true ? (
            <span className="flex-shrink-0 text-[9px] font-bold text-green-400 bg-green-400/10 px-1 rounded ml-0.5">✓</span>
          ) : node.success === false ? (
            <span className="flex-shrink-0 text-[9px] font-bold text-red-400 bg-red-400/10 px-1 rounded ml-0.5">✗ REVERT</span>
          ) : null}
        </div>
      </div>
    );
  }

  if (node.type === 'sstore') {
    return (
      <div
        className={`flex items-center h-full cursor-pointer select-none ${node.reverted ? 'text-orange-400/40' : 'text-orange-500'} ${isActiveEvent ? 'bg-amber-400/10 border-l-2 border-l-amber-400' : 'hover:bg-muted/40'}`}
        onClick={() => onSeekTo?.(node.stepIndex)}
      >
        <RowPrefix rowIndex={rowIndex} depth={node.depth} />
        <span className="flex-shrink-0 w-[14px] h-full border-r border-border/40" />
        <div className={`flex items-center gap-1.5 px-1.5 min-w-0 ${node.reverted ? 'line-through decoration-red-400/60' : ''}`}>
          {node.reverted && <span className="no-underline line-through-none text-red-400/80 flex-shrink-0" style={{textDecoration:'none'}}>✗</span>}
          <OpBadge type="sstore" depth={node.depth} />
          <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px] text-foreground/75">[{fullHex(node.slot)}]</span>
          <span className="text-muted-foreground/70 flex-shrink-0">:</span>
          <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px] text-foreground/75">{fullHex(node.oldValue)}</span>
          <span className="text-muted-foreground/70 flex-shrink-0">→</span>
          <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px] text-foreground/75">{fullHex(node.newValue)}</span>
        </div>
      </div>
    );
  }

  if (node.type === 'tstore') {
    return (
      <div
        className={`flex items-center h-full cursor-pointer select-none ${node.reverted ? 'text-fuchsia-400/40' : 'text-fuchsia-600'} ${isActiveEvent ? 'bg-amber-400/10 border-l-2 border-l-amber-400' : 'hover:bg-muted/40'}`}
        onClick={() => onSeekTo?.(node.stepIndex)}
      >
        <RowPrefix rowIndex={rowIndex} depth={node.depth} />
        <span className="flex-shrink-0 w-[14px] h-full border-r border-border/40" />
        <div className={`flex items-center gap-1.5 px-1.5 min-w-0 ${node.reverted ? 'line-through decoration-red-400/60' : ''}`}>
          {node.reverted && <span className="no-underline line-through-none text-red-400/80 flex-shrink-0" style={{textDecoration:'none'}}>✗</span>}
          <OpBadge type="tstore" depth={node.depth} />
          <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px] text-foreground/75">[{fullHex(node.slot)}]</span>
          <span className="text-muted-foreground/70 flex-shrink-0">:</span>
          <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px] text-foreground/75">{fullHex(node.oldValue)}</span>
          <span className="text-muted-foreground/70 flex-shrink-0">→</span>
          <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px] text-foreground/75">{fullHex(node.newValue)}</span>
        </div>
      </div>
    );
  }

  if (node.type === 'tload') {
    return (
      <div
        className={`flex items-center h-full text-cyan-600 cursor-pointer select-none ${isActiveEvent ? 'bg-amber-400/10 border-l-2 border-l-amber-400' : 'hover:bg-muted/40'}`}
        onClick={() => onSeekTo?.(node.stepIndex)}
      >
        <RowPrefix rowIndex={rowIndex} depth={node.depth} />
        <span className="flex-shrink-0 w-[14px] h-full border-r border-border/40" />
        <div className="flex items-center gap-1.5 px-1.5 min-w-0">
          <OpBadge type="tload" depth={node.depth} />
          <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px] text-foreground/75">{fullHex(node.slot)}</span>
        </div>
      </div>
    );
  }

  if (node.type === 'sload') {
    return (
      <div
        className={`flex items-center h-full text-slate-500 cursor-pointer select-none ${isActiveEvent ? 'bg-amber-400/10 border-l-2 border-l-amber-400' : 'hover:bg-muted/40'}`}
        onClick={() => onSeekTo?.(node.stepIndex)}
      >
        <RowPrefix rowIndex={rowIndex} depth={node.depth} />
        <span className="flex-shrink-0 w-[14px] h-full border-r border-border/40" />
        <div className="flex items-center gap-1.5 px-1.5 min-w-0">
          <OpBadge type="sload" depth={node.depth} />
          <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px] text-foreground/75">[{fullHex(node.slot)}]</span>
          {node.oldValue != null && (
            <>
              <span className="text-muted-foreground/70 flex-shrink-0">:</span>
              <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px] text-foreground/75">{fullHex(node.oldValue)}</span>
            </>
          )}
        </div>
      </div>
    );
  }

  // log
  const topicCount = node.topics?.length ?? 0;
  const topic0 = node.topics?.[0];
  return (
    <div
      className={`flex items-center h-full cursor-pointer select-none ${node.reverted ? 'text-violet-400/40' : 'text-violet-500'} ${isActiveEvent ? 'bg-amber-400/10 border-l-2 border-l-amber-400' : 'hover:bg-muted/40'}`}
      onClick={() => onSeekTo?.(node.stepIndex)}
    >
      <RowPrefix rowIndex={rowIndex} depth={node.depth} />
      <span className="flex-shrink-0 w-[14px] h-full border-r border-border/40" />
      <div className={`flex items-center gap-1.5 px-1.5 min-w-0 ${node.reverted ? 'line-through decoration-red-400/60' : ''}`}>
        {node.reverted && <span className="text-red-400/80 flex-shrink-0" style={{textDecoration:'none'}}>✗</span>}
          <OpBadge type="log" depth={node.depth} extra={topicCount} />
        {topic0 && <span className="inline-flex items-center font-mono flex-shrink-0 border border-foreground/20 rounded-sm px-2 py-0.5 leading-none text-[11px] text-foreground/75">{fullHex(topic0)}</span>}
      </div>
    </div>
  );
}

// ── visible node filter / collapse ────────────────────────────────────────────

function getVisibleNodes(nodes: CallTreeNode[], collapsed: Set<number>): CallTreeNode[] {
  const result: CallTreeNode[] = [];
  let hiddenDepth = Infinity;
  for (const node of nodes) {
    if (node.depth > hiddenDepth) continue;
    hiddenDepth = Infinity;
    result.push(node);
    if (node.type === 'frame' && collapsed.has(node.id)) {
      hiddenDepth = node.depth;
    }
  }
  return result;
}

// ── main component ────────────────────────────────────────────────────────────

export function CallTreeViewer({ onSeekTo, onSelectFrame, onNavigateTo }: CallTreeViewerProps) {
  const nodes = useDebugStore((s) => s.callTreeNodes);
  const activeTab = useDebugStore((s) => s.activeTab);
  const currentStepIndex = useDebugStore((s) => s.currentStepIndex);
  const txGasUsed = useDebugStore((s) => s.txData?.gasUsed);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [showSload, setShowSload] = useState(false);
  const [showSstore, setShowSstore] = useState(true);
  const [showTload, setShowTload] = useState(false);
  const [showTstore, setShowTstore] = useState(true);
  const [showStaticCall, setShowStaticCall] = useState(true);
  const [showGas, setShowGas] = useState(true);
  const [hoveredAddr, setHoveredAddr] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState(300);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollToContextId = useRef<number | null>(null);

  const handleHoverAddr = (addr: string | null) => {
    setHoveredAddr(addr);
    setGlobalAddrHighlight(addr);
  };

  useEffect(() => {
    return () => setGlobalAddrHighlight(null);
  }, []);

  const activeContextId = useMemo(() => {
    const m = activeTab?.match(/^frame-(\d+)$/);
    return m ? parseInt(m[1]) : null;
  }, [activeTab]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      setContainerHeight(entries[0].contentRect.height);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const filtered = useMemo(() => {
    let result = nodes;
    if (!showSload) result = result.filter(n => n.type !== 'sload');
    if (!showSstore) result = result.filter(n => n.type !== 'sstore');
    if (!showTload) result = result.filter(n => n.type !== 'tload');
    if (!showTstore) result = result.filter(n => n.type !== 'tstore');
    if (!showStaticCall) result = result.filter(n => !(n.type === 'frame' && n.callType === 'staticcall'));
    return result;
  }, [nodes, showSload, showSstore, showTload, showTstore, showStaticCall]);

  const visible = useMemo(() => getVisibleNodes(filtered, collapsed), [filtered, collapsed]);

  // In current frame's nodes, find the last non-frame node with stepIndex <= currentStepIndex
  const activeEventNode = useMemo(() => {
    if (currentStepIndex < 0 || activeContextId == null) return null;
    let last: CallTreeNode | null = null;
    for (const n of filtered) {
      if (n.type === 'frame') continue;
      if (n.contextId !== activeContextId) continue;
      if (n.stepIndex > currentStepIndex) break;
      last = n;
    }
    return last;
  }, [filtered, currentStepIndex, activeContextId]);

  // Scroll to active event node when it changes (only if not already visible)
  useEffect(() => {
    if (!activeEventNode) return;
    const idx = visible.findIndex(n => n.id === activeEventNode.id);
    if (idx === -1) return;
    const el = containerRef.current;
    if (!el) return;
    const targetTop = idx * ROW_H;
    const targetBottom = targetTop + ROW_H;
    if (targetTop < el.scrollTop || targetBottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, targetTop - el.clientHeight / 2 + ROW_H / 2);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEventNode]);

  // Expand ancestor frame nodes when active context changes
  useEffect(() => {
    if (activeContextId == null || nodes.length === 0) return;
    const targetNode = nodes.find(n => n.type === 'frame' && n.contextId === activeContextId);
    if (!targetNode) return;
    scrollToContextId.current = activeContextId;
    setCollapsed(prev => {
      const stack: { id: number; depth: number }[] = [];
      for (const n of nodes) {
        if (n.type === 'frame' && n.contextId === activeContextId) break;
        if (n.type === 'frame') {
          while (stack.length > 0 && stack[stack.length - 1].depth >= n.depth) stack.pop();
          stack.push({ id: n.id, depth: n.depth });
        }
      }
      const next = new Set(prev);
      let changed = false;
      for (const { id } of stack) {
        if (next.has(id)) { next.delete(id); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [activeContextId, nodes]);

  // After visible updates (ancestors expanded), scroll to active node
  useEffect(() => {
    const cid = scrollToContextId.current;
    if (cid == null) return;
    const idx = visible.findIndex(n => n.type === 'frame' && n.contextId === cid);
    if (idx === -1) return;
    scrollToContextId.current = null;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, idx * ROW_H - el.clientHeight / 2 + ROW_H / 2);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - 2);
  const endIdx = Math.min(visible.length, startIdx + Math.ceil(containerHeight / ROW_H) + 5);

  const toggleCollapse = (id: number) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        尚未构建 Call Tree
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border rounded-md overflow-hidden bg-background">
      {/* toolbar */}
      <div className="flex items-center gap-3 px-2 py-1 border-b bg-muted/90 flex-shrink-0 text-[11px]">
        <span className="text-muted-foreground font-mono">{visible.length} / {nodes.length} nodes</span>
        {[
          { label: 'SLOAD', checked: showSload, set: setShowSload },
          { label: 'SSTORE', checked: showSstore, set: setShowSstore },
          { label: 'TLOAD', checked: showTload, set: setShowTload },
          { label: 'TSTORE', checked: showTstore, set: setShowTstore },
          { label: 'STATIC', checked: showStaticCall, set: setShowStaticCall },
          { label: 'GAS', checked: showGas, set: setShowGas },
        ].map(({ label, checked, set }) => (
          <label key={label} className="flex items-center gap-1 cursor-pointer select-none text-muted-foreground">
            <input type="checkbox" checked={checked} onChange={e => set(e.target.checked)} className="h-3 w-3 accent-primary" />
            {label}
          </label>
        ))}
        <button
          className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setCollapsed(new Set())}
        >
          全部展开
        </button>
        <button
          className="text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => {
            const frameIds = new Set(nodes.filter(n => n.type === 'frame').map(n => n.id));
            setCollapsed(frameIds);
          }}
        >
          全部折叠
        </button>
      </div>

      {/* virtual list */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto font-mono text-[12px]"
        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: visible.length * ROW_H, position: 'relative' }}>
          {visible.slice(startIdx, endIdx).map((node, i) => (
            <div
              key={node.id}
              style={{
                position: 'absolute',
                top: (startIdx + i) * ROW_H,
                height: ROW_H,
                left: 0,
                right: 0,
              }}
            >
              <NodeRow
                node={node}
                rowIndex={node.id}
                isCollapsed={collapsed.has(node.id)}
                isActive={node.type === 'frame' && node.contextId === activeContextId}
                isActiveEvent={node.id === activeEventNode?.id}
                hoveredAddr={hoveredAddr}
                onHoverAddr={handleHoverAddr}
                onToggle={() => toggleCollapse(node.id)}
                onSeekTo={onSeekTo}
                onSelectFrame={onSelectFrame}
                onNavigateTo={onNavigateTo}
                showGas={showGas}
                txGasUsed={txGasUsed}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
