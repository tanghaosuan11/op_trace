import { create } from "zustand";

export interface StackPatch {
  pos: number;   // stack position (0 = top)
  value: string; // hex value
}

export interface MemoryPatch {
  offset: number; // byte offset
  value: string;  // hex data
}

export interface StatePatch {
  id: string;
  stepIndex: number;
  stackPatches: StackPatch[];
  memoryPatches: MemoryPatch[];
}

export interface ForkState {
  /** 原始交易哈希 */
  txHash: string;
  /** RPC URL */
  rpcUrl: string;
  /** Append-only patch 列表（旧的不可删改） */
  patches: StatePatch[];
  /** 是否正在执行 fork */
  isExecuting: boolean;
  /** fork 执行轮次（每次 +1，用于标识哪次执行） */
  forkRound: number;
}

export interface ForkActions {
  setConfig: (txHash: string, rpcUrl: string) => void;
  /** 追加一个 patch（append-only） */
  addPatch: (patch: StatePatch) => void;
  /** 删除最后一个 patch（仅当它后面没有其他 patch 时允许） */
  removeLastPatch: () => void;
  setExecuting: (v: boolean) => void;
  incrementRound: () => void;
}

export const useForkStore = create<ForkState & ForkActions>()((set) => ({
  txHash: "",
  rpcUrl: "",
  patches: [],
  isExecuting: false,
  forkRound: 0,

  setConfig: (txHash, rpcUrl) => set({ txHash, rpcUrl }),
  addPatch: (patch) => set((s) => ({ patches: [...s.patches, patch] })),
  removeLastPatch: () => set((s) => ({ patches: s.patches.slice(0, -1) })),
  setExecuting: (v) => set({ isExecuting: v }),
  incrementRound: () => set((s) => ({ forkRound: s.forkRound + 1 })),
}));
