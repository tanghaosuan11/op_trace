import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useDebugStore } from "@/store/debugStore";
import { getEvLocal, lookupSignature4Byte, decodeLogEntry } from "@/lib/fourbyteUtils";
import { toast } from "sonner";
import { Search, Loader2, ExternalLink } from "lucide-react";

interface GlobalLogEntry {
  address: string;
  topics: string[];
  data: string;
  stepIndex: number;
  contextId: number;
  frameAddress: string;
}

interface Props {
  onSeekTo?: (index: number) => void;
}

async function openScanAddress(scanUrl: string, address: string) {
  try {
    const base = scanUrl.replace(/\/$/, '');
    const url = `${base}/address/${address}`;
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    // fallback: window.open (web mode)
    window.open(`${scanUrl.replace(/\/$/, '')}/address/${address}`, '_blank', 'noopener');
  }
}

// Colour stripe per log index (cycles through 5 colours like Etherscan)
const STRIPE_COLORS = [
  'bg-blue-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
];

export function GlobalLogDrawer({ onSeekTo }: Props) {
  const isOpen = useDebugStore((s) => s.isLogDrawerOpen);
  const callFrames = useDebugStore((s) => s.callFrames);
  const scanUrl = useDebugStore((s) => s.config.scanUrl);

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const scrollElRef = useRef<HTMLDivElement | null>(null);
  const parentRef = useCallback((el: HTMLDivElement | null) => {
    scrollElRef.current = el;
    setScrollEl(el);
  }, []);
  const [resolvedEvents, setResolvedEvents] = useState<Record<string, string>>({});
  const [lookingUp, setLookingUp] = useState<string | null>(null);
  const attemptedRef = useRef<Set<string>>(new Set());

  const allLogs = useMemo<GlobalLogEntry[]>(() =>
    callFrames
      .flatMap(f => f.logs.map(l => ({
        ...l,
        contextId: f.contextId,
        frameAddress: f.address ?? '',
      })))
      .sort((a, b) => a.stepIndex - b.stepIndex),
    [callFrames]
  );

  useEffect(() => {
    if (!isOpen || allLogs.length === 0) return;
    const seen = new Set<string>();
    for (const log of allLogs) {
      const t0 = log.topics[0];
      if (t0 && !seen.has(t0) && !resolvedEvents[t0] && !getEvLocal(t0) && !attemptedRef.current.has(t0)) {
        seen.add(t0);
        attemptedRef.current.add(t0);
        lookupSignature4Byte(t0)
          .then(({ ev }) => { if (ev) setResolvedEvents(prev => ({ ...prev, [t0]: ev })); })
          .catch(() => {});
      }
    }
  }, [isOpen, allLogs]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleEventLookup(topic0: string) {
    if (lookingUp) return;
    setLookingUp(topic0);
    try {
      const { ev } = await lookupSignature4Byte(topic0);
      if (ev) setResolvedEvents(prev => ({ ...prev, [topic0]: ev }));
      else toast.error('No matching event signature found');
    } catch {
      toast.error('Lookup failed');
    } finally {
      setLookingUp(null);
    }
  }

  // 等容器布局稳定后再交给 virtualizer 渲染，避免 Sheet 动画期间定位错乱
  const [virtualizerReady, setVirtualizerReady] = useState(false);
  useEffect(() => {
    if (!isOpen) { setVirtualizerReady(false); return; }
    // double-rAF: 等 CSS 动画完成首帧、容器尺寸真正稳定
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => { setVirtualizerReady(true); });
      return () => cancelAnimationFrame(id2);
    });
    return () => cancelAnimationFrame(id1);
  }, [isOpen]);

  const virtualizer = useVirtualizer({
    count: virtualizerReady ? allLogs.length : 0,
    getScrollElement: () => scrollElRef.current,
    estimateSize: () => 160,
    overscan: 5,
  });

  useEffect(() => {
    if (!scrollEl) return;
    virtualizer.measure();
    const ro = new ResizeObserver(() => { virtualizer.measure(); });
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollEl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { virtualizer.measure(); }, [resolvedEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(o) => { if (!o) useDebugStore.getState().sync({ isLogDrawerOpen: false }); }}
    >
      <SheetContent
        side="bottom"
        className="h-[55vh] flex flex-col p-0 [&>button]:hidden border-t border-border shadow-[0_-4px_16px_rgba(0,0,0,0.22)]"
        aria-describedby={undefined}
      >
        <SheetTitle className="sr-only">All Logs</SheetTitle>

        {/* ── header ── */}
        <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/60 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold tracking-wide">Event Logs</span>
            <span className="text-[10px] font-mono bg-muted border rounded px-1.5 py-0.5 text-muted-foreground">
              {allLogs.length}
            </span>
          </div>
          <button
            className="text-muted-foreground hover:text-foreground text-lg leading-none px-1 transition-colors"
            onClick={() => useDebugStore.getState().sync({ isLogDrawerOpen: false })}
          >
            ×
          </button>
        </div>

        {/* ── list ── */}
        <div ref={parentRef} className="overflow-auto" style={{ height: 'calc(55vh - 37px)', minHeight: 0 }}>
          {allLogs.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">No logs emitted</div>
          ) : (
            <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
              {virtualizer.getVirtualItems().map((vRow) => {
                const log = allLogs[vRow.index];
                const logNum = vRow.index;
                const topic0 = log.topics[0];
                const evName = topic0 ? (resolvedEvents[topic0] ?? getEvLocal(topic0)) : undefined;
                const decoded = evName ? decodeLogEntry(evName, log.topics, log.data) : null;
                const contractAddr = log.address || log.frameAddress;
                const stripe = STRIPE_COLORS[logNum % STRIPE_COLORS.length];

                // Build topic rows: if decoded, first topic is signature hash (skip for display),
                // remaining topics map to indexed args
                const indexedArgs = decoded?.args.filter(a => a.indexed) ?? [];
                const nonIndexedArgs = decoded?.args.filter(a => !a.indexed) ?? [];

                return (
                  <div
                    key={vRow.index}
                    ref={virtualizer.measureElement}
                    data-index={vRow.index}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vRow.start}px)` }}
                    className="border-b border-border/60 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex min-h-0">
                      {/* coloured left stripe + log index */}
                      <div className={`w-1 flex-shrink-0 ${stripe}`} />
                      <div className="flex-shrink-0 w-10 flex items-start justify-center pt-3">
                        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">{logNum}</span>
                      </div>

                      {/* main content */}
                      <div className="flex-1 min-w-0 py-2.5 pr-3 font-mono text-[11px]">

                        {/* ── row: Address ── */}
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-muted-foreground w-14 flex-shrink-0 text-right text-[10px]">Address</span>
                          <span
                            className="text-sky-500 hover:text-sky-300 cursor-pointer transition-colors flex items-center gap-0.5"
                            title={`Open ${contractAddr} in explorer`}
                            onClick={() => openScanAddress(scanUrl, contractAddr)}
                          >
                            {contractAddr}
                            <ExternalLink className="h-2.5 w-2.5 opacity-60" />
                          </span>
                          <span className="text-muted-foreground/50 text-[10px]">Frame:{log.contextId}</span>
                          {onSeekTo && (
                            <span
                              className="text-[10px] font-mono text-blue-500 hover:text-blue-300 cursor-pointer transition-colors tabular-nums"
                              onClick={() => onSeekTo(log.stepIndex)}
                              title={`Seek to step ${log.stepIndex}`}
                            >
                              {"-> " +  log.stepIndex}
                            </span>
                          )}
                        </div>

                        {/* ── row: Name ── */}
                        <div className="flex items-start gap-2 mb-1.5">
                          <span className="text-muted-foreground w-14 flex-shrink-0 text-right text-[10px] pt-px">Name</span>
                          {evName ? (
                            <span className="text-amber-400 font-semibold break-all">{evName}</span>
                          ) : topic0 ? (
                            <div className="flex items-center gap-1.5">
                              <span className="text-muted-foreground/60 italic text-[10px]">Unknown event</span>
                              <button
                                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded px-1.5 py-0.5 transition-colors disabled:opacity-40"
                                onClick={() => handleEventLookup(topic0)}
                                disabled={lookingUp === topic0}
                              >
                                {lookingUp === topic0
                                  ? <><Loader2 className="h-2.5 w-2.5 animate-spin" /> Looking up…</>
                                  : <><Search className="h-2.5 w-2.5" /> Lookup</>
                                }
                              </button>
                            </div>
                          ) : (
                            <span className="text-muted-foreground/50 italic text-[10px]">Anonymous (no topics)</span>
                          )}
                        </div>

                        {/* ── Topics ── */}
                        {log.topics.length > 0 && (
                          <div className="flex items-start gap-2 mb-1">
                            <span className="text-muted-foreground w-14 flex-shrink-0 text-right text-[10px] pt-px">Topics</span>
                            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                              {log.topics.map((topic, ti) => {
                                const isSignature = ti === 0;
                                const indexedArg = !isSignature ? indexedArgs[ti - 1] : undefined;
                                return (
                                  <div key={ti} className="flex items-baseline gap-1.5 min-w-0">
                                    <span className="text-[10px] text-muted-foreground/60 flex-shrink-0 w-4 text-right">[{ti}]</span>
                                    {isSignature ? (
                                      <span className="text-foreground break-all">{topic}</span>
                                    ) : indexedArg ? (
                                      <span className="min-w-0 break-all">
                                        <span className="text-foreground break-all">{indexedArg.value}</span>
                                        <span className="text-muted-foreground/50 ml-1 text-[10px]">{indexedArg.type}</span>
                                      </span>
                                    ) : (
                                      <span className="text-foreground break-all">{topic}</span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* ── Data ── */}
                        {nonIndexedArgs.length > 0 ? (
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground w-14 flex-shrink-0 text-right text-[10px] pt-px">Data</span>
                            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                              {nonIndexedArgs.map((arg, i) => (
                                <div key={i} className="flex items-baseline gap-1.5">
                                  <span className="text-[10px] text-muted-foreground/60 flex-shrink-0 w-4 text-right">[{i}]</span>
                                  <span className="text-foreground break-all">{arg.value}</span>
                                  <span className="text-muted-foreground/50 text-[10px]">{arg.type}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : log.data && log.data !== '0x' ? (
                          <div className="flex items-start gap-2">
                            <span className="text-muted-foreground w-14 flex-shrink-0 text-right text-[10px] pt-px">Data</span>
                            <span className="text-foreground break-all">{log.data}</span>
                          </div>
                        ) : null}

                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
