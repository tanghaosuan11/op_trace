import { useCallback, useRef } from "react";
import { invoke } from "@/lib/ipc-bridge";
import { toast } from "sonner";
import { ipcCommands } from "../lib/ipcConfig";
import type { StepData } from "../lib/stepPlayer";
import type { CallFrame } from "../lib/types";
import { frameScopeKeyFromFrame, frameScopeKeyFromStep } from "../lib/frameScope";
import { OP_MAP } from "../lib/opcodes";
import { syncFrameProjectionToStore } from "@/lib/frameProjection";

import { useDebugStore } from "../store/debugStore";

// CALL/CREATE 系列 opcode，Step Over 时整个子调用会被跳过
const CALL_OPCODES = new Set([0xF0, 0xF1, 0xF2, 0xF4, 0xF5, 0xFA]); // CREATE/CALL/CALLCODE/DELEGATECALL/CREATE2/STATICCALL

export interface StepFullData {
  step_index: number;
  transaction_id: number;
  context_id: number;
  pc: number;
  opcode: number;
  gas_cost: number;
  gas_remaining: number;
  stack: string[];
  memory: string;
}

export interface PlaybackRefs {
  sessionId: React.RefObject<string>;
  allSteps: React.RefObject<StepData[]>;
  callFrames: React.RefObject<CallFrame[]>;
  currentStepIndex: React.RefObject<number>;
  activeTab: React.RefObject<string>;
  isPlaying: React.RefObject<boolean>;
  batchSize: React.RefObject<number>;
  breakOpcodes: React.RefObject<Set<number>>;
  breakpointPcs: React.RefObject<Map<string, Set<number>>>;
  conditionHitSet: React.RefObject<Set<number>>;
  stepIndexByContext: React.RefObject<Map<string, number[]>>;
  opcodeIndex: React.RefObject<Map<number, number[]>>;
  fullDataCache: React.RefObject<StepFullData[] | null>;
}

export interface PlaybackSetters {
  setCurrentStepIndex: (index: number) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setCallFrames: React.Dispatch<React.SetStateAction<CallFrame[]>>;
  setActiveTab: (tabId: string) => void;
}

export function useDebugPlayback(
  refs: PlaybackRefs,
  setters: PlaybackSetters
) {
  const { sessionId, allSteps, callFrames, currentStepIndex, activeTab, isPlaying, batchSize, breakOpcodes, breakpointPcs, stepIndexByContext, opcodeIndex, fullDataCache } = refs;
  const { setCurrentStepIndex, setIsPlaying, setCallFrames, setActiveTab } = setters;

  // 查找下一个有效步骤（使用 Set 做 O(1) 查找，替代 .some() 的 O(N_frames)）
  const findValidStep = useCallback((startIndex: number, direction: 1 | -1): number | null => {
    let index = startIndex;
    const total = allSteps.current.length;
    const validCtx = new Set(callFrames.current.map(f => frameScopeKeyFromFrame(f)));

    while (index >= 0 && index < total) {
      const step = allSteps.current[index];
      if (validCtx.has(frameScopeKeyFromStep(step))) {
        return index;
      }
      index += direction;
    }
    return null;
  }, [allSteps, callFrames]);

  // 递增的 request ID，用于丢弃过期的 seek_to 响应
  const seekIdRef = useRef(0);

  // 播放中后台刷新 stack 用的独立 ID（不影响 seekIdRef）
  const bgSeekIdRef = useRef(0);
  const bgSeekTimeRef = useRef(0);
  const BG_SEEK_INTERVAL = 100; // ms，播放中每 100ms 从 Rust 刷新一次 stack

  // 播放中后台刷新 stack（只更新 stack，不改变 currentStepIndex）
  const bgRefreshStack = useCallback((index: number) => {
    const now = performance.now();
    if (now - bgSeekTimeRef.current < BG_SEEK_INTERVAL) return;
    bgSeekTimeRef.current = now;
    const id = ++bgSeekIdRef.current;
    invoke<{
      request_id: number;
      active_context_id: number;
      active_transaction_id?: number;
      frames: Array<{ transaction_id: number; context_id: number; pc: number; gas_cost: number; stack: string[]; memory: string }>;
    }>(ipcCommands.seekTo, { index, requestId: id, sessionId: sessionId.current })
      .then((result) => {
        if (result.request_id !== bgSeekIdRef.current) return;
        if (!isPlaying.current) return;
        // 更新 stack 和 memory，其余字段由 playNextStep 管理
        for (const frame of callFrames.current) {
          const st = result.frames.find(
            f =>
              f.context_id === frame.contextId &&
              f.transaction_id === (frame.transactionId ?? 0),
          );
          if (st) {
            frame.stack = st.stack;
            frame.memory = st.memory;
          }
        }
        const activeFrame = callFrames.current.find(f => f.id === activeTab.current);
        if (activeFrame) {
          useDebugStore.getState().sync({ stack: activeFrame.stack, memory: activeFrame.memory });
        }
      })
      .catch(() => { /* session 尚未就绪，静默忽略 */ });
  }, [callFrames, activeTab, isPlaying, sessionId]);

  // 将 frame 数据同步到 store。播放时可直接调用，避免等待投影 effect。
  const syncFrameToStore = useCallback((frame: CallFrame, idx: number) => {
    syncFrameProjectionToStore(frame, idx);
  }, []);

  // 应用步骤到 UI - 优先读全量缓存，否则走 Rust seek_to
  const applyStep = useCallback((index: number) => {
    const step = allSteps.current[index];
    if (!step) return;

    const frames = callFrames.current;
    const targetFrame = frames.find(
      f =>
        f.contextId === step.contextId &&
        (f.transactionId ?? 0) === step.transactionId,
    );

    const cache = fullDataCache.current;
    if (cache && index < cache.length) {
      const entry = cache[index];
      // 只更新目标 frame 的 stack/memory/pc（其他 frame 保持上次 seek_to 状态）
      for (const frame of callFrames.current) {
        if (
          frame.contextId === entry.context_id &&
          (frame.transactionId ?? 0) === entry.transaction_id
        ) {
          frame.currentPc = entry.pc;
          frame.stack = entry.stack;
          frame.currentGasCost = entry.gas_cost;
          frame.memory = entry.memory;
        }
      }
      const syncFrame = callFrames.current.find(f => f.id === (targetFrame?.id ?? activeTab.current));
      if (syncFrame) syncFrameToStore(syncFrame, index);
      currentStepIndex.current = index;
      setCurrentStepIndex(index);
      if (targetFrame) setActiveTab(targetFrame.id);
      return;
    }

    // 发起 Rust seek_to 调用（异步，但 UI 先更新 index 和 tab）
    const requestId = ++seekIdRef.current;
    invoke<{
      request_id: number;
      active_context_id: number;
      active_transaction_id?: number;
      frames: Array<{
        transaction_id: number;
        context_id: number;
        pc: number;
        gas_cost: number;
        stack: string[];
        memory: string;
      }>;
    }>(ipcCommands.seekTo, { index, requestId, sessionId: sessionId.current })
      .then((result) => {
        // 丢弃过期响应：只接受最新的 request_id
        if (result.request_id !== seekIdRef.current) return;

        // 用 Rust 返回的数据更新每个 frame
        const frameMap = new Map(
          result.frames.map(f => [`${f.transaction_id}:${f.context_id}`, f] as const),
        );
        for (const frame of callFrames.current) {
          const state = frameMap.get(`${frame.transactionId ?? 0}:${frame.contextId}`);
          if (state) {
            frame.currentPc = state.pc;
            frame.stack = state.stack;
            frame.currentGasCost = state.gas_cost;
            frame.memory = state.memory;
          } else {
            frame.currentPc = frame.opcodes[0]?.pc;
            frame.stack = [];
            frame.memory = "0x";
          }
        }

        // 直接写 store（桥接 useEffect 可能因 currentStepIndex/activeTab 未变而不触发，
        // 例如暂停时 index 与上一批播放设置的值相同）
        const syncFrame = callFrames.current.find(f => f.id === (targetFrame?.id ?? activeTab.current));
        if (syncFrame) syncFrameToStore(syncFrame, index);

        currentStepIndex.current = index;
        setCurrentStepIndex(index);
        if (targetFrame) {
          setActiveTab(targetFrame.id);
        }
      })
      .catch((_err) => {
        // seek_to 失败时 fallback 到 JS 计算（EVM 执行中 session 还没存）
        const lastStepByFrame = new Map<string, StepData>();
        const stepIdx = stepIndexByContext.current;
        for (const frame of frames) {
          const indices = stepIdx.get(frameScopeKeyFromFrame(frame));
          if (!indices || indices.length === 0) continue;
          let lo = 0, hi = indices.length - 1, found = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (indices[mid] <= index) { found = indices[mid]; lo = mid + 1; }
            else hi = mid - 1;
          }
          if (found >= 0) lastStepByFrame.set(frameScopeKeyFromFrame(frame), allSteps.current[found]);
        }
        for (const frame of callFrames.current) {
          const lastStep = lastStepByFrame.get(frameScopeKeyFromFrame(frame));
          if (lastStep) {
            frame.currentPc = lastStep.pc;
            frame.currentGasCost = lastStep.gasCost;
            // stack/memory 不在 StepData 中存储，fallback 时置空（Rust session 就绪后用 seek_to）
          } else {
            frame.currentPc = frame.opcodes[0]?.pc;
            frame.stack = [];
            frame.memory = "0x";
          }
        }

        const syncFrame = callFrames.current.find(f => f.id === (targetFrame?.id ?? activeTab.current));
        if (syncFrame) syncFrameToStore(syncFrame, index);

        currentStepIndex.current = index;
        setCurrentStepIndex(index);
        if (targetFrame) {
          setActiveTab(targetFrame.id);
        }
      });

    // 仅更新 ref（不触发 Zustand 状态更新和桥接 useEffect，
    //   等 IPC 返回 fresh frame data 后再由 .then()/.catch() 触发）
    currentStepIndex.current = index;
  }, [allSteps, callFrames, currentStepIndex, stepIndexByContext, activeTab, syncFrameToStore, setActiveTab, setCurrentStepIndex, fullDataCache, sessionId]);

  // 播放循环 - 所有依赖都通过 ref 读取，无闭包问题
  const playNextStep = useCallback(() => {
    if (!isPlaying.current) return;

    const storeState = useDebugStore.getState();
    const { pauseOpJump } = storeState.config;
    const { rangeEnabled, rangeStart, rangeEnd } = storeState;
    let stepsExecuted = 0;
    let lastScopeKey: string | undefined;
    // 每批次预构建 (transactionId:contextId) → 数组下标映射，O(N_frames) 一次，避免每步 find()
    const frameMap = new Map<string, number>(
      callFrames.current.map((f, idx) => [frameScopeKeyFromFrame(f), idx]),
    );
    // 范围模式上界（exclusive）
    const rangeUpper = rangeEnabled ? Math.min(rangeEnd + 1, allSteps.current.length) : allSteps.current.length;

    if (fullDataCache.current) {
      const from = rangeEnabled ? Math.max(currentStepIndex.current + 1, rangeStart) : currentStepIndex.current + 1;

      // 有 breakOpcodes + opcodeIndex 时，直接二分跳（同非缓存路径）
      if (pauseOpJump && breakOpcodes.current.size > 0 && opcodeIndex.current.size > 0) {
        let nearest = -1;
        for (const op of breakOpcodes.current) {
          const arr = opcodeIndex.current.get(op);
          if (!arr || arr.length === 0) continue;
          let lo = 0, hi = arr.length - 1, found = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (arr[mid] >= from) { found = arr[mid]; hi = mid - 1; }
            else lo = mid + 1;
          }
          if (found !== -1 && (nearest === -1 || found < nearest)) nearest = found;
        }
        if (rangeEnabled && nearest > rangeEnd) nearest = -1;
        if (nearest !== -1) {
          const targetStep = allSteps.current[nearest];
          if (targetStep && frameMap.has(frameScopeKeyFromStep(targetStep))) {
            stopPlaying();
            applyStep(nearest);
            toast.info(`Paused on OpCode: ${OP_MAP[targetStep.opcode]?.name ?? "0x" + targetStep.opcode.toString(16)}`, { id: "pause-opcode" });
            return;
          }
        }
        // nearest === -1（无更多断点）或 frame 不在视图中：继续正常播放
      }

      let nextIndex: number | null = null;
      for (let idx = from; idx < rangeUpper; idx++) {
        if (frameMap.has(frameScopeKeyFromStep(allSteps.current[idx]))) { nextIndex = idx; break; }
      }
      if (nextIndex === null) {
        stopPlaying();
        applyStep(currentStepIndex.current >= 0 ? currentStepIndex.current : 0);
        return;
      }
      const step = allSteps.current[nextIndex];
      // PC 断点
      if (step) {
        const fi = frameMap.get(frameScopeKeyFromStep(step));
        if (fi !== undefined) {
          const frameBps = breakpointPcs.current.get(callFrames.current[fi].id);
          if (frameBps?.size && frameBps.has(step.pc)) {
            stopPlaying();
            applyStep(nextIndex);
            return;
          }
        }
      }
      // 正常推进，走 applyStep 更新全量状态（会 setCurrentStepIndex 和 setActiveTab）
      applyStep(nextIndex);
      if (isPlaying.current) requestAnimationFrame(playNextStep);
      return;
    }

    // 如果有 breakOpcodes，用 opcodeIndex 二分查找直接跳到最近的目标步骤
    if (pauseOpJump && breakOpcodes.current.size > 0 && opcodeIndex.current.size > 0) {
      const from = rangeEnabled ? Math.max(currentStepIndex.current + 1, rangeStart) : currentStepIndex.current + 1;
      let nearest = -1;
      for (const op of breakOpcodes.current) {
        const arr = opcodeIndex.current.get(op);
        if (!arr || arr.length === 0) continue;
        // 二分找第一个 >= from 的值
        let lo = 0, hi = arr.length - 1, found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          if (arr[mid] >= from) { found = arr[mid]; hi = mid - 1; }
          else lo = mid + 1;
        }
        if (found !== -1 && (nearest === -1 || found < nearest)) nearest = found;
      }
      if (rangeEnabled && nearest > rangeEnd) nearest = -1;
      if (nearest !== -1) {
        // 验证该步骤属于可见 frame
        const targetStep = allSteps.current[nearest];
        if (targetStep && frameMap.has(frameScopeKeyFromStep(targetStep))) {
          currentStepIndex.current = nearest;
          stopPlaying();
          applyStep(nearest);
          toast.info(`Paused on OpCode: ${OP_MAP[targetStep.opcode]?.name ?? "0x" + targetStep.opcode.toString(16)}`, { id: "pause-opcode" });
          return;
        }
      }
      // nearest === -1（无更多断点）或 frame 不在视图中：继续批量播放到末尾
    }

    // 批量执行 - 从 ref 读取 batchSize
    // 内联 findValidStep：用 frameMap（scope = transactionId:contextId）做 O(1) 查找
    for (let i = 0; i < batchSize.current; i++) {
      // 内联 findValidStep（正向）：直接用 frameMap.has() 替代 .some()
      let nextIndex: number | null = null;
      for (let idx = currentStepIndex.current + 1; idx < rangeUpper; idx++) {
        if (frameMap.has(frameScopeKeyFromStep(allSteps.current[idx]))) {
          nextIndex = idx;
          break;
        }
      }

      if (nextIndex === null) {
        stopPlaying();
        // 到末尾时通过 applyStep 获取完整 stack/memory
        if (currentStepIndex.current >= 0) {
          applyStep(currentStepIndex.current);
        }
        break;
      }

      currentStepIndex.current = nextIndex;
      const step = allSteps.current[nextIndex];

      if (step) {
        // 命中断点 opcode（fallback，opcodeIndex 未就绪时）
        if (breakOpcodes.current.size > 0 && breakOpcodes.current.has(step.opcode)) {
          stopPlaying();
          applyStep(nextIndex);
          toast.info(`Paused on OpCode: ${OP_MAP[step.opcode]?.name ?? "0x" + step.opcode.toString(16)}`, { id: "pause-opcode" });
          return;
        }

        // 命中 PC 断点时停止播放
        const pcBpFrameIdx = frameMap.get(frameScopeKeyFromStep(step));
        if (pcBpFrameIdx !== undefined) {
          const frameBps = breakpointPcs.current.get(callFrames.current[pcBpFrameIdx].id);
          if (frameBps && frameBps.size > 0 && frameBps.has(step.pc)) {
            stopPlaying();
            applyStep(nextIndex);
            // toast.info(`Paused at BreakPoint ${step.pc}`, { id: "pause-pc" });
            return;
          }
        }

        // 原地修改 frame，避免每步 map()+spread 分配
        const stepFi = frameMap.get(frameScopeKeyFromStep(step));
        if (stepFi !== undefined) {
          const frame = callFrames.current[stepFi];
          frame.currentPc = step.pc;
          frame.currentGasCost = step.gasCost;
          lastScopeKey = frameScopeKeyFromStep(step);
        }
        stepsExecuted++;
      }
    }

    // 批量完成后一次性更新 UI
    if (stepsExecuted > 0 && lastScopeKey !== undefined) {
      const lastTargetFrame = callFrames.current[frameMap.get(lastScopeKey)!];
      const needsTabSwitch = lastTargetFrame && activeTab.current !== lastTargetFrame.id;

      setCurrentStepIndex(currentStepIndex.current);
      setCallFrames([...callFrames.current]);

      // 节流后台 seek，每 500ms 从 Rust 刷新一次 stack（不影响 currentStepIndex）
      bgRefreshStack(currentStepIndex.current);

      if (needsTabSwitch) {
        setActiveTab(lastTargetFrame!.id);
        activeTab.current = lastTargetFrame!.id;
      }
    }

    if (isPlaying.current) {
      requestAnimationFrame(playNextStep);
    }
  }, [isPlaying, batchSize, breakOpcodes, breakpointPcs, opcodeIndex, allSteps, callFrames, currentStepIndex, activeTab, setCurrentStepIndex, setCallFrames, setActiveTab, applyStep, bgRefreshStack, fullDataCache]);

  // 开始播放
  const startPlaying = useCallback(() => {
    console.log(`开始播放，当前索引: ${currentStepIndex.current}, 总步数: ${allSteps.current.length}`);
    isPlaying.current = true;
    setIsPlaying(true);
    playNextStep();
  }, [isPlaying, currentStepIndex, allSteps, setIsPlaying, playNextStep]);

  // 暂停播放
  const stopPlaying = useCallback(() => {
    console.log("暂停播放");
    isPlaying.current = false;
    setIsPlaying(false);

    const idx = currentStepIndex.current;
    if (idx >= 0 && idx < allSteps.current.length) {
      // 立即用 JS 端已有数据刷一次 store（PC/memory 是实时的，stack 是 bgRefresh 最近结果）
      // 避免用户暂停后等 seek_to IPC 返回期间看到陈旧界面
      const step = allSteps.current[idx];
      if (step) {
        const frame = callFrames.current.find(
          f =>
            f.contextId === step.contextId &&
            (f.transactionId ?? 0) === step.transactionId,
        ) || callFrames.current.find(f => f.id === activeTab.current);
        if (frame) syncFrameToStore(frame, idx);
      }
      // 再发起 seek_to 获取精确 stack，返回后覆盖
      applyStep(idx);
    }
  }, [isPlaying, currentStepIndex, allSteps, callFrames, activeTab, setIsPlaying, applyStep, syncFrameToStore]);

  // 单步前进
  const stepForward = useCallback(() => {
    stopPlaying();
    const next = findValidStep(currentStepIndex.current + 1, 1);
    if (next !== null) applyStep(next);
  }, [stopPlaying, findValidStep, currentStepIndex, applyStep]);

  // 单步后退
  const stepBackward = useCallback(() => {
    stopPlaying();
    const prev = findValidStep(currentStepIndex.current - 1, -1);
    if (prev !== null) applyStep(prev);
  }, [stopPlaying, findValidStep, currentStepIndex, applyStep]);

  // Step Over：如果当前指令是 CALL/CREATE 系列，跳过整个子调用，停在同一 frame 的下一步
  // 如果当前指令不是子调用指令，等同于 stepForward
  const stepOver = useCallback(() => {
    stopPlaying();
    const cur = currentStepIndex.current;
    const curStep = allSteps.current[cur];
    if (!curStep || !CALL_OPCODES.has(curStep.opcode)) {
      // 非子调用指令，等同于 stepForward
      const next = findValidStep(cur + 1, 1);
      if (next !== null) applyStep(next);
      return;
    }
    // 是子调用：向后找第一个回到当前 frame（同笔同 context）的 step
    const total = allSteps.current.length;
    for (let i = cur + 1; i < total; i++) {
      const s = allSteps.current[i];
      if (
        s.contextId === curStep.contextId &&
        s.transactionId === curStep.transactionId
      ) {
        applyStep(i);
        return;
      }
    }
    // 子调用是最后一个，已到末尾，停在末尾
    const last = findValidStep(total - 1, -1);
    if (last !== null) applyStep(last);
  }, [stopPlaying, findValidStep, currentStepIndex, allSteps, applyStep]);

  // Step Out：跑完当前 frame 剩余部分，回到父 frame 的下一步
  const stepOut = useCallback(() => {
    stopPlaying();
    const cur = currentStepIndex.current;
    const curStep = allSteps.current[cur];
    if (!curStep) return;
    const curContextId = curStep.contextId;
    const curTid = curStep.transactionId;
    const curFrame = callFrames.current.find(
      f =>
        f.contextId === curContextId &&
        (f.transactionId ?? 0) === curTid,
    );
    const parentContextId = curFrame?.parentId;
    if (parentContextId === undefined) {
      // 已在根 frame，找 allSteps 末尾
      const last = findValidStep(allSteps.current.length - 1, -1);
      if (last !== null) applyStep(last);
      return;
    }
    // 向后找第一个属于父 frame 的 step
    const total = allSteps.current.length;
    for (let i = cur + 1; i < total; i++) {
      const s = allSteps.current[i];
      if (s.contextId === parentContextId && s.transactionId === curTid) {
        applyStep(i);
        return;
      }
    }
    // 父 frame 后续没有步骤（子调用是最后部分），停在末尾
    const last = findValidStep(total - 1, -1);
    if (last !== null) applyStep(last);
  }, [stopPlaying, findValidStep, currentStepIndex, allSteps, callFrames, applyStep]);

  // Continue/Pause
  const togglePlayback = useCallback(() => {
    console.log(
      "togglePlayback 被调用, isPlaying:", isPlaying.current,
      "currentIndex:", currentStepIndex.current,
      "total:", allSteps.current.length
    );
    if (isPlaying.current) {
      stopPlaying();
    } else {
      const { rangeEnabled: re, rangeStart: rs, rangeEnd: rEnd } = useDebugStore.getState();
      const atEnd = re
        ? currentStepIndex.current >= rEnd
        : currentStepIndex.current >= allSteps.current.length - 1;
      if (atEnd) {
        const resetTo = re ? rs - 1 : -1;
        currentStepIndex.current = resetTo;
        setCurrentStepIndex(resetTo);
        setTimeout(startPlaying, 0);
      } else {
        startPlaying();
      }
    }
  }, [isPlaying, currentStepIndex, allSteps, setCurrentStepIndex, stopPlaying, startPlaying]);

  // 跳转到指定步骤
  const seekTo = useCallback((targetIndex: number) => {
    stopPlaying();
    const validIndex = findValidStep(targetIndex, 1) ?? findValidStep(targetIndex - 1, -1);
    if (validIndex !== null) applyStep(validIndex);
  }, [stopPlaying, findValidStep, applyStep]);

  // 重置播放状态
  const reset = useCallback(() => {
    isPlaying.current = false;
    currentStepIndex.current = -1;
  }, [isPlaying, currentStepIndex]);

  return {
    applyStep,
    stepForward,
    stepBackward,
    stepOver,
    stepOut,
    togglePlayback,
    seekTo,
    reset,
  };
}
