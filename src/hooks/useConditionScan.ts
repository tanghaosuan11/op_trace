import { useRef, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { useDebugStore } from "@/store/debugStore";
import { rebuildConditionHitSet } from "@/lib/pauseConditions";

/**
 * 条件断点扫描逻辑：手动扫描 + 模拟结束后自动扫描
 */
export function useConditionScan(
  conditionHitSetRef: React.RefObject<Set<number>>,
) {
  const storeSync = useDebugStore.getState().sync;
  const isDebugging = useDebugStore((s) => s.isDebugging);

  // 手动触发条件断点扫描
  const runConditionScan = useCallback(() => {
    const { stepCount, condNodes } = useDebugStore.getState();
    if (stepCount === 0 || condNodes.length === 0) return;
    const t0 = performance.now();
    rebuildConditionHitSet(condNodes).then(({ hitSet, hits }) => {
      const t1 = performance.now();
      conditionHitSetRef.current = hitSet;
      storeSync({ conditionHitSet: hitSet, scanHits: hits });
      console.log(
        `[ConditionScan] ${condNodes.length} 节点 → ${hits.length} 命中 | ${(t1 - t0).toFixed(1)}ms`,
      );
      toast.success(`扫描完成 — ${hits.length} 个命中`, { duration: 2500 });
    }).catch(err => {
      console.error("[ConditionScan] failed:", err);
      toast.error("扫描失败");
    });
  }, []);

  // 模拟结束时自动跑一遍扫描
  const prevIsDebuggingRef = useRef(false);
  useEffect(() => {
    const justFinished = prevIsDebuggingRef.current && !isDebugging;
    prevIsDebuggingRef.current = isDebugging;
    if (!justFinished) return;
    const { stepCount, condNodes } = useDebugStore.getState();
    if (stepCount === 0 || condNodes.length === 0) return;
    let cancelled = false;
    const t0 = performance.now();
    rebuildConditionHitSet(condNodes).then(({ hitSet, hits }) => {
      if (cancelled) return;
      const t1 = performance.now();
      conditionHitSetRef.current = hitSet;
      storeSync({ conditionHitSet: hitSet, scanHits: hits });
      console.log(
        `[ConditionScan auto] ${condNodes.length} 节点 → ${hits.length} 命中 | ${(t1 - t0).toFixed(1)}ms`,
      );
      toast.success(`扫描完成 — ${hits.length} 个命中`, { duration: 2500 });
    }).catch(err => {
      if (!cancelled) console.error("[ConditionScan] failed:", err);
    });
    return () => { cancelled = true; };
  }, [isDebugging]);

  return { runConditionScan };
}
