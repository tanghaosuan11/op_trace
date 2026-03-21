import { useCallback } from "react";
import { load } from "@tauri-apps/plugin-store";
import { useDebugStore } from "@/store/debugStore";

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

  return { handleBreakOpcodesChange, handleToggleBreakpoint };
}
