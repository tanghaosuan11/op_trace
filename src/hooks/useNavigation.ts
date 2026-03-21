import { useRef, useCallback } from "react";
import { useDebugStore } from "@/store/debugStore";

export function useNavigation(
  seekTo: (index: number) => void,
  activeTabRef: { readonly current: string },
) {
  const navHistoryRef = useRef<{ stepIndex: number; frameId: string }[]>([]);
  const navPtrRef = useRef(-1);

  const navigateTo = useCallback((stepIndex: number, frameId: string) => {
    const newHist = [...navHistoryRef.current.slice(0, navPtrRef.current + 1), { stepIndex, frameId }];
    navHistoryRef.current = newHist;
    navPtrRef.current = newHist.length - 1;
    const store = useDebugStore.getState();
    const syncPayload: Parameters<typeof store.sync>[0] = {
      canNavBack: newHist.length - 1 > 0,
      canNavForward: false,
      activeTab: frameId,
    };
    if (store.hiddenFrameIds.has(frameId)) {
      const next = new Set(store.hiddenFrameIds);
      next.delete(frameId);
      syncPayload.hiddenFrameIds = next;
    }
    store.sync(syncPayload);
    seekTo(stepIndex);
  }, [seekTo]);

  const seekToWithHistory = useCallback((stepIndex: number) => {
    const frameId = activeTabRef.current;
    const newHist = [...navHistoryRef.current.slice(0, navPtrRef.current + 1), { stepIndex, frameId }];
    navHistoryRef.current = newHist;
    navPtrRef.current = newHist.length - 1;
    useDebugStore.getState().sync({
      canNavBack: newHist.length - 1 > 0,
      canNavForward: false,
    });
    seekTo(stepIndex);
  }, [seekTo, activeTabRef]);

  const navBack = useCallback(() => {
    const ptr = navPtrRef.current;
    if (ptr <= 0) return;
    const entry = navHistoryRef.current[ptr - 1];
    navPtrRef.current = ptr - 1;
    useDebugStore.getState().sync({
      canNavBack: ptr - 1 > 0,
      canNavForward: true,
      activeTab: entry.frameId,
    });
    seekTo(entry.stepIndex);
  }, [seekTo]);

  const navForward = useCallback(() => {
    const ptr = navPtrRef.current;
    const hist = navHistoryRef.current;
    if (ptr >= hist.length - 1) return;
    const entry = hist[ptr + 1];
    navPtrRef.current = ptr + 1;
    useDebugStore.getState().sync({
      canNavBack: true,
      canNavForward: ptr + 1 < hist.length - 1,
      activeTab: entry.frameId,
    });
    seekTo(entry.stepIndex);
  }, [seekTo]);

  const handleSelectFrame = useCallback((id: string) => {
    const { activeTab, tabHistory, hiddenFrameIds, sync } = useDebugStore.getState();
    const syncPayload: Parameters<typeof sync>[0] = {
      tabHistory: [...tabHistory, activeTab],
      activeTab: id,
    };
    if (hiddenFrameIds.has(id)) {
      const next = new Set(hiddenFrameIds);
      next.delete(id);
      syncPayload.hiddenFrameIds = next;
    }
    sync(syncPayload);
  }, []);

  const handleGoBack = useCallback(() => {
    const { tabHistory, sync } = useDebugStore.getState();
    if (tabHistory.length === 0) return;
    const prev = tabHistory[tabHistory.length - 1];
    sync({ tabHistory: tabHistory.slice(0, -1), activeTab: prev });
  }, []);

  const resetNav = useCallback(() => {
    navHistoryRef.current = [];
    navPtrRef.current = -1;
    useDebugStore.getState().sync({ canNavBack: false, canNavForward: false });
  }, []);

  return {
    navigateTo,
    seekToWithHistory,
    navBack,
    navForward,
    handleSelectFrame,
    handleGoBack,
    resetNav,
  };
}
