import { useCallback } from "react";
import { load } from "@tauri-apps/plugin-store";
import { useDebugStore } from "@/store/debugStore";
import { getWindowMode } from "@/lib/windowMode";

/**
 * 断点管理逻辑：opcode 断点 + PC 断点
 */
export function useBreakpoints(
  breakOpcodesRef: React.RefObject<Set<number>>,
  breakpointPcsRef: React.RefObject<Map<string, Set<number>>>,
) {
  const storeSync = useDebugStore.getState().sync;

  // 同步 breakOpcodes 到 ref，并持久化到 config
  const handleBreakOpcodesChange = useCallback((opcodes: Set<number>) => {
    breakOpcodesRef.current = opcodes;
    storeSync({ breakOpcodes: opcodes });
    if (getWindowMode().readonly) return;
    load("config.json", { autoSave: true, defaults: {} }).then(store => {
      store.set("breakOpcodes", Array.from(opcodes));
    });
  }, []);

  // 切换 PC 断点
  const handleToggleBreakpoint = useCallback((frameId: string, pc: number) => {
    const prev = useDebugStore.getState().breakpointPcsMap;
    const next = new Map(prev);
    const pcs = new Set(next.get(frameId) || []);
    if (pcs.has(pc)) pcs.delete(pc);
    else pcs.add(pc);
    next.set(frameId, pcs);
    breakpointPcsRef.current = next;
    storeSync({ breakpointPcsMap: next });
  }, []);

  /** 从列表中移除单个 PC 断点（与 toggle 一致地同步 ref + store） */
  const handleRemoveBreakpoint = useCallback((frameId: string, pc: number) => {
    const prev = useDebugStore.getState().breakpointPcsMap;
    const next = new Map(prev);
    const pcs = new Set(next.get(frameId) || []);
    pcs.delete(pc);
    if (pcs.size === 0) next.delete(frameId);
    else next.set(frameId, pcs);
    breakpointPcsRef.current = next;
    storeSync({ breakpointPcsMap: next });
  }, []);

  /** 移除该 frame 下全部 PC 断点及对应 label */
  const handleClearFrameBreakpoints = useCallback((frameId: string) => {
    const prev = useDebugStore.getState().breakpointPcsMap;
    const oldPcs = prev.get(frameId);
    if (!oldPcs || oldPcs.size === 0) return;
    const next = new Map(prev);
    next.delete(frameId);
    breakpointPcsRef.current = next;
    storeSync({ breakpointPcsMap: next });
    const rm = useDebugStore.getState().removeBreakpointLabel;
    for (const pc of oldPcs) rm(pc);
  }, []);

  /** 清空所有 frame 的 PC 断点及全部 label */
  const handleClearAllBreakpoints = useCallback(() => {
    const prev = useDebugStore.getState().breakpointPcsMap;
    if (prev.size === 0) return;
    breakpointPcsRef.current = new Map();
    storeSync({
      breakpointPcsMap: new Map(),
      breakpointLabels: new Map(),
    });
  }, []);

  return {
    handleBreakOpcodesChange,
    handleToggleBreakpoint,
    handleRemoveBreakpoint,
    handleClearFrameBreakpoints,
    handleClearAllBreakpoints,
  };
}
