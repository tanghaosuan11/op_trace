import { useEffect } from "react";
import { useDebugStore } from "@/store/debugStore";

/**
 * 仅同步 activeTab store 值到 ref（playback 回调使用）
 */
export function useTabSync(
  activeTabRef: React.RefObject<string>,
) {
  const activeTab = useDebugStore((s) => s.activeTab);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
}
