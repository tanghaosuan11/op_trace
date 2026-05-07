import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useDebugStore } from "@/store/debugStore";
import { getFnLocal, getEvLocal, lookupSignature4Byte } from "@/lib/fourbyteUtils";

interface DecompileStmt {
  type: string;
  step?: number;
  [k: string]: unknown;
}

interface DecompileResult {
  transaction_id: number;
  frame_id: number;
  address: string;
  caller: string;
  kind: string;
  success: boolean;
  step_count: number;
  stmts: DecompileStmt[];
  pseudocode: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  transactionId: number;
  contextId: number;
}

function extractSelectors(code: string): { fnSelectors: string[]; evTopics: string[] } {
  const fn = new Set<string>();
  const ev = new Set<string>();
  // 匹配 selector=0x12345678 / sig=0x12345678 / topic0=0x{64hex}
  const fnRe = /(?:selector|sig)\s*=\s*(0x[0-9a-fA-F]{8})\b/g;
  const evRe = /(?:topic0|topics?=\[?)\s*[:=]?\s*(0x[0-9a-fA-F]{64})\b/g;
  for (const m of code.matchAll(fnRe)) fn.add(m[1].toLowerCase());
  for (const m of code.matchAll(evRe)) ev.add(m[1].toLowerCase());
  return { fnSelectors: Array.from(fn), evTopics: Array.from(ev) };
}

function annotateCode(code: string, fnSigs: Map<string, string>, evSigs: Map<string, string>): string {
  let out = code;
  for (const [sel, sig] of fnSigs) {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    out = out.replace(re, `${sel} /* ${sig} */`);
  }
  for (const [topic, sig] of evSigs) {
    const re = new RegExp(topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    out = out.replace(re, `${topic} /* ${sig} */`);
  }
  return out;
}

export function DecompileDialog({ open, onOpenChange, transactionId, contextId }: Props) {
  const sessionId = useDebugStore((s) => s.sessionId);
  const txSlots = useDebugStore((s) => s.txSlots);
  const txDataList = useDebugStore((s) => s.txDataList);
  const txData = useDebugStore((s) => s.txData);

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DecompileResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [annotated, setAnnotated] = useState<string | null>(null);

  const calldataByTx = useMemo<[number, string][]>(() => {
    const list: [number, string][] = [];
    for (let i = 0; i < txSlots.length; i++) {
      const data = txSlots[i]?.txData?.data;
      if (typeof data === "string" && data.trim()) list.push([i, data]);
    }
    if (list.length === 0) {
      for (let i = 0; i < txDataList.length; i++) {
        const data = txDataList[i]?.data;
        if (typeof data === "string" && data.trim()) list.push([i, data]);
      }
    }
    return list;
  }, [txSlots, txDataList]);

  const primaryCalldata = useMemo(() => {
    const hit = calldataByTx.find(([id]) => id === transactionId)?.[1];
    return hit ?? txData?.data ?? "0x";
  }, [calldataByTx, transactionId, txData]);

  const runDecompile = useCallback(async () => {
    if (!sessionId) {
      toast.error("会话未就绪");
      return;
    }
    setLoading(true);
    setError(null);
    setAnnotated(null);
    try {
      const res = await invoke<DecompileResult>("decompile_frame_cmd", {
        transactionId,
        frameId: contextId,
        calldataHex: primaryCalldata,
        calldataByTx: calldataByTx.length > 0 ? calldataByTx : null,
        sessionId,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, transactionId, contextId, primaryCalldata, calldataByTx]);

  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
      setAnnotated(null);
      void runDecompile();
    }
  }, [open, runDecompile]);

  // 本地签名标注（立即可用）+ 自动远程解析未命中的 selector
  useEffect(() => {
    if (!result) return;
    const { fnSelectors, evTopics } = extractSelectors(result.pseudocode);
    const fnMap = new Map<string, string>();
    const evMap = new Map<string, string>();
    const missingFn: string[] = [];
    const missingEv: string[] = [];
    for (const s of fnSelectors) {
      const sig = getFnLocal(s);
      if (sig) fnMap.set(s, sig);
      else missingFn.push(s);
    }
    for (const t of evTopics) {
      const sig = getEvLocal(t);
      if (sig) evMap.set(t, sig);
      else missingEv.push(t);
    }
    // 先用本地结果渲染一次
    setAnnotated(annotateCode(result.pseudocode, fnMap, evMap));

    // 后台并发补齐缺失的（上限 12 个，避免刷接口）
    const remaining = [...missingFn, ...missingEv].slice(0, 12);
    if (remaining.length === 0) return;
    let cancelled = false;
    Promise.all(
      remaining.map(async (s) => {
        try {
          const { fn, ev } = await lookupSignature4Byte(s);
          if (fn) fnMap.set(s, fn);
          if (ev) evMap.set(s, ev);
        } catch {
          /* ignore */
        }
      }),
    ).then(() => {
      if (cancelled) return;
      setAnnotated(annotateCode(result.pseudocode, fnMap, evMap));
    });
    return () => {
      cancelled = true;
    };
  }, [result]);

  const resolveRemote = useCallback(async () => {
    if (!result) return;
    const { fnSelectors, evTopics } = extractSelectors(result.pseudocode);
    const fnMap = new Map<string, string>();
    const evMap = new Map<string, string>();
    try {
      await Promise.all(
        [...fnSelectors, ...evTopics].map(async (s) => {
          try {
            const { fn, ev } = await lookupSignature4Byte(s);
            if (fn) fnMap.set(s, fn);
            if (ev) evMap.set(s, ev);
          } catch {
            /* ignore */
          }
        }),
      );
      // 叠加本地缓存
      for (const s of fnSelectors) {
        if (!fnMap.has(s)) {
          const sig = getFnLocal(s);
          if (sig) fnMap.set(s, sig);
        }
      }
      for (const t of evTopics) {
        if (!evMap.has(t)) {
          const sig = getEvLocal(t);
          if (sig) evMap.set(t, sig);
        }
      }
      setAnnotated(annotateCode(result.pseudocode, fnMap, evMap));
      toast.success(`已解析 ${fnMap.size} 函数 / ${evMap.size} 事件`);
    } catch (e) {
      toast.error(`远程解析失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [result]);

  const copyCode = useCallback(() => {
    const text = annotated ?? result?.pseudocode ?? "";
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => toast.success("已复制伪代码"));
  }, [annotated, result]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-[min(960px,92vw)] max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Decompile tx{transactionId}·c{contextId}
          </DialogTitle>
          <DialogDescription className="text-xs">
            基于已执行 trace 的线性符号化反编译
            {result ? ` · ${result.kind} · ${result.step_count} steps · success=${result.success}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-xs">
          <Button size="sm" variant="outline" onClick={runDecompile} disabled={loading}>
            {loading ? "解析中..." : "重新反编译"}
          </Button>
          <Button size="sm" variant="outline" onClick={resolveRemote} disabled={!result || loading}>
            4byte 远程解析
          </Button>
          <Button size="sm" variant="outline" onClick={copyCode} disabled={!result}>
            复制
          </Button>
          {error && <span className="text-destructive">{error}</span>}
        </div>

        <pre className="flex-1 overflow-auto bg-muted/40 p-2 text-[11px] font-mono whitespace-pre rounded border">
          {annotated ?? result?.pseudocode ?? (loading ? "..." : "")}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
