import { invoke, Channel } from "@tauri-apps/api/core";
import { useDebugStore } from "@/store/debugStore";
import { useForkStore } from "@/store/forkStore";
import { fetchTxInfo } from "./txFetcher";
import { toast } from "sonner";
import {
  handleMessage,
  resetPendingFrameEnters,
  markDebugPerfStart,
} from "./messageHandlers";
import type { CallFrame, CallTreeNode, MessageHandlerContext } from "./types";
import { type StepData } from "./stepPlayer";
import { getSelectedChain } from "./rpcConfig";
import { getBackendConfig } from "./appConfig";
import type { BackendTxDebugData, TxSlot } from "./txFetcher";
import type { BlockData } from "./txFetcher";
import {
  txListRowToBackend,
  isValidTxListRow,
  deriveFromTxSlots,
  consecutiveTxSlotsReady,
  txSlotToBackendDebugData,
} from "./txFetcher";
import { ipcCommands } from "./ipcConfig";
import { getWindowMode } from "./windowMode";

function buildBackendBlockDataOrThrow(blockData: BlockData | null | undefined):
  | { blockData: {
      number: string;
      timestamp: string;
      base_fee: string;
      beneficiary: string;
      difficulty: string;
      mix_hash: string;
      gas_limit: string;
    } }
  | {} {
  const b = blockData ?? null;
  const n = b?.blockNumber;
  const ts = b?.timestamp;
  const gl = b?.gasLimit;
  const bf = b?.baseFeePerGas;

  const allEmpty = n == null && ts == null && gl == null && bf == null;
  if (allEmpty) return {};

  const anyEmpty = n == null || ts == null || gl == null || bf == null;
  if (anyEmpty) {
    throw new Error(
      "Block info is incomplete. Please fill Number, Time, GasLimit and BaseFee, or leave them all empty.",
    );
  }

  return {
    blockData: {
      number: n.toString(),
      timestamp: ts.toString(),
      base_fee: bf.toString(),
      beneficiary: b?.beneficiary || "0x0000000000000000000000000000000000000000",
      difficulty: b?.difficulty?.toString() || "0",
      mix_hash:
        b?.mixHash ||
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      gas_limit: gl.toString(),
    },
  };
}

export async function fetchTxForSlot(slotIndex: number) {
  const { txSlots, sync } = useDebugStore.getState();
  const slot = txSlots[slotIndex];
  if (!slot) return;

  let raw = slot.hash.trim();
  if (!raw) {
    const msg = "请输入交易哈希";
    const next = txSlots.map((s, j) =>
      j === slotIndex ? { ...s, error: msg } : s,
    );
    sync({ txSlots: next, ...deriveFromTxSlots(next), txError: "" });
    toast.error(msg);
    return;
  }

  let txHash = raw;
  if (!txHash.startsWith("0x")) {
    txHash = "0x" + txHash;
  }

  if (txHash.length !== 66) {
    const msg = "交易哈希格式不正确";
    const next = txSlots.map((s, j) =>
      j === slotIndex ? { ...s, error: msg } : s,
    );
    sync({ txSlots: next, ...deriveFromTxSlots(next), txError: "" });
    toast.error(msg);
    return;
  }

  const loading = txSlots.map((s, j) =>
    j === slotIndex ? { ...s, isFetching: true, error: "", txData: null, blockData: null } : s,
  );
  sync({
    txSlots: loading,
    ...deriveFromTxSlots(loading),
    isFetchingTx: true,
    txError: "",
  });

  try {
    const { tx: txInfo, block: blockInfo } = await fetchTxInfo(txHash);
    const after = useDebugStore.getState().txSlots.map((s, j) =>
      j === slotIndex
        ? {
            ...s,
            txData: txInfo,
            blockData: blockInfo,
            isFetching: false,
            error: "",
            hash: txHash,
          }
        : s,
    );
    sync({
      txSlots: after,
      ...deriveFromTxSlots(after),
      isFetchingTx: after.some((x) => x.isFetching),
    });
  } catch (error) {
    console.error("获取交易失败:", error);
    const msg = error instanceof Error ? error.message : "获取交易失败";
    const after = useDebugStore.getState().txSlots.map((s, j) =>
      j === slotIndex ? { ...s, isFetching: false, error: msg } : s,
    );
    sync({
      txSlots: after,
      ...deriveFromTxSlots(after),
      isFetchingTx: after.some((x) => x.isFetching),
      txError: slotIndex === 0 ? msg : useDebugStore.getState().txError,
    });
    toast.error(msg);
  }
}

export function slotNeedsTxFetch(slot: TxSlot): boolean {
  if (slot.txData && slot.blockData) return false;
  const raw = slot.hash.trim();
  if (!raw) return false;
  const h = raw.startsWith("0x") ? raw : `0x${raw}`;
  return h.length === 66;
}

export async function fetchAllPendingTxSlots() {
  const indices: number[] = [];
  useDebugStore.getState().txSlots.forEach((s, i) => {
    if (slotNeedsTxFetch(s)) indices.push(i);
  });
  for (const i of indices) {
    await fetchTxForSlot(i);
  }
}

/** @deprecated 使用 fetchTxForSlot(0) */
export async function fetchTxAction() {
  return fetchTxForSlot(0);
}

export interface StartDebugDeps extends MessageHandlerContext {
  sessionId: string;
  resetPlayback: () => void;
  resetNav: () => void;
  setCurrentStepIndex: (v: number) => void;
  setIsPlaying: (v: boolean) => void;
}

export async function startDebugAction(deps: StartDebugDeps) {
  const { tx, txData, blockData, txDataList, txSlots, debugByTx, sync } =
    useDebugStore.getState();
  if (deps.runtime.startDebugInFlight || useDebugStore.getState().isDebugging) {
    console.warn("[startDebug] ignored duplicate start while running/in-flight");
    return;
  }

  if (!tx) { console.log("tx is empty"); return; }
  if (tx.length < 64) { console.log("tx is too short"); return; }

  const chainReady = consecutiveTxSlotsReady(txSlots);
  const fromDataList = txDataList.filter(isValidTxListRow).map(txListRowToBackend);

  let multiPayload: BackendTxDebugData[] = [];
  if (debugByTx) {
    if (chainReady.length >= 2) {
      const mapped = chainReady
        .map(txSlotToBackendDebugData)
        .filter((x): x is BackendTxDebugData => x != null);
      if (mapped.length >= 2) multiPayload = mapped;
    }
  } else {
    multiPayload = fromDataList;
  }

  const canDataSingle = !debugByTx && multiPayload.length === 1;
  const canStart =
    multiPayload.length >= 2 ||
    canDataSingle ||
    !!(txData && blockData);
  if (!canStart) {
    console.log("startDebug: nothing to run");
    return;
  }

  // 多交易：blockData 三态校验
  // - 全空：不传给后端（后端将自行从链上读取）
  // - 全齐：传给后端（用于“当前块环境”：basefee/timestamp/...）
  // - 缺一项：直接报错并中止（避免前后端对环境块含义不一致）
  let backendBlockForMulti: ReturnType<typeof buildBackendBlockDataOrThrow> = {};
  if (multiPayload.length >= 2) {
    try {
      backendBlockForMulti = buildBackendBlockDataOrThrow(blockData);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
      sync({ txError: msg });
      deps.runtime.startDebugInFlight = false;
      return;
    }
  }
  deps.runtime.startDebugInFlight = true;

  let txHash = tx;
  if (tx.startsWith("0x")) {
    txHash = tx.slice(2);
    sync({ tx: txHash });
  }

  console.log("开始调试，txHash:", txHash);
  markDebugPerfStart(deps.runtime);

  sync({ currentDebugChainId: getSelectedChain() });

  deps.resetPlayback();
  resetPendingFrameEnters(deps.runtime);
  deps.setIsDebugging(true);
  deps.setCallFrames([]);
  deps.callTreeRef.current = [];
  deps.allStepsRef.current = [];
  deps.stepIndexByContext.current = new Map();
  deps.opcodeIndex.current = new Map();
  sync({
    callTreeNodes: [],
    activeTab: "main",
    tabHistory: [],
    executedOpcodeSet: new Set<number>(),
    txBoundaries: null,
    traceFinished: false,
  });
  deps.resetNav();
  deps.setStepCount(0);
  deps.setCurrentStepIndex(-1);
  deps.setIsPlaying(false);

  console.log("准备调试数据:", { txHash, txData, blockData, multiCount: multiPayload.length });

  try {
    const invokeStart = performance.now();
    const channel = new Channel();

    channel.onmessage = (message: unknown) => {
      handleMessage(message, deps);
    };

    const backendConfig = getBackendConfig();
    const readonly = getWindowMode().readonly;
    const patches = backendConfig.forkMode
      ? useForkStore.getState().patches.map((p) => ({
          step_index: p.stepIndex,
          stack_patches: p.stackPatches.map((sp) => [sp.pos, sp.value] as [number, string]),
          memory_patches: p.memoryPatches.map((mp) => [mp.offset, mp.value] as [number, string]),
        }))
      : null;

    if (multiPayload.length >= 2) {
      await invoke("op_trace", {
        tx: txHash,
        sessionId: deps.sessionId,
        txDataList: multiPayload,
        ...backendBlockForMulti,
        ...backendConfig,
        readonly,
        patches,
        channel,
      });
    } else if (canDataSingle) {
      await invoke("op_trace", {
        tx: txHash,
        sessionId: deps.sessionId,
        txData: multiPayload[0],
        txDataList: null,
        blockData: null,
        ...backendConfig,
        readonly,
        patches,
        channel,
      });
    } else {
      const parentBlockStr =
        blockData!.blockNumber != null
          ? String(BigInt(blockData!.blockNumber) - 1n)
          : undefined;
      const txDebugData = {
        from: txData!.from || "",
        to: txData!.to || "",
        value: txData!.value?.toString() || "0",
        gas_price: txData!.gasPrice?.toString() || "0",
        gas_limit: txData!.gasLimit?.toString() || "0",
        data: txData!.data || "0x",
        tx_hash: txHash,
        ...(parentBlockStr !== undefined ? { cache_block: parentBlockStr } : {}),
      };

      const blockDebugData = {
        number: blockData!.blockNumber?.toString() || "0",
        timestamp: blockData!.timestamp?.toString() || "0",
        base_fee: blockData!.baseFeePerGas?.toString() || "0",
        beneficiary: blockData!.beneficiary || "0x0000000000000000000000000000000000000000",
        difficulty: blockData!.difficulty?.toString() || "0",
        mix_hash: blockData!.mixHash || "0x0000000000000000000000000000000000000000000000000000000000000000",
        gas_limit: blockData!.gasLimit?.toString() || "0",
      };

      await invoke("op_trace", {
        tx: txHash,
        sessionId: deps.sessionId,
        txData: txDebugData,
        blockData: blockDebugData,
        ...backendConfig,
        readonly,
        patches,
        channel,
      });
    }
    console.log(`[perf.frontend] invoke(op_trace) resolved in ${(performance.now() - invokeStart).toFixed(1)}ms`);
    const finalCount = deps.allStepsRef.current.length;
    if (finalCount > 0) deps.setStepCount(finalCount);
  } catch (error) {
    console.log("准备调试数据:", { txHash, txData, blockData });
    console.error("调试失败:", error);
    deps.setIsDebugging(false);
  } finally {
    deps.runtime.startDebugInFlight = false;
  }
}

export interface ResetAllDeps {
  sessionId: string;
  allStepsRef: React.RefObject<StepData[]>;
  callFramesRef: React.RefObject<CallFrame[]>;
  callTreeRef: React.RefObject<CallTreeNode[]>;
  stepIndexByContext: React.RefObject<Map<string, number[]>>;
  opcodeIndex: React.RefObject<Map<number, number[]>>;
  runtime: MessageHandlerContext["runtime"];
  fullDataCache: React.RefObject<unknown[] | null>;
  resetPlayback: () => void;
  resetNav: () => void;
}

export async function resetAllAction(deps: ResetAllDeps) {
  invoke(ipcCommands.resetSession, { sessionId: deps.sessionId }).catch((e) => {
    console.warn("[reset] reset_session failed:", e);
  });

  const { config, txSlots, txDataList, debugByTx } = useDebugStore.getState();

  const clearedSlots = txSlots.map((s) => ({
    ...s,
    txData: null,
    blockData: null,
    error: "",
    isFetching: false,
  }));

  useDebugStore.getState().resetStore();

  useDebugStore.getState().sync({
    config,
    sessionId: deps.sessionId,
    txSlots: clearedSlots,
    txDataList,
    debugByTx,
    ...deriveFromTxSlots(clearedSlots),
  });

  resetPendingFrameEnters(deps.runtime);
  deps.allStepsRef.current = [];
  deps.callFramesRef.current = [];
  deps.callTreeRef.current = [];
  deps.stepIndexByContext.current = new Map();
  deps.opcodeIndex.current = new Map();
  deps.fullDataCache.current = null;
  deps.resetPlayback();
  deps.resetNav();

  useForkStore.setState({ patches: [], isExecuting: false, forkRound: 0 });

  console.log("[reset] all state cleared");
}

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
  const txId = activeFrame.transactionId ?? 0;

  const frameSteps = allStepsRef.current
    .slice(0, currentIndex + 1)
    .filter(s => s.contextId === contextId && (s.transactionId ?? 0) === txId);

  console.group(`=== Dump: transactionId=${txId}, contextId=${contextId}, globalIndex=${currentIndex} ===`);

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
