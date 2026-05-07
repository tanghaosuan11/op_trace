import { useMemo, useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useDebugStore } from "@/store/debugStore";
import type { StepData } from "@/lib/stepPlayer";
import type { StepFullData } from "@/hooks/useDebugPlayback";
import { OP_MAP } from "@/lib/opcodes";
import { ipcCommands } from "@/lib/ipcConfig";
import type { CallFrame } from "@/lib/types";

interface RangeDiffDialogProps {
  allStepsRef: React.RefObject<StepData[]>;
  fullDataCacheRef: React.RefObject<StepFullData[] | null>;
}

type SeekFrame = { transaction_id: number; context_id: number; stack: string[]; memory: string };
type SeekResult = { frames: SeekFrame[] };

type FrameGroup = {
  key: string;
  transactionId: number;
  contextId: number;
  firstIdx: number;
  lastIdx: number;
};

type FrameDiff = FrameGroup & {
  frameLabel: string;
  before: SeekFrame | null;
  after: SeekFrame | null;
};

function getFrameLabel(callFrames: CallFrame[], transactionId: number, contextId: number): string {
  const f = callFrames.find(
    (cf) => (cf.transactionId ?? 0) === transactionId && cf.contextId === contextId,
  );
  if (!f) return `ctx${contextId}`;
  const type = f.callType?.toUpperCase() ?? "CALL";
  const addr = f.target ?? f.address ?? "";
  if (!addr) return `${type} ctx${contextId}`;
  return `${type} ${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function hexToBytes(hex: string): Uint8Array {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  const len = Math.floor(raw.length / 2);
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  return buf;
}
function byteToHex(b: number) { return b.toString(16).padStart(2, "0"); }
const BYTES_PER_ROW = 16;
interface MemoryRowDiff { offset: number; before: (number | null)[]; after: (number | null)[]; hasChange: boolean; }

function diffMemory(before: string, after: string): MemoryRowDiff[] {
  const a = hexToBytes(before);
  const b = hexToBytes(after);
  const len = Math.max(a.length, b.length);
  if (len === 0) return [];
  const rows: MemoryRowDiff[] = [];
  for (let offset = 0; offset < len; offset += BYTES_PER_ROW) {
    const rb: (number | null)[] = [];
    const ra: (number | null)[] = [];
    let ch = false;
    for (let j = 0; j < BYTES_PER_ROW; j++) {
      const idx = offset + j;
      const av = idx < a.length ? a[idx]! : null;
      const bv = idx < b.length ? b[idx]! : null;
      rb.push(av); ra.push(bv);
      if (av !== bv) ch = true;
    }
    rows.push({ offset, before: rb, after: ra, hasChange: ch });
  }
  const cs = new Set<number>();
  rows.forEach((r, i) => { if (r.hasChange) { cs.add(i - 1); cs.add(i); cs.add(i + 1); } });
  return rows.filter((_, i) => cs.has(i));
}

function stackDiffRows(before: string[], after: string[]): Array<{ idx: number; before: string | null; after: string | null; state: "same" | "changed" | "added" | "removed" }> {
  const maxLen = Math.max(before.length, after.length);
  const out = [];
  for (let i = 0; i < maxLen; i++) {
    const b = before[before.length - 1 - i] ?? null;
    const a = after[after.length - 1 - i] ?? null;
    let state: "same" | "changed" | "added" | "removed" = "same";
    if (b === null) state = "added";
    else if (a === null) state = "removed";
    else if (b !== a) state = "changed";
    out.push({ idx: i, before: b, after: a, state });
  }
  return out;
}

function shortHex(h: string | null): string {
  if (h === null) return "—";
  const raw = h.startsWith("0x") ? h.slice(2) : h;
  const trimmed = raw.replace(/^0+/, "") || "0";
  if (trimmed.length <= 14) return `0x${trimmed}`;
  return `0x${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

export function RangeDiffDialog({ allStepsRef }: RangeDiffDialogProps) {
  const isOpen = useDebugStore((s) => s.isRangeDiffOpen);
  const rangeStart = useDebugStore((s) => s.rangeStart);
  const rangeEnd = useDebugStore((s) => s.rangeEnd);
  const callFrames = useDebugStore((s) => s.callFrames);
  const sessionId = useDebugStore((s) => s.sessionId);
  const handleClose = () => useDebugStore.getState().sync({ isRangeDiffOpen: false });
  const rangeTooBig = rangeEnd - rangeStart >= 5000;

  const [beforeMap, setBeforeMap] = useState<Map<string, SeekFrame> | null>(null);
  const [afterMap, setAfterMap] = useState<Map<string, SeekFrame> | null>(null);
  const [loadingSeek, setLoadingSeek] = useState(false);
  const loadedForRef = useRef<string>("");

  useEffect(() => {
    if (!isOpen || rangeTooBig) return;
    const key = `${sessionId}:${rangeStart}:${rangeEnd}`;
    if (loadedForRef.current === key) return;
    setLoadingSeek(true);
    let cancelled = false;
    const rid = Math.floor(Math.random() * 0x7fffffff);
    Promise.all([
      invoke<SeekResult>(ipcCommands.seekTo, { index: rangeStart, requestId: rid, sessionId }),
      invoke<SeekResult>(ipcCommands.seekTo, { index: rangeEnd, requestId: rid + 1, sessionId }),
    ])
      .then(([r0, r1]) => {
        if (cancelled) return;
        console.log(`[RangeDiffDialog] seek_to(${rangeStart}) → ${r0.frames.length} frames`, r0.frames.map(f => `(${f.transaction_id},${f.context_id}):stack=${f.stack.length}`));
        console.log(`[RangeDiffDialog] seek_to(${rangeEnd}) → ${r1.frames.length} frames`, r1.frames.map(f => `(${f.transaction_id},${f.context_id}):stack=${f.stack.length}`));
        setBeforeMap(new Map(r0.frames.map((f) => [`${f.transaction_id}:${f.context_id}`, f])));
        setAfterMap(new Map(r1.frames.map((f) => [`${f.transaction_id}:${f.context_id}`, f])));
        loadedForRef.current = key;
      })
      .catch((e) => { console.warn("[RangeDiffDialog] seek_to failed:", e); })
      .finally(() => { if (!cancelled) setLoadingSeek(false); });
    return () => { cancelled = true; };
  }, [isOpen, rangeStart, rangeEnd, sessionId, rangeTooBig]);

  useEffect(() => {
    if (!isOpen) { setBeforeMap(null); setAfterMap(null); loadedForRef.current = ""; }
  }, [isOpen]);

  const frameGroups = useMemo((): FrameGroup[] => {
    if (!isOpen || rangeTooBig) return [];
    const steps = allStepsRef.current;
    const map = new Map<string, FrameGroup>();
    for (let i = rangeStart; i <= rangeEnd && i < steps.length; i++) {
      const s = steps[i]!;
      const key = `${s.transactionId}:${s.contextId}`;
      const g = map.get(key);
      if (!g) map.set(key, { key, transactionId: s.transactionId, contextId: s.contextId, firstIdx: i, lastIdx: i });
      else g.lastIdx = i;
    }
    return [...map.values()];
  }, [isOpen, rangeTooBig, rangeStart, rangeEnd, allStepsRef]);

  const frameDiffs = useMemo((): FrameDiff[] | null => {
    if (!beforeMap || !afterMap) return null;
    return frameGroups.map((g) => ({
      ...g,
      frameLabel: getFrameLabel(callFrames, g.transactionId, g.contextId),
      before: beforeMap.get(g.key) ?? null,
      after: afterMap.get(g.key) ?? null,
    }));
  }, [frameGroups, beforeMap, afterMap, callFrames]);

  const stats = useMemo(() => {
    if (!isOpen || rangeTooBig) return null;
    const steps = allStepsRef.current;
    let totalGas = 0;
    const opcodeCounts = new Map<string, number>();
    for (let i = rangeStart; i <= rangeEnd && i < steps.length; i++) {
      const s = steps[i]!;
      totalGas += s.gasCost;
      const name = OP_MAP[s.opcode]?.name ?? `0x${s.opcode.toString(16).padStart(2, "0")}`;
      opcodeCounts.set(name, (opcodeCounts.get(name) ?? 0) + 1);
    }
    const sortedOpcodes = [...opcodeCounts.entries()].sort((a, b) => b[1] - a[1]);
    const stepCount = rangeEnd - rangeStart + 1;
    const rawWrites = callFrames.flatMap((f) =>
      f.storageChanges.filter((sc) => !sc.isRead && sc.stepIndex >= rangeStart && sc.stepIndex <= rangeEnd),
    );
    rawWrites.sort((a, b) => a.stepIndex - b.stepIndex);
    const storageMap = new Map<string, { address: string; key: string; hadValue: string; newValue: string; contextId: number; transactionId: number; frameLabel: string }>();
    for (const sc of rawWrites) {
      const txId = sc.transactionId ?? 0;
      const k = `${txId}:${sc.contextId}:${sc.address}:${sc.key}`;
      const e = storageMap.get(k);
      if (!e) storageMap.set(k, { address: sc.address, key: sc.key, hadValue: sc.hadValue, newValue: sc.newValue, contextId: sc.contextId, transactionId: txId, frameLabel: getFrameLabel(callFrames, txId, sc.contextId) });
      else e.newValue = sc.newValue;
    }
    const storageEntries = [...storageMap.values()];
    return { stepCount, totalGas, sortedOpcodes, storageEntries };
  }, [isOpen, rangeTooBig, rangeStart, rangeEnd, allStepsRef, callFrames]);

  const logsInRange = useMemo(() => {
    if (!isOpen || rangeTooBig) return [];
    return callFrames
      .flatMap((f) =>
        f.logs
          .filter((l) => l.stepIndex >= rangeStart && l.stepIndex <= rangeEnd)
          .map((l) => ({ ...l, frameLabel: getFrameLabel(callFrames, l.transactionId ?? 0, l.contextId) })),
      )
      .sort((a, b) => a.stepIndex - b.stepIndex);
  }, [isOpen, rangeTooBig, callFrames, rangeStart, rangeEnd]);

  const storageCount = stats?.storageEntries.length ?? 0;
  const logsCount = logsInRange.length;
  const totalStackChanges = frameDiffs?.reduce((sum, fd) => {
    if (!fd.before || !fd.after) return sum;
    const rows = stackDiffRows(fd.before.stack, fd.after.stack);
    const changed = rows.filter((r) => r.state !== "same").length;
    console.log(`[RangeDiffDialog] stackDiff frame(${fd.transactionId},${fd.contextId}): before.stack=${fd.before.stack.length} after.stack=${fd.after.stack.length} changed=${changed}`);
    return sum + changed;
  }, 0) ?? 0;
  const memChangedFrames = frameDiffs?.filter((fd) => {
    if (!fd.before || !fd.after) return false;
    return diffMemory(fd.before.memory ?? "", fd.after.memory ?? "").length > 0;
  }).length ?? 0;

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent aria-describedby={undefined} className="flex flex-col gap-0 p-0 overflow-hidden" style={{ maxWidth: 720, width: "96vw", height: "82vh" }}>
        <DialogHeader className="px-3 py-2 border-b bg-muted/40 flex-shrink-0">
          <DialogTitle className="text-[11px] font-medium text-foreground/90">
            Range Stats{" "}
            <span className="font-mono text-muted-foreground font-normal">
              step {rangeStart + 1} → {rangeEnd + 1}
              {stats ? ` · ${stats.stepCount.toLocaleString()} steps` : ""}
            </span>
          </DialogTitle>
        </DialogHeader>

        {rangeTooBig ? (
          <div className="flex items-center justify-center h-20 px-4 text-[11px] text-destructive">
            选定范围超过 5000 步（当前 {(rangeEnd - rangeStart + 1).toLocaleString()} 步），请缩小范围后重试
          </div>
        ) : stats && (
          <Tabs defaultValue="overview" className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <TabsList className="shrink-0 h-7 rounded-none border-b bg-muted/30 px-2 gap-0.5 justify-start">
              <TabsTrigger value="overview" className="h-5 px-2 text-[11px] rounded-sm data-[state=active]:bg-background data-[state=active]:shadow-none">总览</TabsTrigger>
              <TabsTrigger value="opcodes" className="h-5 px-2 text-[11px] rounded-sm data-[state=active]:bg-background data-[state=active]:shadow-none">
                指令 <span className="ml-1 font-mono text-[10px] text-muted-foreground">{stats.stepCount.toLocaleString()}</span>
              </TabsTrigger>
              <TabsTrigger value="storage" className="h-5 px-2 text-[11px] rounded-sm data-[state=active]:bg-background data-[state=active]:shadow-none">
                Storage{storageCount > 0 && <span className="ml-1 font-mono text-[10px] text-muted-foreground">{storageCount}</span>}
              </TabsTrigger>
              <TabsTrigger value="stack" className="h-5 px-2 text-[11px] rounded-sm data-[state=active]:bg-background data-[state=active]:shadow-none">
                Stack{totalStackChanges > 0 && <span className="ml-1 font-mono text-[10px] text-amber-400/80">{totalStackChanges}</span>}
              </TabsTrigger>
              <TabsTrigger value="memory" className="h-5 px-2 text-[11px] rounded-sm data-[state=active]:bg-background data-[state=active]:shadow-none">
                Memory{memChangedFrames > 0 && <span className="ml-1 font-mono text-[10px] text-amber-400/80">{memChangedFrames}</span>}
              </TabsTrigger>
              <TabsTrigger value="logs" className="h-5 px-2 text-[11px] rounded-sm data-[state=active]:bg-background data-[state=active]:shadow-none">
                Logs{logsCount > 0 && <span className="ml-1 font-mono text-[10px] text-muted-foreground">{logsCount}</span>}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="m-0 flex-1 overflow-auto px-3 py-0.5">
              <OverviewRow label="步骤范围" value={`${rangeStart + 1} → ${rangeEnd + 1}`} />
              <OverviewRow label="总步数" value={stats.stepCount.toLocaleString()} />
              <OverviewRow label="Gas 消耗" value={stats.totalGas.toLocaleString()} />
              <OverviewRow label="指令种类" value={String(stats.sortedOpcodes.length)} />
              <OverviewRow label="涉及 Frame 数" value={String(frameGroups.length)} />
              <OverviewRow label="Storage 写入" value={`${storageCount} slot`} />
              <OverviewRow label="Stack 变化项" value={loadingSeek ? "…" : String(totalStackChanges)} />
              <OverviewRow label="Memory 变化 Frame" value={loadingSeek ? "…" : String(memChangedFrames)} />
              <OverviewRow label="Logs" value={String(logsCount)} />
            </TabsContent>

            <TabsContent value="opcodes" className="m-0 flex-1 overflow-auto">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-background z-10 border-b">
                  <tr><Th>Opcode</Th><Th right>次数</Th><Th right>占比</Th></tr>
                </thead>
                <tbody>
                  {stats.sortedOpcodes.map(([name, count]) => (
                    <tr key={name} className="border-b border-border/30 hover:bg-muted/20">
                      <Td mono>{name}</Td>
                      <Td right mono>{count.toLocaleString()}</Td>
                      <Td right muted>{stats.stepCount > 0 ? ((count / stats.stepCount) * 100).toFixed(1) : "0.0"}%</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TabsContent>

            <TabsContent value="storage" className="m-0 flex-1 overflow-auto">
              {storageCount === 0 ? <Empty>此范围内无 Storage 写入</Empty> : (
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 bg-background z-10 border-b">
                    <tr><Th>Frame</Th><Th>合约</Th><Th>Slot</Th><Th>Before</Th><Th>After</Th></tr>
                  </thead>
                  <tbody>
                    {stats.storageEntries.map((e, i) => {
                      const changed = e.hadValue !== e.newValue;
                      const bv = e.hadValue.replace(/^0x0*/, "") || "0";
                      const av = e.newValue.replace(/^0x0*/, "") || "0";
                      return (
                        <tr key={i} className="border-b border-border/30 hover:bg-muted/20" title={`${e.frameLabel}\n${e.address}\n${e.key}`}>
                          <Td muted>{e.frameLabel}</Td>
                          <Td mono muted>{e.address.slice(0, 8)}…{e.address.slice(-4)}</Td>
                          <Td mono>{e.key.slice(0, 10)}…{e.key.slice(-4)}</Td>
                          <Td mono className="text-red-400/80">0x{bv.length > 12 ? `${bv.slice(0, 6)}…${bv.slice(-4)}` : bv}</Td>
                          <Td mono className={changed ? "text-green-400" : "text-muted-foreground"}>0x{av.length > 12 ? `${av.slice(0, 6)}…${av.slice(-4)}` : av}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </TabsContent>

            <TabsContent value="stack" className="m-0 flex-1 overflow-auto">
              {loadingSeek ? <Loading /> : !frameDiffs ? <Empty>无数据</Empty> : (
                <div className="divide-y divide-border/30">
                  {frameDiffs.map((fd) => (
                    <StackFrameSection key={fd.key} fd={fd} rangeStart={rangeStart} rangeEnd={rangeEnd} />
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="memory" className="m-0 flex-1 overflow-auto">
              {loadingSeek ? <Loading /> : !frameDiffs ? <Empty>无数据</Empty> : (
                <div className="divide-y divide-border/30">
                  {frameDiffs.map((fd) => (
                    <MemoryFrameSection key={fd.key} fd={fd} rangeStart={rangeStart} rangeEnd={rangeEnd} />
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="logs" className="m-0 flex-1 overflow-auto">
              {logsCount === 0 ? <Empty>此范围内无 Log</Empty> : (
                <div className="divide-y divide-border/30">
                  {logsInRange.map((l, i) => (
                    <div key={i} className="px-3 py-1.5 hover:bg-muted/20">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[10px] font-mono text-muted-foreground">step {l.stepIndex + 1}</span>
                        <span className="text-[10px] text-muted-foreground">{l.frameLabel}</span>
                        <span className="text-[10px] font-mono text-muted-foreground/70">{l.address.slice(0, 8)}…{l.address.slice(-4)}</span>
                      </div>
                      {l.topics.length > 0 && (
                        <div className="text-[10px] font-mono space-y-0.5">
                          {l.topics.map((t, ti) => (
                            <div key={ti} className="text-muted-foreground">
                              <span className="text-foreground/50 mr-1">topic{ti}</span>
                              {t.length > 28 ? `${t.slice(0, 18)}…${t.slice(-6)}` : t}
                            </div>
                          ))}
                        </div>
                      )}
                      {l.data && l.data !== "0x" && (
                        <div className="text-[10px] font-mono text-muted-foreground mt-0.5">
                          <span className="text-foreground/50 mr-1">data</span>
                          {l.data.length > 42 ? `${l.data.slice(0, 20)}…${l.data.slice(-8)}` : l.data}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StackFrameSection({ fd, rangeStart, rangeEnd }: { fd: FrameDiff; rangeStart: number; rangeEnd: number }) {
  const rows = fd.before && fd.after ? stackDiffRows(fd.before.stack, fd.after.stack) : null;
  const changes = rows?.filter((r) => r.state !== "same").length ?? 0;
  return (
    <div>
      <FrameHeader fd={fd} rangeStart={rangeStart} rangeEnd={rangeEnd} badge={changes > 0 ? String(changes) : undefined} />
      {!fd.before ? (
        <div className="px-3 py-1 text-[10px] text-muted-foreground">↳ frame 在范围内开始，无 before 状态</div>
      ) : !fd.after ? (
        <div className="px-3 py-1 text-[10px] text-muted-foreground">↳ 无 after 状态</div>
      ) : rows && rows.length > 0 ? (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border/20">
              <Th w={32}>#</Th>
              <Th>Before · step {rangeStart + 1}</Th>
              <Th>After · step {rangeEnd + 1}</Th>
              <Th w={36}></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isChanged = row.state !== "same";
              const labelClass = row.state === "added" ? "text-green-400" : row.state === "removed" ? "text-red-400" : row.state === "changed" ? "text-amber-400" : "text-transparent";
              const label = row.state === "added" ? "+" : row.state === "removed" ? "−" : row.state === "changed" ? "~" : "";
              return (
                <tr key={row.idx} className={`border-b border-border/20 ${isChanged ? "bg-muted/10" : "hover:bg-muted/10"}`}>
                  <Td w={32} muted mono>[{row.idx}]</Td>
                  <Td mono className={row.state === "removed" || row.state === "changed" ? "text-red-400/70" : "text-muted-foreground"}>{shortHex(row.before)}</Td>
                  <Td mono className={row.state === "added" ? "text-green-400" : row.state === "changed" ? "text-amber-400" : "text-muted-foreground"}>{shortHex(row.after)}</Td>
                  <Td w={36} mono className={labelClass}>{label}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="px-3 py-1 text-[10px] text-muted-foreground">↳ Stack 无变化</div>
      )}
    </div>
  );
}

function MemoryFrameSection({ fd, rangeStart, rangeEnd }: { fd: FrameDiff; rangeStart: number; rangeEnd: number }) {
  const memRows = fd.before && fd.after ? diffMemory(fd.before.memory ?? "", fd.after.memory ?? "") : null;
  return (
    <div>
      <FrameHeader fd={fd} rangeStart={rangeStart} rangeEnd={rangeEnd} badge={memRows && memRows.length > 0 ? String(memRows.length) : undefined} />
      {!fd.before ? (
        <div className="px-3 py-1 text-[10px] text-muted-foreground">↳ frame 在范围内开始，无 before 状态</div>
      ) : !fd.after ? (
        <div className="px-3 py-1 text-[10px] text-muted-foreground">↳ 无 after 状态</div>
      ) : memRows && memRows.length > 0 ? (
        <div className="px-2 py-1.5 space-y-1.5">
          {memRows.map((row) => <MemoryDiffRow key={row.offset} row={row} />)}
        </div>
      ) : (
        <div className="px-3 py-1 text-[10px] text-muted-foreground">↳ Memory 无变化</div>
      )}
    </div>
  );
}

function FrameHeader({ fd, rangeStart, rangeEnd, badge }: { fd: FrameDiff; rangeStart: number; rangeEnd: number; badge?: string }) {
  const firstInRange = Math.max(fd.firstIdx, rangeStart);
  const lastInRange = Math.min(fd.lastIdx, rangeEnd);
  return (
    <div className="flex items-center gap-2 px-3 py-1 bg-muted/20 border-b border-border/20">
      <span className="text-[10px] font-medium text-foreground/80">{fd.frameLabel}</span>
      <span className="text-[10px] font-mono text-muted-foreground">
        ctx{fd.contextId}{fd.transactionId > 0 ? ` tx${fd.transactionId}` : ""}
      </span>
      <span className="text-[10px] text-muted-foreground">steps {firstInRange + 1}–{lastInRange + 1}</span>
      {badge && <span className="ml-auto text-[10px] font-mono text-amber-400/80">{badge} changes</span>}
    </div>
  );
}

function OverviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-[11px] font-mono">{value}</span>
    </div>
  );
}

function Th({ children, right, w }: { children?: React.ReactNode; right?: boolean; w?: number }) {
  return (
    <th className={`text-[10px] font-medium text-muted-foreground px-2 py-1 text-left ${right ? "text-right" : ""}`} style={w ? { width: w } : undefined}>
      {children}
    </th>
  );
}

function Td({ children, mono, muted, right, w, className = "" }: { children?: React.ReactNode; mono?: boolean; muted?: boolean; right?: boolean; w?: number; className?: string }) {
  return (
    <td className={`text-[11px] px-2 py-0.5 ${mono ? "font-mono" : ""} ${muted ? "text-muted-foreground" : ""} ${right ? "text-right" : ""} ${className}`} style={w ? { width: w } : undefined}>
      {children}
    </td>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center h-14 text-[11px] text-muted-foreground">{children}</div>;
}

function Loading() {
  return <div className="flex items-center justify-center h-14 text-[11px] text-muted-foreground">加载中…</div>;
}

function MemoryDiffRow({ row }: { row: MemoryRowDiff }) {
  const offHex = row.offset.toString(16).padStart(4, "0");
  return (
    <div className="font-mono text-[10px] rounded border border-border/40 overflow-hidden">
      <div className="bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">0x{offHex}</div>
      <div className="grid grid-cols-2 divide-x divide-border/30">
        <div className="px-2 py-1 flex flex-wrap gap-x-1">
          {row.before.map((b, i) => (
            <span key={i} className={b !== row.after[i] ? "text-red-400" : "text-muted-foreground"}>
              {b !== null ? byteToHex(b) : "··"}
            </span>
          ))}
        </div>
        <div className="px-2 py-1 flex flex-wrap gap-x-1">
          {row.after.map((b, i) => (
            <span key={i} className={b !== row.before[i] ? "text-green-400" : "text-muted-foreground"}>
              {b !== null ? byteToHex(b) : "··"}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
