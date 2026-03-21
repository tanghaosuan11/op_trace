import { invoke, Channel } from "@tauri-apps/api/core";
import { useDebugStore } from "@/store/debugStore";
import { useForkStore } from "@/store/forkStore";
import { fetchTxInfo } from "./txFetcher";
import {
  handleMessage,
  resetPendingFrameEnters,
} from "./messageHandlers";
import type { CallFrame, CallTreeNode, MessageHandlerContext } from "./types";
import { type StepData } from "./stepPlayer";
import { getSelectedChain } from "./rpcConfig";
import { getBackendConfig } from "./appConfig";
import { ipcCommands } from "./ipcConfig";

/* ── fetchTxAction ── 纯 store 驱动，无外部依赖 ──────────────── */

export async function fetchTxAction() {
  const { tx, sync } = useDebugStore.getState();

  if (!tx) {
    sync({ txError: "请输入交易哈希" });
    return;
  }

  let txHash = tx.trim();
  if (!txHash.startsWith("0x")) {
    txHash = "0x" + txHash;
  }

  if (txHash.length !== 66) {
    sync({ txError: "交易哈希格式不正确" });
    return;
  }

  sync({ isFetchingTx: true, txError: "", txData: null, blockData: null });

  try {
    const { tx: txInfo, block: blockInfo } = await fetchTxInfo(txHash);
    sync({ txData: txInfo, blockData: blockInfo, tx: txHash });
  } catch (error) {
    console.error("获取交易失败:", error);
    sync({ txError: error instanceof Error ? error.message : "获取交易失败" });
  } finally {
    sync({ isFetchingTx: false });
  }
}

/* ── startDebugAction ── 启动调试会话 ─────────────────────────── */

export interface StartDebugDeps extends MessageHandlerContext {
  resetPlayback: () => void;
  resetNav: () => void;
  setCurrentStepIndex: (v: number) => void;
  setIsPlaying: (v: boolean) => void;
}

export async function startDebugAction(deps: StartDebugDeps) {
  const { tx, txData, blockData, sync } = useDebugStore.getState();

  if (!tx) { console.log("tx is empty"); return; }
  if (tx.length < 64) { console.log("tx is too short"); return; }
  if (!txData || !blockData) { console.log("tx or block data is missing"); return; }

  let txHash = tx;
  if (tx.startsWith("0x")) {
    txHash = tx.slice(2);
    sync({ tx: txHash });
  }

  console.log("开始调试，txHash:", txHash);

  // 保存当前调试的 chainId 到全局 store
  sync({ currentDebugChainId: getSelectedChain() });

  // 重置状态
  deps.resetPlayback();
  resetPendingFrameEnters();
  deps.setIsDebugging(true);
  deps.setCallFrames([]);
  deps.callTreeRef.current = [];
  deps.allStepsRef.current = [];
  deps.stepIndexByContext.current = new Map();
  deps.opcodeIndex.current = new Map();
  sync({ callTreeNodes: [], activeTab: "main", tabHistory: [], executedOpcodeSet: new Set<number>() });
  deps.resetNav();
  deps.setStepCount(0);
  deps.setCurrentStepIndex(-1);
  deps.setIsPlaying(false);

  console.log("准备调试数据:", { txHash, txData, blockData });

  try {
    const channel = new Channel();

    channel.onmessage = (message: unknown) => {
      handleMessage(message, deps);
    };

    const txDebugData = {
      from: txData.from || "",
      to: txData.to || "",
      value: txData.value?.toString() || "0",
      gas_price: txData.gasPrice?.toString() || "0",
      gas_limit: txData.gasLimit?.toString() || "0",
      data: txData.data || "0x",
    };

    const blockDebugData = {
      number: blockData.blockNumber?.toString() || "0",
      timestamp: blockData.timestamp?.toString() || "0",
      base_fee: blockData.baseFeePerGas?.toString() || "0",
      beneficiary: blockData.beneficiary || "0x0000000000000000000000000000000000000000",
      difficulty: blockData.difficulty?.toString() || "0",
      mix_hash: blockData.mixHash || "0x0000000000000000000000000000000000000000000000000000000000000000",
      gas_limit: blockData.gasLimit?.toString() || "0",
    };

    const backendConfig = getBackendConfig();

    await invoke("op_trace", {
      tx: txHash,
      txData: txDebugData,
      blockData: blockDebugData,
      ...backendConfig,
      patches: backendConfig.forkMode
        ? useForkStore.getState().patches.map((p) => ({
            step_index: p.stepIndex,
            stack_patches: p.stackPatches.map((sp) => [sp.pos, sp.value] as [number, string]),
            memory_patches: p.memoryPatches.map((mp) => [mp.offset, mp.value] as [number, string]),
          }))
        : null,
      channel,
    });
    // 流式接收结束，用精确的最终步数触发一次全量缓存（防止最后一批步数不在 500 边界上）
    const finalCount = deps.allStepsRef.current.length;
    if (finalCount > 0) deps.setStepCount(finalCount);
  } catch (error) {
    console.log("准备调试数据:", { txHash, txData, blockData });
    console.error("调试失败:", error);
    deps.setIsDebugging(false);
  }
}

/* ── resetAllAction ── 完全重置所有状态 ─────────────────────── */

export interface ResetAllDeps {
  allStepsRef: React.RefObject<StepData[]>;
  callFramesRef: React.RefObject<CallFrame[]>;
  callTreeRef: React.RefObject<CallTreeNode[]>;
  stepIndexByContext: React.RefObject<Map<number, number[]>>;
  opcodeIndex: React.RefObject<Map<number, number[]>>;
  fullDataCache: React.RefObject<unknown[] | null>;
  resetPlayback: () => void;
  resetNav: () => void;
}

export async function resetAllAction(deps: ResetAllDeps) {
  // 1. 释放 Rust 端 DebugSession
  try {
    await invoke(ipcCommands.resetSession);
  } catch (e) {
    console.warn("[reset] reset_session failed:", e);
  }

  // 2. 暂存需要保留的配置
  const { config } = useDebugStore.getState();

  // 3. 重置 Zustand store
  useDebugStore.getState().resetStore();

  // 4. 恢复配置（config 不随 reset 清空）
  useDebugStore.getState().sync({ config });

  // 5. 清空 App.tsx 里的 ref
  deps.allStepsRef.current = [];
  deps.callFramesRef.current = [];
  deps.callTreeRef.current = [];
  deps.stepIndexByContext.current = new Map();
  deps.opcodeIndex.current = new Map();
  deps.fullDataCache.current = null;
  deps.resetPlayback();
  deps.resetNav();

  // 6. 重置 forkStore
  useForkStore.setState({ patches: [], isExecuting: false, forkRound: 0 });

  console.log("[reset] all state cleared");
}

/* ── debugDump ── 打印当前帧的调试信息到控制台 ────────────────── */

export function debugDump(
  currentStepIndexRef: { readonly current: number },
  callFramesRef: { readonly current: CallFrame[] },
  activeTabRef: { readonly current: string },
  allStepsRef: { readonly current: StepData[] },
) {
  const currentIndex = currentStepIndexRef.current;
  if (currentIndex < 0) return;

  const activeFrame = callFramesRef.current.find(f => f.id === activeTabRef.current);
  if (!activeFrame) return;

  const contextId = activeFrame.contextId;

  const frameSteps = allStepsRef.current
    .slice(0, currentIndex + 1)
    .filter(s => s.contextId === contextId);

  console.group(`=== Dump: contextId=${contextId}, globalIndex=${currentIndex} ===`);

  console.group(`Steps (${frameSteps.length})`);
  frameSteps.forEach((step, i) => {
    const stackParts = [step.stackTop, step.stackSecond, step.stackThird].filter(Boolean);
    console.log(
      `[${i}] frameStep=${step.frameStepCount} pc=${step.pc}` +
      ` op=0x${step.opcode.toString(16).padStart(2, '0')}` +
      (stackParts.length > 0 ? ` stack=[${stackParts.join(', ')}]` : '')
    );
  });
  console.groupEnd();

  console.groupEnd();
}
