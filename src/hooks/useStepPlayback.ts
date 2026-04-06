import { useCallback, useEffect, type RefObject } from "react";
import { toast } from "sonner";
import { useDebugStore } from "@/store/debugStore";
import { frameTabId } from "@/lib/frameScope";
import { extractStepIndicesFromAnalysisResult } from "@/lib/analysisResultStepIndices";
import type { StepData } from "@/lib/stepPlayer";

const TOAST_REPLACE_OK = "step-playback-replace-ok";
const TOAST_REPLACE_EMPTY = "step-playback-replace-empty";

const AUTO_ADVANCE_MS = 450;

/**
 * 步数队列播放：跳转、自动连播、从分析结果追加队列。
 */
export function useStepPlayback(
  navigateTo: (stepIndex: number, frameId: string) => void,
  allStepsRef: RefObject<StepData[]>,
) {
  const stepPlaybackSeek = useCallback(
    (globalStep: number) => {
      const all = allStepsRef.current;
      if (globalStep < 0 || globalStep >= all.length) return;
      const s = all[globalStep];
      navigateTo(globalStep, frameTabId(s.transactionId, s.contextId));
    },
    [navigateTo, allStepsRef],
  );

  const advanceStepQueueOnce = useCallback(() => {
    const sync = useDebugStore.getState().sync;
    const q = useDebugStore.getState().stepPlaybackQueue;
    const c = useDebugStore.getState().stepPlaybackCursor;
    if (q.length === 0) {
      sync({ isStepPlaybackAutoPlaying: false });
      return;
    }
    if (c >= q.length - 1) {
      sync({ isStepPlaybackAutoPlaying: false });
      return;
    }
    const nextC = c + 1;
    sync({ stepPlaybackCursor: nextC });
    stepPlaybackSeek(q[nextC]);
  }, [stepPlaybackSeek]);

  const isStepPlaybackAutoPlaying = useDebugStore((s) => s.isStepPlaybackAutoPlaying);
  useEffect(() => {
    if (!isStepPlaybackAutoPlaying) return;
    const id = window.setInterval(() => {
      advanceStepQueueOnce();
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(id);
  }, [isStepPlaybackAutoPlaying, advanceStepQueueOnce]);

  const onStepPlaybackLast = useCallback(() => {
    const sync = useDebugStore.getState().sync;
    const q = useDebugStore.getState().stepPlaybackQueue;
    if (q.length === 0) return;
    let c = useDebugStore.getState().stepPlaybackCursor;
    if (c <= 0) c = 0;
    else c -= 1;
    sync({ isStepPlaybackAutoPlaying: false, stepPlaybackCursor: c });
    stepPlaybackSeek(q[c]);
  }, [stepPlaybackSeek]);

  const onStepPlaybackNext = useCallback(() => {
    const sync = useDebugStore.getState().sync;
    const q = useDebugStore.getState().stepPlaybackQueue;
    if (q.length === 0) return;
    let c = useDebugStore.getState().stepPlaybackCursor;
    if (c >= q.length - 1) c = q.length - 1;
    else c += 1;
    sync({ isStepPlaybackAutoPlaying: false, stepPlaybackCursor: c });
    stepPlaybackSeek(q[c]);
  }, [stepPlaybackSeek]);

  const toggleStepQueueAutoPlay = useCallback(() => {
    const sync = useDebugStore.getState().sync;
    const st = useDebugStore.getState();
    if (st.isStepPlaybackAutoPlaying) {
      sync({ isStepPlaybackAutoPlaying: false });
      return;
    }
    if (st.stepPlaybackQueue.length === 0) return;
    sync({ isStepPlaybackAutoPlaying: true });
  }, []);

  const onStepPlaybackBarClose = useCallback(() => {
    useDebugStore.getState().sync({
      isStepPlaybackBarVisible: false,
      isStepPlaybackAutoPlaying: false,
    });
  }, []);

  /** 用分析结果中的 step 下标整表替换队列（清空再写入），并打开浮动条、停自动播 */
  const replacePlaybackQueueFromAnalysisResult = useCallback((resultText: string) => {
    const indices = extractStepIndicesFromAnalysisResult(resultText);
    const sc = useDebugStore.getState().stepCount;
    const valid = indices.filter((i) => i >= 0 && i < sc);
    if (valid.length === 0) {
      toast.info("No valid stepIndex / global_step in result", {
        id: TOAST_REPLACE_EMPTY,
      });
      return;
    }
    useDebugStore.getState().sync({
      stepPlaybackQueue: valid,
      stepPlaybackCursor: 0,
      isStepPlaybackBarVisible: true,
      isStepPlaybackAutoPlaying: false,
    });
    toast.success(`Playback queue set to ${valid.length} step(s)`, {
      id: TOAST_REPLACE_OK,
    });
  }, []);

  return {
    stepPlaybackSeek,
    onStepPlaybackLast,
    onStepPlaybackNext,
    toggleStepQueueAutoPlay,
    onStepPlaybackBarClose,
    replacePlaybackQueueFromAnalysisResult,
  };
}
