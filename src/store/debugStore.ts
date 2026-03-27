import { create, type UseBoundStore, type StoreApi } from "zustand";
import type { TxData, BlockData } from "@/lib/txFetcher";
import type {
  StorageChangeEntry,
  CallFrame,
  CallTreeNode,
  LogEntry,
  StateDiff,
  AddressBalance,
} from "@/lib/types";
import type { Opcode } from "@/lib/opcodes";
import type { ScanHit, CondNode } from "@/lib/pauseConditions";
import { type AppConfig, DEFAULT_CONFIG } from "@/lib/appConfig";

// Re-export for consumers that import from debugStore
export type { Opcode, LogEntry, StateDiff, AddressBalance };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Slice 1: Playback — 当前帧数据 + 播放控制
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface PlaybackSlice {
  // 当前帧数据（由 applyStep 写入）
  opcodes: Opcode[];
  stack: string[];
  memory: string;
  currentPc: number;
  currentGasCost: number;
  storageChanges: StorageChangeEntry[];
  logs: LogEntry[];
  returnData: string;
  returnError: string;
  stateDiffs: StateDiff[];
  balanceChanges: AddressBalance[];
  // 当前帧元数据
  callType?: "call" | "staticcall" | "delegatecall" | "create" | "create2";
  callerAddress?: string;
  // 播放控制
  currentStepIndex: number;
  isPlaying: boolean;
  playbackSpeed: number;
  stepCount: number;
  // 帧与 Call Tree
  callFrames: CallFrame[];
  hasCallFrames: boolean;
  callTreeNodes: CallTreeNode[];
  // 已执行过的 opcode 字节集合（用于 OpcodeViewer 过滤）
  executedOpcodeSet: Set<number>;
  // 4byte 远程查询结果缓存（selector → 函数名）
  resolvedFnCache: Record<string, string>;
  // 范围播放模式
  rangeEnabled: boolean;
  rangeStart: number;
  rangeEnd: number;
}

const initialPlayback: PlaybackSlice = {
  opcodes: [],
  stack: [],
  memory: "",
  currentPc: -1,
  currentGasCost: 0,
  storageChanges: [],
  logs: [],
  returnData: "",
  returnError: "",
  stateDiffs: [],
  balanceChanges: [],
  callType: undefined,
  callerAddress: undefined,
  currentStepIndex: -1,
  isPlaying: false,
  playbackSpeed: 10,
  stepCount: 0,
  callFrames: [],
  hasCallFrames: false,
  callTreeNodes: [],
  executedOpcodeSet: new Set<number>(),
  resolvedFnCache: {},
  rangeEnabled: false,
  rangeStart: 0,
  rangeEnd: 0,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Slice 2: Condition — 条件断点 + 断点管理
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ConditionSlice {
  // 断点 opcodes
  breakOpcodes: Set<number>;
  // 当前帧的断点（已按 activeTab 切片）
  breakpointPcs: Set<number>;
  // 完整断点 Map
  breakpointPcsMap: Map<string, Set<number>>;
  // 断点标签 pc -> label
  breakpointLabels: Map<number, string>;
  // 条件断点树（根节点列表，根节点间 OR；每次合并减少数量）
  condNodes: CondNode[];
  // 条件断点扫描结果
  conditionHitSet: Set<number>;
  scanHits: ScanHit[];
}

const initialCondition: ConditionSlice = {
  breakOpcodes: new Set(),
  breakpointPcs: new Set(),
  breakpointPcsMap: new Map(),
  breakpointLabels: new Map(),
  condNodes: [],
  conditionHitSet: new Set<number>(),
  scanHits: [],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Slice 2b: Notes — 值记录 + 步数标记
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type ValueSource =
  | { type: "stack"; depth: number; value: string }
  | { type: "memory"; offset: number; length: number; value: string }
  | { type: "storage"; key: string; value: string };

export interface ValueRecord {
  id: string;
  createdAt: number;
  stepIndex: number;
  note: string;
  source: ValueSource;
}

export interface StepMark {
  id: string;
  createdAt: number;
  stepIndex: number;
  opcodeName: string;
  note: string;
}

export interface NotesSlice {
  isNotesDrawerOpen: boolean;
  valueRecords: ValueRecord[];
  stepMarks: StepMark[];
}

const initialNotes: NotesSlice = {
  isNotesDrawerOpen: false,
  valueRecords: [],
  stepMarks: [],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Slice 3: UI — Tab / 导航 / 面板可见性
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface UISlice {
  // Tab 管理
  activeTab: string;
  tabHistory: string[];
  hiddenFrameIds: Set<string>;
  // 导航
  canNavBack: boolean;
  canNavForward: boolean;
  // 面板
  isLogDrawerOpen: boolean;
  isUtilitiesOpen: boolean;
  isAnalysisOpen: boolean;
  isBookmarksOpen: boolean;
  isCondListOpen: boolean;
  isCallTreeOpen: boolean;
  isTestDialogOpen: boolean;
  testBytecode: string;
  testOpcodes: Array<{ pc: number; name: string; data?: string }>;
  // 全量缓存模式（fullDataCache 已就绪）
  isCacheMode: boolean;
  // 数据流回溯高亮
  backwardSliceHighlight: Set<number>;
  // 数据流树形显示
  isDataFlowModalOpen: boolean;
  dataFlowTreeRootId: number;
  dataFlowTreeNodes: Array<{
    id: number;
    global_step: number;
    pc: number;
    opcode: number;
    opcode_name: string;
    parent_ids: number[];
    stack_value_post?: string;
  }>;
}

const initialUI: UISlice = {
  activeTab: "main",
  tabHistory: [],
  hiddenFrameIds: new Set<string>(),
  canNavBack: false,
  canNavForward: false,
  isLogDrawerOpen: false,
  isUtilitiesOpen: false,
  isAnalysisOpen: false,
  isBookmarksOpen: false,
  isCondListOpen: false,
  isCallTreeOpen: false,
  isTestDialogOpen: false,
  testBytecode: "",
  testOpcodes: [],
  isCacheMode: false,
  backwardSliceHighlight: new Set<number>(),
  isDataFlowModalOpen: false,
  dataFlowTreeRootId: 0,
  dataFlowTreeNodes: [],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Slice 3b: Config — 统一应用配置
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ConfigSlice {
  config: AppConfig;
}

const initialConfig: ConfigSlice = {
  config: { ...DEFAULT_CONFIG },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Slice 4: TX — 交易 / 调试会话
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface TxSlice {
  tx: string;
  txData: TxData | null;
  blockData: BlockData | null;
  isFetchingTx: boolean;
  txError: string;
  isDebugging: boolean;
  currentDebugChainId: number | undefined;
}

const testTx = import.meta.env.VITE_TEST_TX ?? "";
const initialTx: TxSlice = {
  tx: testTx,
  txData: null,
  blockData: null,
  isFetchingTx: false,
  txError: "",
  isDebugging: false,
  currentDebugChainId: undefined,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 合并 State + Actions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type DebugState = PlaybackSlice & ConditionSlice & NotesSlice & UISlice & ConfigSlice & TxSlice;

export interface DebugActions {
  /** 批量更新 store（桥接用） */
  sync: (partial: Partial<DebugState>) => void;
  /** 注册跳转回调（由 App.tsx 在 useDebugPlayback 挂载后调用） */
  registerSeekToStep: (fn: ((index: number) => void) | null) => void;
  /** 跳转到指定 stepIndex（由分析结果等外部触发） */
  seekToStep: ((index: number) => void) | null;
  /** 重置到初始值 */
  resetStore: () => void;
  /** 设置断点标签（空字符串则删除） */
  setBreakpointLabel: (pc: number, label: string) => void;
  /** 删除断点标签 */
  removeBreakpointLabel: (pc: number) => void;
  /** 添加值记录 */
  addValueRecord: (record: Omit<ValueRecord, "id" | "createdAt">) => void;
  /** 删除值记录 */
  removeValueRecord: (id: string) => void;
  /** 更新值记录备注 */
  updateValueRecordNote: (id: string, note: string) => void;
  /** 添加步数标记 */
  addStepMark: (mark: Omit<StepMark, "id" | "createdAt">) => void;
  /** 删除步数标记 */
  removeStepMark: (id: string) => void;
  /** 更新步数标记备注 */
  updateStepMarkNote: (id: string, note: string) => void;
  /** 设置数据流回溯高亮步骤 */
  setBackwardSliceHighlight: (steps: number[]) => void;
  /** 清除数据流回溯高亮 */
  clearBackwardSliceHighlight: () => void;
  /** 打开数据流树形模态框 */
  openDataFlowModal: (
    rootId: number,
    nodes: Array<{
      id: number;
      global_step: number;
      pc: number;
      opcode: number;
      opcode_name: string;
      parent_ids: number[];
      stack_value_post?: string;
    }>
  ) => void;
  /** 关闭数据流树形模态框 */
  closeDataFlowModal: () => void;
}

const initialState: DebugState = {
  ...initialPlayback,
  ...initialCondition,
  ...initialNotes,
  ...initialUI,
  ...initialConfig,
  ...initialTx,
};

export type DebugStore = DebugState & DebugActions;

/* ── Store ───────────────────────────────────────────────────── */

export const useDebugStore: UseBoundStore<StoreApi<DebugStore>> = create<DebugStore>()((set) => ({
  ...initialState,

  sync: (partial) => set(partial),

  seekToStep: null,

  registerSeekToStep: (fn) => set({ seekToStep: fn }),

  resetStore: () => set(initialState),

  setBreakpointLabel: (pc, label) => set((s) => {
    const next = new Map(s.breakpointLabels);
    if (label.trim()) next.set(pc, label.trim());
    else next.delete(pc);
    return { breakpointLabels: next };
  }),

  removeBreakpointLabel: (pc) => set((s) => {
    const next = new Map(s.breakpointLabels);
    next.delete(pc);
    return { breakpointLabels: next };
  }),

  addValueRecord: (record) => set((s) => ({
    valueRecords: [...s.valueRecords, { ...record, id: crypto.randomUUID(), createdAt: Date.now() }],
  })),
  removeValueRecord: (id) => set((s) => ({
    valueRecords: s.valueRecords.filter((r) => r.id !== id),
  })),
  updateValueRecordNote: (id, note) => set((s) => ({
    valueRecords: s.valueRecords.map((r) => r.id === id ? { ...r, note } : r),
  })),

  addStepMark: (mark) => set((s) => ({
    stepMarks: [...s.stepMarks, { ...mark, id: crypto.randomUUID(), createdAt: Date.now() }],
  })),
  removeStepMark: (id) => set((s) => ({
    stepMarks: s.stepMarks.filter((m) => m.id !== id),
  })),
  updateStepMarkNote: (id, note) => set((s) => ({
    stepMarks: s.stepMarks.map((m) => m.id === id ? { ...m, note } : m),
  })),

  setBackwardSliceHighlight: (steps) => set({ backwardSliceHighlight: new Set(steps) }),
  clearBackwardSliceHighlight: () => set({ backwardSliceHighlight: new Set<number>() }),

  openDataFlowModal: (rootId, nodes) => set({
    isDataFlowModalOpen: true,
    dataFlowTreeRootId: rootId,
    dataFlowTreeNodes: nodes,
  }),
  closeDataFlowModal: () => set({
    isDataFlowModalOpen: false,
  }),
}));
