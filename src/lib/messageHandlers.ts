import { parseStepBatch, type StepData } from "./stepPlayer";
import { disassemble, type Opcode } from "./opcodes";
import { useDebugStore } from "@/store/debugStore";
import { toast } from "sonner";
import {
    MsgType,
    type LogEntry,
    type MemoryPatch,
    type MemorySnapshot,
    type ReturnDataEntry,
    type StorageChangeEntry,
    type CallFrame,
    type CallTreeNode,
    type MessageHandlerContext,
} from "./types";

// Re-export types for backward compatibility
export { MsgType, InstructionResult } from "./types";
export type { LogEntry, MemoryPatch, MemorySnapshot, ReturnDataEntry, StorageChangeEntry, CallFrame, CallTreeNode, CallTreeNodeType, MessageHandlerContext } from "./types";

// 缓存收到的 FrameEnter，等 ContractSource 到来时填充到 CallFrame
const pendingFrameEnters = new Map<number, Record<string, unknown>>();

export function resetPendingFrameEnters() {
    pendingFrameEnters.clear();
}

// ─── 节流：setCallFrames 最多每 200ms 触发一次 ─────────────────────────────────
let _callFramesFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCallFramesFlush(context: MessageHandlerContext) {
    if (_callFramesFlushTimer !== null) return;
    _callFramesFlushTimer = setTimeout(() => {
        _callFramesFlushTimer = null;
        context.setCallFrames([...context.callFramesRef.current]);
    }, 200);
}

/**
 * 处理 StepBatch 消息
 */
export function handleStepBatch(
    body: Uint8Array,
    context: MessageHandlerContext
) {
    // console.log(`[StepBatch] 收到消息，body长度: ${body.length}`);
    const steps = parseStepBatch(body);
    // console.log(`[StepBatch] 解析完成，得到 ${steps.length} 步`);

    const prevCount = context.allStepsRef.current.length;
    // 直接修改数组，避免创建新数组和复制开销
    context.allStepsRef.current.push(...steps);
    const newCount = context.allStepsRef.current.length;

    // 同步更新 per-context 步骤索引 + opcode 索引（O(batch) 追加，无额外遍历）
    const stepIdx = context.stepIndexByContext.current;
    const opcodeIdx = context.opcodeIndex.current;
    for (let i = prevCount; i < newCount; i++) {
        const step = context.allStepsRef.current[i];
        let arr = stepIdx.get(step.contextId);
        if (!arr) { arr = []; stepIdx.set(step.contextId, arr); }
        arr.push(i);
        let oarr = opcodeIdx.get(step.opcode);
        if (!oarr) { oarr = []; opcodeIdx.set(step.opcode, oarr); }
        oarr.push(i);
    }

    // 每跨越一个 500 步边界才更新 stepCount，减少 React 重渲染
    if (Math.floor(prevCount / 500) !== Math.floor(newCount / 500) || prevCount === 0) {
        context.setStepCount(newCount);
    }

    // 第一批数据时，检查是否可以应用第一步
    if (prevCount === 0 && steps.length > 0) {
        const firstStep = steps[0];
        const matchingFrame = context.callFramesRef.current.find(
            f => f.contextId === firstStep.contextId
        );
        if (matchingFrame) {
            context.applyStep(0);
        }
    }
}

/**
 * 处理 ContractSource 消息
 */
export function handleContractSource(
    body: Uint8Array,
    context: MessageHandlerContext
) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);

    const depth = dv.getUint16(0, false);
    const contextId = dv.getUint16(2, false);
    const bytecodeLen = dv.getUint32(4, false);
    const bytecode = body.slice(8, 8 + bytecodeLen);

    // console.log(
    //     `收到 contract bytecode: depth=${depth}, contextId=${contextId}, bytecode长度=${bytecode.length}`
    // );


    const disassembleResult = disassemble(bytecode);
    const opcodes: Opcode[] = disassembleResult.map((instr) => ({
        pc: instr.pc,
        name: instr.name,
        data: instr.data,
        gas: undefined,
        category: instr.category,
        warning: instr.warning,
        isMetadata: instr.isMetadata,
    }));

    const newFrame: CallFrame = {
        id: `frame-${contextId}`,
        contextId: contextId,
        depth: depth,
        address: '',
        opcodes,
        stack: [],
        memory: "",
        storageChanges: [],
        currentPc: opcodes[0]?.pc,
        logs: [],
        memoryPatches: [],      // 保留字段以兼容其他引用，不再使用
        memorySnapshots: [],     // 保留字段以兼容其他引用，不再使用
        returnDataList: [],
    };

    // 取之前缓存的 FrameEnter 填充 caller / target / contract / gasLimit / value
    const pending = pendingFrameEnters.get(contextId);
    if (pending) {
        newFrame.caller   = pending.caller as string;
        newFrame.target   = pending.target_address as string;
        newFrame.contract = pending.address as string;
        newFrame.gasLimit = pending.gas_limit as number;
        newFrame.value    = pending.value as string;
        newFrame.input    = pending.input as string;
        newFrame.gasUsed  = 0;
        newFrame.callType = (pending.kind as string)?.toLowerCase() as CallFrame["callType"];
        newFrame.parentId = pending.parent_id as number;
        pendingFrameEnters.delete(contextId);
    }

    context.callFramesRef.current = [...context.callFramesRef.current, newFrame];
    scheduleCallFramesFlush(context);

    // 如果还没有开始播放，检查是否可以应用某一步
    if (
        context.currentStepIndexRef.current === -1 &&
        context.allStepsRef.current.length > 0
    ) {
        const firstValidIndex = context.allStepsRef.current.findIndex(step =>
            context.callFramesRef.current.some(f => f.contextId === step.contextId)
        );
        if (firstValidIndex >= 0) {
            const step = context.allStepsRef.current[firstValidIndex];
            const frame = context.callFramesRef.current.find(
                f => f.contextId === step.contextId
            );
            context.setActiveTab(frame!.id);
            context.applyStep(firstValidIndex);
        } else {
            context.setActiveTab(newFrame.id);
        }
    }
}

/**
 * 处理 ContextUpdateAddress 消息
 */
export function handleContextUpdateAddress(
    body: Uint8Array,
    context: MessageHandlerContext
) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);

    const contextId = dv.getUint16(0, false);
    const addressBytes = body.slice(2, 22);
    const address = '0x' + Array.from(addressBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    const frame = context.callFramesRef.current.find(f => f.contextId === contextId);
    if (frame) {
        frame.address = address;
        scheduleCallFramesFlush(context);
    }
}

/**
 * 处理 Logs 消息
 */
export function handleLogs(
    body: Uint8Array,
    context: MessageHandlerContext
) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);

    const contextId = dv.getUint16(0, false);
    const stepCount = Number(dv.getBigUint64(2, false));
    const jsonData = new TextDecoder().decode(body.slice(10));

    try {
        const logData = JSON.parse(jsonData);
        const logEntry: LogEntry = {
            address: logData.address,
            topics: logData.topics || [],
            data: logData.data || '0x',
            stepIndex: stepCount,
            contextId: contextId,
        };

        const frame = context.callFramesRef.current.find(f => f.contextId === contextId);
        if (frame) {
            frame.logs.push(logEntry);
            scheduleCallFramesFlush(context);
        }
    } catch (error) {
        console.error('解析 log JSON 失败:', error, jsonData);
    }
}

/**
 * 处理 MemoryUpdate 消息 - 存储增量更新，在播放时应用
 */
export function handleMemoryUpdate(
    body: Uint8Array,
    context: MessageHandlerContext
) {
    // return;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);

    const contextId = dv.getUint16(0, false);
    const frameStepCount = Number(dv.getBigUint64(2, false));
    const dstOffset = dv.getUint32(10, false);
    const memoryData = body.slice(14);

    // console.log(
    //     `收到 memory update: contextId=${contextId}, frameStepCount=${frameStepCount}, dstOffset=${dstOffset}, dataLen=${memoryData.length}`
    // );

    // if (contextId === 76) {
    //     const hex = '0x' + Array.from(memoryData).map(b => b.toString(16).padStart(2, '0')).join('');
    //     console.log(`[ctx76] MemoryUpdate frameStep=${frameStepCount} dstOffset=${dstOffset} len=${memoryData.length} data=${hex}`);
    // }

    // 直接 push 到 ref，立即可见，不走 React 异步队列
    const patch: MemoryPatch = {
        frameStepCount,
        dstOffset,
        data: new Uint8Array(memoryData),  // 复制一份，避免引用问题
    };

    const frame = context.callFramesRef.current.find(f => f.contextId === contextId);
    if (frame) {
        frame.memoryPatches.push(patch);
    }
}

/**
 * 处理 ReturnData 消息 - 存储 frame 的返回数据
 * 格式: context_id(2) + step_count(8) + return_data(剩余字节)
 */
export function handleReturnData(
    body: Uint8Array,
    context: MessageHandlerContext
) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);

    const contextId = dv.getUint16(0, false);
    const stepIndex = Number(dv.getBigUint64(2, false));
    const returnData = body.slice(10);

    // 转换为 hex string
    const dataHex = '0x' + Array.from(returnData)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    const entry: ReturnDataEntry = {
        stepIndex,
        contextId,
        data: dataHex,
    };

    const frame = context.callFramesRef.current.find(f => f.contextId === contextId);
    if (frame) {
        frame.returnDataList.push(entry);
        scheduleCallFramesFlush(context);
    }
}

/**
 * 处理 StorageChange 消息
 * 格式: storage_type(1) + is_read(1) + context_id(2) + step_index(8) + address(20) + slot(32) + old_value(32) + new_value(32)
 */
export function handleStorageChange(
    body: Uint8Array,
    context: MessageHandlerContext
) {

    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const storageType = body[0] === 0 ? "storage" : "tstorage";
    const isRead = body[1] === 1;
    const contextId = dv.getUint16(2, false);
    const stepIndex = Number(dv.getBigUint64(4, false));
    const toHex = (slice: Uint8Array) =>
        '0x' + Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join('');
    const address = toHex(body.slice(12, 32));
    const key     = toHex(body.slice(32, 64));
    const hadValue = toHex(body.slice(64, 96));
    const newValue = toHex(body.slice(96, 128));

    const entry: StorageChangeEntry = {isRead, storageType, stepIndex, contextId, address, key, hadValue, newValue };

    const frame = context.callFramesRef.current.find(f => f.contextId === contextId);
    if (frame) {
        frame.storageChanges.push(entry);
        // 不触发 React 重渲染，播放时前端会直接读 ref
    }
}

// ─────────────────────────────────────────────
// computeMemoryAtStep 专用查找表
// ─────────────────────────────────────────────
const _MEM_HEX = (() => {
    const t = new Array<string>(256);
    for (let i = 0; i < 256; i++) t[i] = i.toString(16).padStart(2, '0');
    return t;
})();
// 十六进制字符 → 数值（charCode → nibble）
const _UNHEX = (() => {
    const t = new Uint8Array(128);
    for (let i = 0; i < 10; i++) t[48 + i] = i;        // '0'–'9'
    for (let i = 0; i < 6; i++) t[97 + i] = 10 + i;   // 'a'–'f'
    return t;
})();

/**
 * 计算指定 frameStepCount 时的内存状态
 * @param snapshots 全量内存快照列表
 * @param patches 增量补丁列表
 * @param frameStepCount 目标步骤数
 * @returns 计算后的内存 (hex string)
 */
export function computeMemoryAtStep(
    snapshots: MemorySnapshot[],
    patches: MemoryPatch[],
    frameStepCount: number
): string {
    if (snapshots.length === 0) return "0x";

    // 二分找最大的 <= frameStepCount 快照（snapshots 单调递增追加）
    let lo = 0, hi = snapshots.length - 1, snapshotIdx = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (snapshots[mid].frameStepCount <= frameStepCount) { snapshotIdx = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    if (snapshotIdx === -1) return "0x";

    const baseSnapshot = snapshots[snapshotIdx];
    const snapshotStep = baseSnapshot.frameStepCount;

    // 二分找 patch 范围，无需 filter() 也无需 sort()（patches 单调递增追加，天然有序）
    // patchStart: 第一个 frameStepCount > snapshotStep
    let patchStart = patches.length;
    lo = 0; hi = patches.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (patches[mid].frameStepCount > snapshotStep) { patchStart = mid; hi = mid - 1; }
        else lo = mid + 1;
    }
    // patchEnd: 最后一个 frameStepCount <= frameStepCount
    let patchEnd = patchStart - 1;
    lo = patchStart; hi = patches.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (patches[mid].frameStepCount <= frameStepCount) { patchEnd = mid; lo = mid + 1; }
        else hi = mid - 1;
    }

    if (patchStart > patchEnd) return baseSnapshot.memory;

    // 转换基础内存为字节数组
    let memHex = baseSnapshot.memory;
    if (memHex.startsWith('0x')) memHex = memHex.slice(2);

    // 计算所需的最大内存大小
    let maxSize = memHex.length >> 1;
    for (let i = patchStart; i <= patchEnd; i++) {
        const end = patches[i].dstOffset + patches[i].data.length;
        if (end > maxSize) maxSize = end;
    }

    const memBytes = new Uint8Array(maxSize);

    // 填充基础内存 — charCode 查表替代 parseInt，快约 3×
    for (let i = 0, j = 0; j < memHex.length; i++, j += 2) {
        memBytes[i] = (_UNHEX[memHex.charCodeAt(j)] << 4) | _UNHEX[memHex.charCodeAt(j + 1)];
    }

    // patches 已天然有序，直接遍历，无需 sort
    for (let i = patchStart; i <= patchEnd; i++) {
        const p = patches[i];
        memBytes.set(p.data, p.dstOffset);
    }

    // 转回 hex string — 查找表加速
    const hexParts = new Array<string>(memBytes.length);
    for (let i = 0; i < memBytes.length; i++) hexParts[i] = _MEM_HEX[memBytes[i]];
    return '0x' + hexParts.join('');
}

/**
 * 主消息处理器
 */
export function handleMessage(
    message: unknown,
    context: MessageHandlerContext
): void {
    if (!(message instanceof ArrayBuffer)) return;

    const data = new Uint8Array(message);
    const msgType = data[0];
    const body = data.slice(1);

    switch (msgType) {
        case MsgType.StepBatch:
            handleStepBatch(body, context);
            break;

        case MsgType.ContractSource:
            handleContractSource(body, context);
            break;

        case MsgType.ContextUpdateAddress:
            handleContextUpdateAddress(body, context);
            break;

        case MsgType.Logs:
            handleLogs(body, context);
            break;

        case MsgType.MemoryUpdate:
            // 内存已改由 seek_to IPC 获取，不再通过 channel 发送
            break;

        case MsgType.ReturnData:
            handleReturnData(body, context);
            break;

        case MsgType.StorageChange:
            handleStorageChange(body, context);
            break;

        case MsgType.FrameExit: {
            // body = [frame_id:2] [result:1] [success:1] [gas_used:8] [output_len:4] [output:N]
            const exitDv = new DataView(body.buffer, body.byteOffset, body.byteLength);
            const exitFrameId = exitDv.getUint16(0, false);
            const exitResult = exitDv.getUint8(2);
            const exitSuccess = exitDv.getUint8(3) === 1;
            const exitGasUsed = Number(exitDv.getBigUint64(4, false));
            const exitOutputLen = exitDv.getUint32(12, false);
            const exitOutputBytes = body.slice(16, 16 + exitOutputLen);
            const exitOutput = '0x' + Array.from(exitOutputBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            const exitFrame = context.callFramesRef.current.find(f => f.contextId === exitFrameId);
            if (exitFrame) {
                exitFrame.exitCode = exitResult;
                exitFrame.success = exitSuccess;
                exitFrame.gasUsed = exitGasUsed;
                exitFrame.exitOutput = exitOutput;
                scheduleCallFramesFlush(context);
            }
            break;
        }

        case MsgType.SelfDestruct: {
            // body = [frame_id:2] [contract:20] [target:20] [value:32]
            const sdDv = new DataView(body.buffer, body.byteOffset, body.byteLength);
            const sdFrameId = sdDv.getUint16(0, false);
            const sdContract = '0x' + Array.from(body.slice(2, 22)).map(b => b.toString(16).padStart(2, '0')).join('');
            const sdTarget = '0x' + Array.from(body.slice(22, 42)).map(b => b.toString(16).padStart(2, '0')).join('');
            const sdValueBytes = body.slice(42, 74);
            const sdValue = '0x' + Array.from(sdValueBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            const sdFrame = context.callFramesRef.current.find(f => f.contextId === sdFrameId);
            if (sdFrame) {
                sdFrame.selfdestructContract = sdContract;
                sdFrame.selfdestructTarget = sdTarget;
                sdFrame.selfdestructValue = sdValue;
                scheduleCallFramesFlush(context);
            }
            break;
        }

        case MsgType.FrameEnter: {
            const frameInfo = JSON.parse(new TextDecoder().decode(body));
            console.log('[FrameEnter] frame_id=', frameInfo.frame_id, ' kind=', frameInfo.kind, ' raw=', frameInfo);
            pendingFrameEnters.set(frameInfo.frame_id as number, frameInfo);
            break;
        }

        case MsgType.BalanceChanges: {
            try {
                const changes = JSON.parse(new TextDecoder().decode(body));
                useDebugStore.getState().sync({ balanceChanges: changes });
            } catch (e) {
                console.error('[BalanceChanges] parse failed', e);
            }
            break;
        }

        case MsgType.Finished: {
            // 清除节流定时器，强制最终刷新
            if (_callFramesFlushTimer !== null) {
                clearTimeout(_callFramesFlushTimer);
                _callFramesFlushTimer = null;
            }
            context.callTreeRef.current = buildCallTree(
                context.allStepsRef.current,
                context.callFramesRef.current
            );
            useDebugStore.getState().sync({ callTreeNodes: [...context.callTreeRef.current] });
            // 强制同步最终状态到 React
            context.setCallFrames([...context.callFramesRef.current]);
            const totalSteps = context.allStepsRef.current.length;
            context.setStepCount(totalSteps);
            context.setIsDebugging(false);
            toast.success(`Ready — ${totalSteps.toLocaleString()} steps`, { id: "debug-finished" });
            break;
        }

        default: {
            // 其他未知消息
            const errorMsg = new TextDecoder().decode(body);
            console.log("收到未知消息类型:", msgType, errorMsg);
            break;
        }
    }
}

// ─────────────────────────────────────────────
// Call Tree
// ─────────────────────────────────────────────

/**
 * 在调试结束后一次性构建扁平 call tree 节点列表
 * O(n) 单次遍历
 */
export function buildCallTree(steps: StepData[], frames: CallFrame[]): CallTreeNode[] {
    const nodes: CallTreeNode[] = [];
    const seenContextIds = new Set<number>();
    const frameMap = new Map(frames.map(f => [f.contextId, f]));

    // 计算传递性回滚集合：自身失败 OR 任意祖先 frame 失败
    // EVM 规则：父 call revert 时，所有子调用的状态变更一并回滚
    const failedContextIds = new Set<number>(
        frames.filter(f => f.success === false).map(f => f.contextId)
    );
    const revertedContextIds = new Set<number>();
    for (const frame of frames) {
        let cur: CallFrame | undefined = frame;
        while (cur) {
            if (failedContextIds.has(cur.contextId)) {
                revertedContextIds.add(frame.contextId);
                break;
            }
            cur = cur.parentId != null ? frameMap.get(cur.parentId) : undefined;
        }
    }

    // Pre-build per-context log queues sorted by stepIndex for sequential consumption
    const logQueueByContext = new Map<number, LogEntry[]>();
    for (const frame of frames) {
        logQueueByContext.set(frame.contextId, [...frame.logs].sort((a, b) => a.stepIndex - b.stepIndex));
    }
    const logPtrByContext = new Map<number, number>();

    // Pre-build storageChange lookup: "contextId:stepIndex" → StorageChangeEntry
    const storageChangeMap = new Map<string, StorageChangeEntry>();
    for (const frame of frames) {
        for (const sc of frame.storageChanges) {
            storageChangeMap.set(`${sc.contextId}:${sc.stepIndex}`, sc);
        }
    }

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        // frame 节点：contextId 首次出现时插入
        if (!seenContextIds.has(step.contextId)) {
            seenContextIds.add(step.contextId);
            const frame = frameMap.get(step.contextId);
            nodes.push({
                id: nodes.length,
                type: 'frame',
                stepIndex: i,
                contextId: step.contextId,
                depth: step.depth,
                callType: frame?.callType,
                address: frame?.address,
                caller: frame?.caller,
                target: frame?.target,
                value: frame?.value,
                input: frame?.input,
                success: frame?.success,
                gasUsed: frame?.gasUsed,
                selfdestructContract: frame?.selfdestructContract,
                selfdestructTarget: frame?.selfdestructTarget,
                selfdestructValue: frame?.selfdestructValue,
            });
        }

        const op = step.opcode;

        // SLOAD (0x54): stack top = slot
        if (op === 0x54 && step.stackTop) {
            const sc = storageChangeMap.get(`${step.contextId}:${i + 1}`);
            nodes.push({
                id: nodes.length,
                type: 'sload',
                stepIndex: i,
                contextId: step.contextId,
                depth: step.depth + 1,
                slot: step.stackTop,
                oldValue: sc?.newValue,
            });
        }
        // SSTORE (0x55): stack[top]=slot, stack[top-1]=value
        else if (op === 0x55 && step.stackTop) {
            // Backend records step_idx = step_count AFTER the +1 increment in step(),
            // so the storage change for step i is keyed by i+1.
            const sc = storageChangeMap.get(`${step.contextId}:${i + 1}`);
            nodes.push({
                id: nodes.length,
                type: 'sstore',
                stepIndex: i,
                contextId: step.contextId,
                depth: step.depth + 1,
                slot: step.stackTop,
                oldValue: sc?.hadValue,
                newValue: sc?.newValue ?? step.stackSecond,
                reverted: revertedContextIds.has(step.contextId),
            });
        }
        // TLOAD (0x5c): transient storage load, stack top = slot
        else if (op === 0x5c && step.stackTop) {
            nodes.push({
                id: nodes.length,
                type: 'tload',
                stepIndex: i,
                contextId: step.contextId,
                depth: step.depth + 1,
                slot: step.stackTop,
            });
        }
        // TSTORE (0x5d): transient storage write, stack[top]=slot, stack[top-1]=value
        else if (op === 0x5d && step.stackTop) {
            const sc = storageChangeMap.get(`${step.contextId}:${i + 1}`);
            nodes.push({
                id: nodes.length,
                type: 'tstore',
                stepIndex: i,
                contextId: step.contextId,
                depth: step.depth + 1,
                slot: step.stackTop,
                oldValue: sc?.hadValue,
                newValue: sc?.newValue ?? step.stackSecond,
                reverted: revertedContextIds.has(step.contextId),
            });
        }
        // LOG0-LOG4 (0xa0-0xa4): consume from per-context log queue
        else if (op >= 0xa0 && op <= 0xa4) {
            const queue = logQueueByContext.get(step.contextId) ?? [];
            const ptr = logPtrByContext.get(step.contextId) ?? 0;
            const logEntry = queue[ptr];
            logPtrByContext.set(step.contextId, ptr + 1);
            nodes.push({
                id: nodes.length,
                type: 'log',
                stepIndex: i,
                contextId: step.contextId,
                depth: step.depth + 1,
                topics: logEntry?.topics ?? [],
                logData: logEntry?.data,
                reverted: revertedContextIds.has(step.contextId),
            });
        }
    }

    return nodes;
}
