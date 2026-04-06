// Step 数据解析和播放相关的工具函数

import { frameScopeKeyFromStep } from "./frameScope";

// 字节→十六进制查找表，避免每次 toString(16) 调用（在 parseStepBatch 热循环中关键）
const _HEX = (() => {
  const t = new Array<string>(256);
  for (let i = 0; i < 256; i++) t[i] = i.toString(16).padStart(2, '0');
  return t;
})();

function _u8ToHex(buf: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += _HEX[buf[i]];
  return s;
}

export interface StepData {
  /** 第几笔交易（0-based）；单 tx 为 0 */
  transactionId: number;
  contextId: number;
  depth: number;
  pc: number;
  opcode: number;
  gasCost: number;
  gasRemaining: number;
  frameStepCount: number; // frame 内部的步骤计数，始终存在
  calldata?: string; // hex string, 仅 CALL 类指令可能携带
  // 仅对 SLOAD/SSTORE/CALL/STATICCALL/DELEGATECALL/LOG1-LOG4 保留栈顶 3 项
  // 完整 stack 由 Rust seek_to 按需返回，不在 JS 堆中存储 70 万份
  stackTop?: string;     // stack[len-1] 栈顶
  stackSecond?: string;  // stack[len-2]
  stackThird?: string;   // stack[len-3]
}

export interface ParsedStepBatchResult {
  steps: StepData[];
  /** key = `${transactionId}:${contextId}` */
  contextLocalIndexes: Array<[string, number[]]>;
  opcodeLocalIndexes: Array<[number, number[]]>;
  parseMs: number;
  indexBuildMs: number;
}

// 需要保留部分栈数据的 opcode 集合
const _NEEDS_STACK = new Set([
  0x54, // SLOAD
  0x55, // SSTORE
  0xa1, 0xa2, 0xa3, 0xa4, // LOG1-LOG4
  0xf1, // CALL
  0xfa, // STATICCALL
  0xf4, // DELEGATECALL
]);

/**
 * 解析 step batch 二进制数据
 * 格式：每个 step = transaction_id(4) + context_id(2) + depth(2) + pc(8) + opcode(1) + gas_cost(8) + gas_remaining(8) + stack_len(2) + stack_data(N*32)
 *                  + frame_step_count(8)
 */
export function parseStepBatch(data: Uint8Array): StepData[] {
  // 最小 step 约 54 字节（无栈无内存），预分配上限避免多次扩容
  const steps: StepData[] = [];
  steps.length = Math.ceil(data.length / 54);
  let stepCount = 0;
  let offset = 0;

  while (offset < data.length) {
    // 0. Transaction ID (4 bytes, big-endian)
    if (offset + 4 > data.length) break;
    let transactionId = 0;
    for (let i = 0; i < 4; i++) {
      transactionId = transactionId * 256 + data[offset + i];
    }
    offset += 4;

    // 1. Context ID (2 bytes, big-endian)
    if (offset + 2 > data.length) break;
    const contextId = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    // 2. Depth (2 bytes, big-endian)
    if (offset + 2 > data.length) break;
    const depth = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    // 3. PC (8 bytes, big-endian)
    if (offset + 8 > data.length) break;
    let pc = 0;
    for (let i = 0; i < 8; i++) {
      pc = pc * 256 + data[offset + i];
    }
    offset += 8;

    // 4. Opcode (1 byte)
    if (offset + 1 > data.length) break;
    const opcode = data[offset];
    offset += 1;

    // 5. Gas Cost (8 bytes, big-endian)
    if (offset + 8 > data.length) break;
    let gasCost = 0;
    for (let i = 0; i < 8; i++) {
      gasCost = gasCost * 256 + data[offset + i];
    }
    offset += 8;

    // 6. Gas Remaining (8 bytes, big-endian)
    if (offset + 8 > data.length) break;
    let gasRemaining = 0;
    for (let i = 0; i < 8; i++) {
      gasRemaining = gasRemaining * 256 + data[offset + i];
    }
    offset += 8;

    // 7. Stack Length (2 bytes, big-endian)
    if (offset + 2 > data.length) break;
    const stackLen = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    // 7. Stack Data (stackLen * 32 bytes) — 只对需要的 opcode 解析栈顶 3 项
    let stackTop: string | undefined;
    let stackSecond: string | undefined;
    let stackThird: string | undefined;
    if (_NEEDS_STACK.has(opcode) && stackLen >= 1) {
      const topOff = offset + (stackLen - 1) * 32;
      stackTop = '0x' + _u8ToHex(data, topOff, topOff + 32);
      if (stackLen >= 2) {
        const secOff = offset + (stackLen - 2) * 32;
        stackSecond = '0x' + _u8ToHex(data, secOff, secOff + 32);
      }
      if (stackLen >= 3) {
        const thirdOff = offset + (stackLen - 3) * 32;
        stackThird = '0x' + _u8ToHex(data, thirdOff, thirdOff + 32);
      }
    }
    offset += stackLen * 32; // 跳过所有栈数据

    // 8. Frame step count (8 bytes)
    if (offset + 8 > data.length) break;
    let frameStepCount = 0;
    for (let i = 0; i < 8; i++) {
      frameStepCount = frameStepCount * 256 + data[offset + i];
    }
    offset += 8;

    steps[stepCount++] = {
      transactionId,
      contextId,
      depth,
      pc,
      opcode,
      gasCost,
      gasRemaining,
      frameStepCount,
      stackTop,
      stackSecond,
      stackThird,
    };
  }

  steps.length = stepCount;
  return steps;
}

export function buildStepBatchLocalIndexes(steps: StepData[]): Pick<ParsedStepBatchResult, "contextLocalIndexes" | "opcodeLocalIndexes"> {
  const contextMap = new Map<string, number[]>();
  const opcodeMap = new Map<number, number[]>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const sk = frameScopeKeyFromStep(step);
    let ctx = contextMap.get(sk);
    if (!ctx) {
      ctx = [];
      contextMap.set(sk, ctx);
    }
    ctx.push(i);
    let op = opcodeMap.get(step.opcode);
    if (!op) {
      op = [];
      opcodeMap.set(step.opcode, op);
    }
    op.push(i);
  }
  return {
    contextLocalIndexes: Array.from(contextMap.entries()),
    opcodeLocalIndexes: Array.from(opcodeMap.entries()),
  };
}

// ─── Compact (transferable) step encoding ─────────────────────────────────────
// 每个 step 编码为 8 个 float64：
//   [transactionId, contextId, depth, pc, opcode, gasCost, gasRemaining, frameStepCount]
// 需要栈数据的步骤（SLOAD/SSTORE/CALL 等）单独保存为稀疏 stackEntries。
// Float64Array 可零复制 transfer，彻底避免 Worker→主线程的结构化克隆开销。

export interface StepStackEntry {
  i: number;       // batch 内步骤索引
  top: string;
  sec?: string;
  third?: string;
}

/**
 * 将 step batch 二进制直接解析为可 transfer 的 Float64Array，
 * 不创建任何 StepData 对象，Worker 侧零 GC 压力。
 */
export function parseStepBatchCompact(data: Uint8Array): {
  compact: Float64Array;
  stackEntries: StepStackEntry[];
} {
  // 最小 step 43 字节（零栈）；预分配上限
  const maxSteps = Math.ceil(data.length / 43);
  const buf = new Float64Array(maxSteps * 8);
  const stackEntries: StepStackEntry[] = [];
  let stepCount = 0;
  let offset = 0;

  while (offset < data.length) {
    if (offset + 4 > data.length) break;
    let transactionId = 0;
    for (let i = 0; i < 4; i++) transactionId = transactionId * 256 + data[offset + i];
    offset += 4;

    if (offset + 2 > data.length) break;
    const contextId = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    if (offset + 2 > data.length) break;
    const depth = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    if (offset + 8 > data.length) break;
    let pc = 0;
    for (let i = 0; i < 8; i++) pc = pc * 256 + data[offset + i];
    offset += 8;

    if (offset + 1 > data.length) break;
    const opcode = data[offset];
    offset += 1;

    if (offset + 8 > data.length) break;
    let gasCost = 0;
    for (let i = 0; i < 8; i++) gasCost = gasCost * 256 + data[offset + i];
    offset += 8;

    if (offset + 8 > data.length) break;
    let gasRemaining = 0;
    for (let i = 0; i < 8; i++) gasRemaining = gasRemaining * 256 + data[offset + i];
    offset += 8;

    if (offset + 2 > data.length) break;
    const stackLen = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    let stackTop: string | undefined, stackSecond: string | undefined, stackThird: string | undefined;
    if (_NEEDS_STACK.has(opcode) && stackLen >= 1) {
      const topOff = offset + (stackLen - 1) * 32;
      stackTop = '0x' + _u8ToHex(data, topOff, topOff + 32);
      if (stackLen >= 2) {
        const secOff = offset + (stackLen - 2) * 32;
        stackSecond = '0x' + _u8ToHex(data, secOff, secOff + 32);
      }
      if (stackLen >= 3) {
        const thirdOff = offset + (stackLen - 3) * 32;
        stackThird = '0x' + _u8ToHex(data, thirdOff, thirdOff + 32);
      }
    }
    offset += stackLen * 32;

    if (offset + 8 > data.length) break;
    let frameStepCount = 0;
    for (let i = 0; i < 8; i++) frameStepCount = frameStepCount * 256 + data[offset + i];
    offset += 8;

    const b = stepCount * 8;
    buf[b]     = transactionId;
    buf[b + 1] = contextId;
    buf[b + 2] = depth;
    buf[b + 3] = pc;
    buf[b + 4] = opcode;
    buf[b + 5] = gasCost;
    buf[b + 6] = gasRemaining;
    buf[b + 7] = frameStepCount;

    if (stackTop !== undefined) {
      stackEntries.push({ i: stepCount, top: stackTop, sec: stackSecond, third: stackThird });
    }
    stepCount++;
  }

  // slice() 生成裁剪后的新 buffer（可 transfer）
  return { compact: buf.slice(0, stepCount * 8), stackEntries };
}

/**
 * 从 compact 格式构建 context/opcode 索引（在 Worker 侧调用）。
 */
export function buildIndexesFromCompact(compact: Float64Array): Pick<ParsedStepBatchResult, "contextLocalIndexes" | "opcodeLocalIndexes"> {
  const N = (compact.length / 8) | 0;
  const contextMap = new Map<string, number[]>();
  const opcodeMap = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const b = i * 8;
    const sk = `${compact[b]}:${compact[b + 1]}`;
    let ctx = contextMap.get(sk);
    if (!ctx) { ctx = []; contextMap.set(sk, ctx); }
    ctx.push(i);
    const opcode = compact[b + 4];
    let op = opcodeMap.get(opcode);
    if (!op) { op = []; opcodeMap.set(opcode, op); }
    op.push(i);
  }
  return {
    contextLocalIndexes: Array.from(contextMap.entries()),
    opcodeLocalIndexes: Array.from(opcodeMap.entries()),
  };
}

/**
 * 主线程侧：将 compact Float64Array + stackEntries 拆包为 StepData[]。
 * 紧凑循环，无结构化克隆开销。
 */
export function unpackCompactToSteps(compact: Float64Array, stackEntries: StepStackEntry[]): StepData[] {
  const N = (compact.length / 8) | 0;
  const steps = new Array<StepData>(N);
  for (let i = 0; i < N; i++) {
    const b = i * 8;
    steps[i] = {
      transactionId: compact[b],
      contextId:     compact[b + 1],
      depth:         compact[b + 2],
      pc:            compact[b + 3],
      opcode:        compact[b + 4],
      gasCost:       compact[b + 5],
      gasRemaining:  compact[b + 6],
      frameStepCount: compact[b + 7],
    };
  }
  for (const entry of stackEntries) {
    const s = steps[entry.i];
    s.stackTop    = entry.top;
    s.stackSecond = entry.sec;
    s.stackThird  = entry.third;
  }
  return steps;
}
