/**
 * 集中管理项目中使用的共享类型
 * 解决类型定义分散在 messageHandlers / debugStore / StorageViewer 等多处的问题
 */

import type { Opcode } from "./opcodes";
import type { StepData } from "./stepPlayer";

// ── 枚举 ──────────────────────────────────────────────────────

export enum MsgType {
    StepBatch = 1,
    ContractSource = 2,
    ContextUpdateAddress = 3,
    Logs = 4,
    MemoryUpdate = 5,
    ReturnData = 6,
    StorageChange = 7,
    FrameEnter = 8,
    FrameExit = 9,
    SelfDestruct = 10,
    BalanceChanges = 11,
    Finished = 255,
}

export enum InstructionResult {
    Stop = 0x01,
    Return = 0x02,
    SelfDestruct = 0x03,
    Revert = 0x10,
    CallTooDeep = 0x11,
    OutOfFunds = 0x12,
    CreateInitCodeStartingEF00 = 0x13,
    InvalidEOFInitCode = 0x14,
    InvalidExtDelegateCallTarget = 0x15,
    OutOfGas = 0x20,
    MemoryOOG = 0x21,
    MemoryLimitOOG = 0x22,
    PrecompileOOG = 0x23,
    InvalidOperandOOG = 0x24,
    ReentrancySentryOOG = 0x25,
    OpcodeNotFound = 0x26,
    CallNotAllowedInsideStatic = 0x27,
    StateChangeDuringStaticCall = 0x28,
    InvalidFEOpcode = 0x29,
    InvalidJump = 0x2a,
    NotActivated = 0x2b,
    StackUnderflow = 0x2c,
    StackOverflow = 0x2d,
    OutOfOffset = 0x2e,
    CreateCollision = 0x2f,
    OverflowPayment = 0x30,
    PrecompileError = 0x31,
    NonceOverflow = 0x32,
    CreateContractSizeLimit = 0x33,
    CreateContractStartingWithEF = 0x34,
    CreateInitCodeSizeLimit = 0x35,
    FatalExternalError = 0x36,
}

// ── 数据接口 ──────────────────────────────────────────────────

export interface LogEntry {
    address: string;
    topics: string[];
    data: string;
    stepIndex: number;
    contextId: number;
}

export interface MemoryPatch {
    frameStepCount: number;
    dstOffset: number;
    data: Uint8Array;
}

export interface MemorySnapshot {
    frameStepCount: number;
    memory: string;
}

export interface ReturnDataEntry {
    stepIndex: number;
    contextId: number;
    data: string;
}

export interface StorageChangeEntry {
    storageType: "storage" | "tstorage";
    isRead: boolean;
    stepIndex: number;
    contextId: number;
    address: string;
    key: string;
    hadValue: string;
    newValue: string;
}

export interface StateDiff {
    address: string;
    key: string;
    oldValue: string;
    newValue: string;
}

// 余额变化（由 BalanceChanges 消息传输）
interface BalanceTokenChange {
    contract: string;  // 代币合约地址
    delta: string;     // "+123456" 或 "-123456"
}

export interface AddressBalance {
    address: string;
    eth: string | null;   // "+xxx" | "-xxx" | null
    tokens: BalanceTokenChange[];
}

// ── CallFrame ─────────────────────────────────────────────────

export interface CallFrame {
    id: string;
    contextId: number;
    parentId?: number;
    depth: number;
    callType?: "call" | "staticcall" | "delegatecall" | "create" | "create2";
    address?: string;
    caller?: string;
    target?: string;
    contract?: string;
    gasLimit?: number;
    gasUsed?: number;
    value?: string;
    input?: string;
    bytecode?: string;
    opcodes: Opcode[];
    stack: string[];
    memory: string;
    storageChanges: StorageChangeEntry[];
    currentPc?: number;
    currentGasCost?: number;
    logs: LogEntry[];
    memoryPatches: MemoryPatch[];
    memorySnapshots: MemorySnapshot[];
    returnDataList: ReturnDataEntry[];
    exitCode?: number;
    success?: boolean;
    exitOutput?: string;
    selfdestructContract?: string;
    selfdestructTarget?: string;
    selfdestructValue?: string;
}

// ── Call Tree ─────────────────────────────────────────────────

export type CallTreeNodeType = 'frame' | 'sload' | 'sstore' | 'tload' | 'tstore' | 'log';

export interface CallTreeNode {
    id: number;
    type: CallTreeNodeType;
    stepIndex: number;
    contextId: number;
    depth: number;
    callType?: string;
    address?: string;
    caller?: string;
    target?: string;
    value?: string;
    input?: string;
    success?: boolean;
    gasUsed?: number;
    reverted?: boolean;
    slot?: string;
    newValue?: string;
    oldValue?: string;
    topics?: string[];
    logData?: string;
    selfdestructContract?: string;
    selfdestructTarget?: string;
    selfdestructValue?: string;
}

// ── MessageHandler 上下文 ─────────────────────────────────────

export interface MessageHandlerContext {
    allStepsRef: React.RefObject<StepData[]>;
    callFramesRef: React.RefObject<CallFrame[]>;
    currentStepIndexRef: React.RefObject<number>;
    stepIndexByContext: React.RefObject<Map<number, number[]>>;
    opcodeIndex: React.RefObject<Map<number, number[]>>;
    setStepCount: (count: number) => void;
    setCallFrames: React.Dispatch<React.SetStateAction<CallFrame[]>>;
    setActiveTab: (tabId: string) => void;
    setIsDebugging: (isDebugging: boolean) => void;
    applyStep: (index: number) => void;
    callTreeRef: React.RefObject<CallTreeNode[]>;
}
