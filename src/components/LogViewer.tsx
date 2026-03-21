import { Card } from "@/components/ui/card";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useState, useRef, useEffect } from "react";
import { Search, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useDebugStore } from "@/store/debugStore";
import { getEvLocal, lookupSignature4Byte, decodeLogEntry } from "@/lib/fourbyteUtils";

export function LogViewer() {
  const logs = useDebugStore((s) => s.logs);
  const parentRef = useRef<HTMLDivElement>(null);

  // topic0 → resolved event name（lookup 后写入 state 触发重渲染）
  const [resolvedEvents, setResolvedEvents] = useState<Record<string, string>>({});
  const [lookingUp, setLookingUp] = useState<string | null>(null);
  const attemptedRef = useRef<Set<string>>(new Set());

  // 自动解析：打开时自动查 local + 4byte API
  useEffect(() => {
    if (logs.length === 0) return;
    const unresolved: string[] = [];
    const seen = new Set<string>();
    for (const log of logs) {
      const t0 = log.topics[0];
      if (t0 && !seen.has(t0) && !resolvedEvents[t0] && !getEvLocal(t0) && !attemptedRef.current.has(t0)) {
        seen.add(t0);
        unresolved.push(t0);
      }
    }
    if (unresolved.length === 0) return;
    for (const t0 of unresolved) attemptedRef.current.add(t0);
    for (const t0 of unresolved) {
      lookupSignature4Byte(t0)
        .then(({ ev }) => { if (ev) setResolvedEvents(prev => ({ ...prev, [t0]: ev })); })
        .catch(() => {});
    }
  }, [logs]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleEventLookup(topic0: string) {
    if (lookingUp) return;
    setLookingUp(topic0);
    try {
      const { ev } = await lookupSignature4Byte(topic0);
      if (ev) {
        setResolvedEvents(prev => ({ ...prev, [topic0]: ev }));
      } else {
        toast.error('No matching event signature found');
      }
    } catch {
      toast.error('Lookup failed');
    } finally {
      setLookingUp(null);
    }
  }

  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 90,
    overscan: 5,
  });

  // 解码后行高变化，重新测量
  useEffect(() => {
    virtualizer.measure();
  }, [resolvedEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card className="h-full flex flex-col">
      <div className="text-xs font-semibold px-2 py-1 border-b bg-muted/50">
        Log / Events ({logs.length})
      </div>
      <div ref={parentRef} className="flex-1 overflow-auto text-[11px] scrollbar-hidden">
        {logs.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground">
            No logs
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const log = logs[virtualRow.index];
              const topic0 = log.topics[0];
              const evName = topic0
                ? (resolvedEvents[topic0] ?? getEvLocal(topic0))
                : undefined;
              const decoded = evName ? decodeLogEntry(evName, log.topics, log.data) : null;
              const showRaw = !decoded || (decoded.args.length === 0 && !!log.data && log.data !== '0x');

              return (
                <div
                  key={virtualRow.index}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="px-2 py-1 border-b hover:bg-muted/50"
                >
                  <div className="text-[11px] font-mono">
                    {/* 事件名 */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      {evName ? (
                        <span className="text-amber-500 font-semibold truncate min-w-0" title={evName}>
                          {evName}
                          {decoded === null && <span className="text-muted-foreground font-normal ml-1">(decode failed)</span>}
                        </span>
                      ) : topic0 ? (
                        <button
                          className="h-4 w-4 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:opacity-40"
                          onClick={() => handleEventLookup(topic0)}
                          disabled={lookingUp === topic0}
                          title="Lookup event signature"
                        >
                          {lookingUp === topic0
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Search className="h-3 w-3" />}
                        </button>
                      ) : null}
                    </div>
                    {/* Topics 或解码参数 */}
                    {showRaw ? (
                      <div className="mt-0.5 pl-2 border-l border-muted-foreground/20">
                        {log.topics.length === 0 && (!log.data || log.data === '0x') ? (
                          <div className="text-muted-foreground leading-tight italic">LOG0 (no topics, no data)</div>
                        ) : (
                          <>
                            {log.topics.map((topic, i) => (
                              <div key={i} className="truncate leading-tight">
                                <span className="text-muted-foreground">topic{i}</span>{' '}
                                <span className="text-foreground/90">{topic}</span>
                              </div>
                            ))}
                            {log.data && log.data !== '0x' && (
                              <div className="text-foreground/80 truncate">
                                data: {log.data}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ) : decoded ? (
                      <div className="mt-0.5 pl-2 border-l border-muted-foreground/20">
                        {decoded.args.length === 0 ? (
                          <div className="text-muted-foreground leading-tight italic">no args</div>
                        ) : decoded.args.map((arg, i) => (
                          <div key={i} className="truncate leading-tight">
                            <span className="text-muted-foreground">{arg.type}</span>{' '}
                            <span className={arg.indexed ? "text-sky-500" : "text-foreground"}>
                              {arg.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}

