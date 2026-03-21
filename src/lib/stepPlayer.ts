// Step 数据解析和播放相关的工具函数

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
 * 格式：每个 step = context_id(2) + depth(2) + pc(8) + opcode(1) + gas_cost(8) + gas_remaining(8) + stack_len(2) + stack_data(N*32)
 *                  + frame_step_count(8)
 */
export function parseStepBatch(data: Uint8Array): StepData[] {
  // 最小 step 约 50 字节（无栈无内存），预分配上限避免多次扩容
  const steps: StepData[] = [];
  steps.length = Math.ceil(data.length / 50);
  let stepCount = 0;
  let offset = 0;

  while (offset < data.length) {
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

    steps[stepCount++] = { contextId, depth, pc, opcode, gasCost, gasRemaining, frameStepCount, stackTop, stackSecond, stackThird };
  }

  steps.length = stepCount;
  return steps;
}
