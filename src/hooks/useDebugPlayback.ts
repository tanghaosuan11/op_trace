import { useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ipcCommands } from "../lib/ipcConfig";
import type { StepData } from "../lib/stepPlayer";
import type { CallFrame } from "../lib/types";
import { OP_MAP } from "../lib/opcodes";

import { useDebugStore } from "../store/debugStore";

// CALL/CREATE 系列 opcode，Step Over 时整个子调用会被跳过
const CALL_OPCODES = new Set([0xF0, 0xF1, 0xF2, 0xF4, 0xF5, 0xFA]); // CREATE/CALL/CALLCODE/DELEGATECALL/CREATE2/STATICCALL

export interface StepFullData {
  step_index: number;
  context_id: number;
  pc: number;
  opcode: number;
  gas_cost: number;
  gas_remaining: number;
  stack: string[];
  memory: string;
}

export interface PlaybackRefs {
  allSteps: React.RefObject<StepData[]>;
  callFrames: React.RefObject<CallFrame[]>;
  currentStepIndex: React.RefObject<number>;
  activeTab: React.RefObject<string>;
  isPlaying: React.RefObject<boolean>;
  batchSize: React.RefObject<number>;
  breakOpcodes: React.RefObject<Set<number>>;
  breakpointPcs: React.RefObject<Map<string, Set<number>>>;
  conditionHitSet: React.RefObject<Set<number>>;
  stepIndexByContext: React.RefObject<Map<number, number[]>>;
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
  const { allSteps, callFrames, currentStepIndex, activeTab, isPlaying, batchSize, breakOpcodes, breakpointPcs, conditionHitSet, stepIndexByContext, opcodeIndex, fullDataCache } = refs;
  const { setCurrentStepIndex, setIsPlaying, setCallFrames, setActiveTab } = setters;

  // 查找下一个有效步骤（使用 Set 做 O(1) 查找，替代 .some() 的 O(N_frames)）
  const findValidStep = useCallback((startIndex: number, direction: 1 | -1): number | null => {
    let index = startIndex;
    const total = allSteps.current.length;
    const validCtx = new Set(callFrames.current.map(f => f.contextId));

    while (index >= 0 && index < total) {
      const step = allSteps.current[index];
      if (validCtx.has(step.contextId)) {
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
      frames: Array<{ context_id: number; pc: number; gas_cost: number; stack: string[]; memory: string }>;
    }>(ipcCommands.seekTo, { index, requestId: id })
      .then((result) => {
        if (result.request_id !== bgSeekIdRef.current) return;
        if (!isPlaying.current) return;
        // 更新 stack 和 memory，其余字段由 playNextStep 管理
        for (const frame of callFrames.current) {
          const st = result.frames.find(f => f.context_id === frame.contextId);
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
  }, [callFrames, activeTab, isPlaying]);

  // 将 frame 数据直接同步到 Zustand store
  // 桥接 useEffect 仅在 currentStepIndex/activeTab 改变时触发；
  // 暂停时两者可能都没变（上一批量播放已经设过相同值），必须绕过桥接直接写 store。
  const syncFrameToStore = useCallback((frame: CallFrame, idx: number) => {
    const logs = frame.logs;
    let logEnd = logs.length;
    if (logs.length > 0 && logs[logs.length - 1].stepIndex > idx) {
      let lo = 0, hi = logs.length - 1;
      logEnd = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (logs[mid].stepIndex <= idx) { logEnd = mid + 1; lo = mid + 1; }
        else hi = mid - 1;
      }
    }
    const rdList = frame.returnDataList ?? [];
    let returnData = "";
    for (let i = rdList.length - 1; i >= 0; i--) {
      if (rdList[i].stepIndex <= idx) { returnData = rdList[i].data; break; }
    }
    const { breakpointPcsMap } = useDebugStore.getState();
    useDebugStore.getState().sync({
      opcodes: frame.opcodes,
      stack: frame.stack,
      memory: frame.memory,
      currentPc: frame.currentPc ?? -1,
      currentGasCost: frame.currentGasCost ?? 0,
      storageChanges: frame.storageChanges,
      logs: logs.slice(0, logEnd),
      returnData,
      currentStepIndex: idx,
      breakpointPcs: breakpointPcsMap.get(frame.id) || new Set(),
      callType: frame.callType,
      callerAddress: frame.caller,
    });
  }, []);

  // 应用步骤到 UI - 优先读全量缓存，否则走 Rust seek_to
  const applyStep = useCallback((index: number) => {
    const step = allSteps.current[index];
    if (!step) return;

    const frames = callFrames.current;
    const targetFrame = frames.find(f => f.contextId === step.contextId);

    // ── 全量缓存路径（小步数模式，零 IPC）────────────────────────
    const cache = fullDataCache.current;
    if (cache && index < cache.length) {
      const entry = cache[index];
      // 只更新目标 frame 的 stack/memory/pc（其他 frame 保持上次 seek_to 状态）
      for (const frame of callFrames.current) {
        if (frame.contextId === entry.context_id) {
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

    // ── 大步数路径：Rust seek_to（原逻辑）────────────────────────
    // 发起 Rust seek_to 调用（异步，但 UI 先更新 index 和 tab）
    const requestId = ++seekIdRef.current;
    invoke<{
      request_id: number;
      active_context_id: number;
      frames: Array<{
        context_id: number;
        pc: number;
        gas_cost: number;
        stack: string[];
        memory: string;
      }>;
    }>(ipcCommands.seekTo, { index, requestId })
      .then((result) => {
        // 丢弃过期响应：只接受最新的 request_id
        if (result.request_id !== seekIdRef.current) return;

        // 用 Rust 返回的数据更新每个 frame
        const frameMap = new Map(result.frames.map(f => [f.context_id, f]));
        for (const frame of callFrames.current) {
          const state = frameMap.get(frame.contextId);
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
        const lastStepByFrame = new Map<number, StepData>();
        const stepIdx = stepIndexByContext.current;
        for (const frame of frames) {
          const indices = stepIdx.get(frame.contextId);
          if (!indices || indices.length === 0) continue;
          let lo = 0, hi = indices.length - 1, found = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (indices[mid] <= index) { found = indices[mid]; lo = mid + 1; }
            else hi = mid - 1;
          }
          if (found >= 0) lastStepByFrame.set(frame.contextId, allSteps.current[found]);
        }
        for (const frame of callFrames.current) {
          const lastStep = lastStepByFrame.get(frame.contextId);
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
  }, [allSteps, callFrames, currentStepIndex, stepIndexByContext, activeTab, syncFrameToStore, setActiveTab, setCurrentStepIndex, fullDataCache]);

  // 播放循环 - 所有依赖都通过 ref 读取，无闭包问题
  const playNextStep = useCallback(() => {
    if (!isPlaying.current) return;

    const { pauseOpJump, pauseCondJump } = useDebugStore.getState().config;
    let stepsExecuted = 0;
    let lastContextId: number | undefined;
    // 每批次预构建 contextId → 数组下标映射，O(N_frames) 一次，避免每步 find()
    const frameMap = new Map<number, number>(
      callFrames.current.map((f, idx) => [f.contextId, idx])
    );

    // ── 全量缓存模式：每步都走 applyStep（全量 stack/memory），batchSize 固定为 1 ──
    if (fullDataCache.current) {
      const from = currentStepIndex.current + 1;

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
        if (nearest !== -1) {
          const targetStep = allSteps.current[nearest];
          if (targetStep && frameMap.has(targetStep.contextId)) {
            isPlaying.current = false; setIsPlaying(false);
            applyStep(nearest);
            toast.info(`Paused on OpCode: ${OP_MAP[targetStep.opcode]?.name ?? "0x" + targetStep.opcode.toString(16)}`, { id: "pause-opcode" });
            return;
          }
        }
        // nearest === -1（无更多断点）或 frame 不在视图中：继续正常播放
      }

      // pauseCondJump: 直接跳到最近的 conditionHitSet 命中步骤
      if (pauseCondJump && conditionHitSet.current.size > 0) {
        let nearestCond = -1;
        for (const idx of conditionHitSet.current) {
          if (idx >= from && (nearestCond === -1 || idx < nearestCond)) nearestCond = idx;
        }
        if (nearestCond !== -1) {
          const targetStep = allSteps.current[nearestCond];
          if (targetStep && frameMap.has(targetStep.contextId)) {
            isPlaying.current = false; setIsPlaying(false);
            applyStep(nearestCond);
            const hit = useDebugStore.getState().scanHits.find(h => h.step_index === nearestCond);
            toast.info(`Paused: ${hit?.description ?? `step ${nearestCond}`}`, { id: "pause-cond" });
            return;
          }
        }
      }

      const total = allSteps.current.length;
      let nextIndex: number | null = null;
      for (let idx = from; idx < total; idx++) {
        if (frameMap.has(allSteps.current[idx].contextId)) { nextIndex = idx; break; }
      }
      if (nextIndex === null) {
        isPlaying.current = false;
        setIsPlaying(false);
        applyStep(currentStepIndex.current >= 0 ? currentStepIndex.current : 0);
        return;
      }
      const step = allSteps.current[nextIndex];
      // PC 断点
      if (step) {
        const fi = frameMap.get(step.contextId);
        if (fi !== undefined) {
          const frameBps = breakpointPcs.current.get(callFrames.current[fi].id);
          if (frameBps?.size && frameBps.has(step.pc)) {
            isPlaying.current = false; setIsPlaying(false); applyStep(nextIndex); return;
          }
        }
      }
      // 条件断点（逐步检查，仅在 pauseCondJump=false 时生效）
      if (!pauseCondJump && conditionHitSet.current.size > 0 && conditionHitSet.current.has(nextIndex)) {
        isPlaying.current = false; setIsPlaying(false);
        applyStep(nextIndex);
        const hit = useDebugStore.getState().scanHits.find(h => h.step_index === nextIndex);
        toast.info(`Paused: ${hit?.description ?? `step ${nextIndex}`}`, { id: "pause-cond" });
        return;
      }
      // 正常推进，走 applyStep 更新全量状态（会 setCurrentStepIndex 和 setActiveTab）
      applyStep(nextIndex);
      if (isPlaying.current) requestAnimationFrame(playNextStep);
      return;
    }

    // 如果有 breakOpcodes，用 opcodeIndex 二分查找直接跳到最近的目标步骤
    if (pauseOpJump && breakOpcodes.current.size > 0 && opcodeIndex.current.size > 0) {
      const from = currentStepIndex.current + 1;
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
      if (nearest !== -1) {
        // 验证该步骤属于可见 frame
        const targetStep = allSteps.current[nearest];
        if (targetStep && frameMap.has(targetStep.contextId)) {
          currentStepIndex.current = nearest;
          isPlaying.current = false;
          setIsPlaying(false);
          applyStep(nearest);
          toast.info(`Paused on OpCode: ${OP_MAP[targetStep.opcode]?.name ?? "0x" + targetStep.opcode.toString(16)}`, { id: "pause-opcode" });
          return;
        }
      }
      // nearest === -1（无更多断点）或 frame 不在视图中：继续批量播放到末尾
    }

    // pauseCondJump: 直接跳到最近的 conditionHitSet 命中步骤（批量模式）
    if (pauseCondJump && conditionHitSet.current.size > 0) {
      const from = currentStepIndex.current + 1;
      let nearestCond = -1;
      for (const idx of conditionHitSet.current) {
        if (idx >= from && (nearestCond === -1 || idx < nearestCond)) nearestCond = idx;
      }
      if (nearestCond !== -1) {
        const targetStep = allSteps.current[nearestCond];
        if (targetStep && frameMap.has(targetStep.contextId)) {
          currentStepIndex.current = nearestCond;
          isPlaying.current = false;
          setIsPlaying(false);
          applyStep(nearestCond);
          const hit = useDebugStore.getState().scanHits.find(h => h.step_index === nearestCond);
          toast.info(`Paused: ${hit?.description ?? `step ${nearestCond}`}`, { id: "pause-cond" });
          return;
        }
      }
    }

    // 批量执行 - 从 ref 读取 batchSize
    // 内联 findValidStep 逻辑，直接用 frameMap 做 O(1) contextId 查找
    const total = allSteps.current.length;
    for (let i = 0; i < batchSize.current; i++) {
      // 内联 findValidStep（正向）：直接用 frameMap.has() 替代 .some()
      let nextIndex: number | null = null;
      for (let idx = currentStepIndex.current + 1; idx < total; idx++) {
        if (frameMap.has(allSteps.current[idx].contextId)) {
          nextIndex = idx;
          break;
        }
      }

      if (nextIndex === null) {
        isPlaying.current = false;
        setIsPlaying(false);
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
          isPlaying.current = false;
          setIsPlaying(false);
          applyStep(nextIndex);
          toast.info(`Paused on OpCode: ${OP_MAP[step.opcode]?.name ?? "0x" + step.opcode.toString(16)}`, { id: "pause-opcode" });
          return;
        }

        // 命中 PC 断点时停止播放
        const pcBpFrameIdx = frameMap.get(step.contextId);
        if (pcBpFrameIdx !== undefined) {
          const frameBps = breakpointPcs.current.get(callFrames.current[pcBpFrameIdx].id);
          if (frameBps && frameBps.size > 0 && frameBps.has(step.pc)) {
            isPlaying.current = false;
            setIsPlaying(false);
            applyStep(nextIndex);
            // toast.info(`Paused at BreakPoint ${step.pc}`, { id: "pause-pc" });
            return;
          }
        }

        // 命中条件断点时停止播放（O(1) 查找，仅在 pauseCondJump=false 时生效）
        if (!pauseCondJump && conditionHitSet.current.size > 0 && conditionHitSet.current.has(nextIndex)) {
          isPlaying.current = false;
          setIsPlaying(false);
          applyStep(nextIndex);
          // 从 store 的 scanHits 中找到描述
          const hit = useDebugStore.getState().scanHits.find(h => h.step_index === nextIndex);
          const desc = hit?.description ?? `step ${nextIndex}`;
          toast.info(`Paused: ${desc}`, { id: "pause-cond" });
          return;
        }

        // 原地修改 frame，避免每步 map()+spread 分配
        const stepFi = frameMap.get(step.contextId);
        if (stepFi !== undefined) {
          const frame = callFrames.current[stepFi];
          frame.currentPc = step.pc;
          frame.currentGasCost = step.gasCost;
          lastContextId = step.contextId;
        }
        stepsExecuted++;
      }
    }

    // 批量完成后一次性更新 UI
    if (stepsExecuted > 0 && lastContextId !== undefined) {
      const lastTargetFrame = callFrames.current[frameMap.get(lastContextId)!];
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
  }, [isPlaying, batchSize, breakOpcodes, breakpointPcs, opcodeIndex, allSteps, callFrames, currentStepIndex, activeTab, setIsPlaying, setCurrentStepIndex, setCallFrames, setActiveTab, applyStep, bgRefreshStack, conditionHitSet, fullDataCache]);

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
        const frame = callFrames.current.find(f => f.contextId === step.contextId)
                   || callFrames.current.find(f => f.id === activeTab.current);
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
    // 是子调用：向后找第一个回到当前 contextId 的 step
    const total = allSteps.current.length;
    for (let i = cur + 1; i < total; i++) {
      if (allSteps.current[i].contextId === curStep.contextId) {
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
    // 找当前 frame 的 parentId
    const curFrame = callFrames.current.find(f => f.contextId === curContextId);
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
      if (allSteps.current[i].contextId === parentContextId) {
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
      // 如果已经到末尾，从头开始
      if (currentStepIndex.current >= allSteps.current.length - 1) {
        currentStepIndex.current = -1;
        setCurrentStepIndex(-1);
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
