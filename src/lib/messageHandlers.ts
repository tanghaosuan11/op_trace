import type { ParsedStepBatchResult, StepData, StepStackEntry } from "./stepPlayer";
import { unpackCompactToSteps, unpackCompactStep } from "./stepPlayer";
import StepBatchWorkerInline from "./stepBatchWorker.ts?worker&inline";
import { frameScopeKey, frameScopeKeyFromFrame, frameScopeKeyFromStep } from "./frameScope";
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
    type StateChangeEntry,
    type KeccakEntry,
    type AddressBalance,
    type CallFrame,
    type CallTreeNode,
    type MessageHandlerContext,
    type MessageRuntimeState,
} from "./types";

// Re-export types for backward compatibility
export { MsgType, InstructionResult } from "./types";
export type { LogEntry, MemoryPatch, MemorySnapshot, ReturnDataEntry, StorageChangeEntry, StateChangeEntry, KeccakEntry, CallFrame, CallTreeNode, CallTreeNodeType, MessageHandlerContext } from "./types";

/** 流式阶段减少 Zustand 与 CFG emit 频率（仍会在首步与 finalize 刷新）。 */
const STEP_COUNT_STORE_INTERVAL = 15_000;

export function createMessageRuntimeState(): MessageRuntimeState {
    return {
        pendingFrameEnters: new Map<string, Record<string, unknown>>(),
        frameByCtx: new Map<string, CallFrame>(),
        firstStepIndexByScope: new Map<string, number>(),
        disasmCache: new Map<string, Opcode[]>(),
        callFramesFlushTimer: null,
        debugStartPerfMs: null,
        finishedPerfLogged: false,
        perfStreamLastLogMs: 0,
        perfStepBatchCount: 0,
        perfStepParseMs: 0,
        perfStepIndexMs: 0,
        perfContractSourceCount: 0,
        perfContractDisasmMs: 0,
        perfContractHexMs: 0,
        stepBatchWorker: null,
        stepBatchRequestSeq: 0,
        stepBatchNextResultSeq: 0,
        stepBatchPendingCount: 0,
        stepBatchPendingResults: new Map(),
        finishedDeferred: false,
        startDebugInFlight: false,
        allCompactBatches: [],
        totalStreamedStepCount: 0,
        keccakOps: new Map(),
    };
}

export function markDebugPerfStart(runtime: MessageRuntimeState) {
    const now = performance.now();
    runtime.debugStartPerfMs = now;
    runtime.finishedPerfLogged = false;
    runtime.perfStreamLastLogMs = now;
    runtime.perfStepBatchCount = 0;
    runtime.perfStepParseMs = 0;
    runtime.perfStepIndexMs = 0;
    runtime.perfContractSourceCount = 0;
    runtime.perfContractDisasmMs = 0;
    runtime.perfContractHexMs = 0;
    runtime.stepBatchRequestSeq = 0;
    runtime.stepBatchNextResultSeq = 0;
    runtime.stepBatchPendingCount = 0;
    runtime.stepBatchPendingResults.clear();
    runtime.finishedDeferred = false;
    runtime.startDebugInFlight = false;
    runtime.allCompactBatches = [];
    runtime.totalStreamedStepCount = 0;
    runtime.keccakOps.clear();
}

function _hashBytecode(bytes: Uint8Array): string {
    // FNV-1a 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193);
    }
    return `${bytes.length}:${(h >>> 0).toString(36)}`;
}

const HEX_TABLE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function fastHex(bytes: Uint8Array): string {
    let out = "0x";
    for (let i = 0; i < bytes.length; i++) out += HEX_TABLE[bytes[i]];
    return out;
}

function maybeLogStreamPerf(context: MessageHandlerContext) {
    if (context.runtime.debugStartPerfMs === null || context.runtime.finishedPerfLogged) return;
    const now = performance.now();
    if (now - context.runtime.perfStreamLastLogMs < 2000) return;
    context.runtime.perfStreamLastLogMs = now;
    const totalMs = now - context.runtime.debugStartPerfMs;
    const totalSteps = context.runtime.totalStreamedStepCount;
    console.log(
        `[perf.frontend.stream] ${totalMs.toFixed(0)}ms steps=${totalSteps.toLocaleString()} batches=${context.runtime.perfStepBatchCount} parse=${context.runtime.perfStepParseMs.toFixed(1)}ms index=${context.runtime.perfStepIndexMs.toFixed(1)}ms contract=${context.runtime.perfContractSourceCount} disasm=${context.runtime.perfContractDisasmMs.toFixed(1)}ms hex=${context.runtime.perfContractHexMs.toFixed(1)}ms`
    );
}

export function resetPendingFrameEnters(runtime: MessageRuntimeState) {
    runtime.pendingFrameEnters.clear();
    runtime.frameByCtx.clear();
    runtime.firstStepIndexByScope.clear();
    runtime.disasmCache.clear();
    runtime.debugStartPerfMs = null;
    runtime.finishedPerfLogged = false;
    runtime.perfStreamLastLogMs = 0;
    runtime.perfStepBatchCount = 0;
    runtime.perfStepParseMs = 0;
    runtime.perfStepIndexMs = 0;
    runtime.perfContractSourceCount = 0;
    runtime.perfContractDisasmMs = 0;
    runtime.perfContractHexMs = 0;
    runtime.stepBatchRequestSeq = 0;
    runtime.stepBatchNextResultSeq = 0;
    runtime.stepBatchPendingCount = 0;
    runtime.stepBatchPendingResults.clear();
    runtime.finishedDeferred = false;
    runtime.startDebugInFlight = false;
    runtime.allCompactBatches = [];
    runtime.totalStreamedStepCount = 0;
    runtime.keccakOps.clear();
}

/** 从 allCompactBatches 按全局下标获取 frame scope key，不分配 StepData 对象 */
function getScopeAtIndex(
    batches: Array<{ compact: Float64Array }>,
    globalIndex: number
): string | undefined {
    let offset = globalIndex;
    for (const batch of batches) {
        const batchSize = (batch.compact.length / 8) | 0;
        if (offset < batchSize) {
            const b = offset * 8;
            return `${batch.compact[b]}:${batch.compact[b + 1]}`;
        }
        offset -= batchSize;
    }
    return undefined;
}

function finalizeFinished(context: MessageHandlerContext) {
    // 清除节流定时器，强制最终刷新
    if (context.runtime.callFramesFlushTimer !== null) {
        clearTimeout(context.runtime.callFramesFlushTimer);
        context.runtime.callFramesFlushTimer = null;
    }
    // 一次性展开全部 compact 批次 → allStepsRef（流式阶段零对象分配的核心收益点）
    const t0 = performance.now();
    const allSteps: StepData[] = [];
    for (const batch of context.runtime.allCompactBatches) {
        const batchSteps = unpackCompactToSteps(batch.compact, batch.stackEntries);
        for (let i = 0; i < batchSteps.length; i++) allSteps.push(batchSteps[i]!);
    }
    context.allStepsRef.current = allSteps;
    context.runtime.allCompactBatches = [];  // 释放 compact 内存
    const t1 = performance.now();
    context.callTreeRef.current = buildCallTree(
        context.allStepsRef.current,
        context.callFramesRef.current,
        context.runtime.keccakOps
    );
    const t2 = performance.now();
    console.log(
        `[perf.finalizeFinished] unpack=${(t1 - t0).toFixed(1)}ms buildCallTree=${(t2 - t1).toFixed(1)}ms` +
        ` steps=${allSteps.length.toLocaleString()} batches=${(allSteps.length / 800).toFixed(0)}`
    );
    // 流式阶段累计耗时汇总（Worker parse + 主线程 index 构建）
    const rt = context.runtime;
    const streamTotalMs = rt.debugStartPerfMs !== null ? (t0 - rt.debugStartPerfMs) : 0;
    console.log(
        `[perf.stream.breakdown] total=${streamTotalMs.toFixed(0)}ms` +
        ` workerParse=${rt.perfStepParseMs.toFixed(0)}ms` +
        ` mainIndex=${rt.perfStepIndexMs.toFixed(0)}ms` +
        ` contract(disasm=${rt.perfContractDisasmMs.toFixed(0)}ms hex=${rt.perfContractHexMs.toFixed(0)}ms count=${rt.perfContractSourceCount})` +
        ` unaccounted=${(streamTotalMs - rt.perfStepParseMs - rt.perfStepIndexMs - rt.perfContractDisasmMs - rt.perfContractHexMs).toFixed(0)}ms`
    );
    // 一次性计算 executedOpcodeSet，避免流式阶段反复创建 Set
    const executedOpcodeSet = new Set(context.opcodeIndex.current.keys());
    useDebugStore.getState().sync({
        callTreeNodes: [...context.callTreeRef.current],
        executedOpcodeSet,
    });
    // 强制同步最终状态到 React（VM helper 帧仅用于 calltree，不进入 frame list）
    const visibleFrames = context.callFramesRef.current.filter(f => !f.isVmHelper);
    context.setCallFrames(visibleFrames);
    const totalSteps = context.allStepsRef.current.length;
    context.setStepCount(totalSteps);
    context.setIsDebugging(false);
    // 如果 activeTab 仍在 "main"（e.g. VSCode 模式下 seek_to 异步未完成），切换到第一帧
    if (useDebugStore.getState().activeTab === "main" && visibleFrames.length > 0) {
        context.setActiveTab(visibleFrames[0]!.id);
        context.applyStep(0);
    }
    if (context.runtime.debugStartPerfMs !== null && !context.runtime.finishedPerfLogged) {
        const elapsedMs = performance.now() - context.runtime.debugStartPerfMs;
        console.log(
            `[perf.frontend] startDebug -> Finished in ${elapsedMs.toFixed(1)}ms (${totalSteps.toLocaleString()} steps)`
        );
        context.runtime.finishedPerfLogged = true;
    }
    toast.success(`Ready — ${totalSteps.toLocaleString()} steps`, { id: "debug-finished" });
    useDebugStore.getState().sync({ traceFinished: true });
}

function applyParsedStepBatch(parsed: ParsedStepBatchResult, context: MessageHandlerContext) {
    context.runtime.perfStepParseMs += parsed.parseMs;
    context.runtime.perfStepIndexMs += parsed.indexBuildMs;
    context.runtime.perfStepBatchCount += 1;

    const { compact, stackEntries, stepCount: batchSize } = parsed;
    const prevTotal = context.runtime.totalStreamedStepCount;

    // 暂存 compact 批次，不创建 StepData 对象（减少 GC 压力）
    context.runtime.allCompactBatches.push({ compact, stackEntries });
    context.runtime.totalStreamedStepCount = prevTotal + batchSize;
    const newTotal = context.runtime.totalStreamedStepCount;

    const applyIndexStartMs = performance.now();
    const stepIdx = context.stepIndexByContext.current;
    const opcodeIdx = context.opcodeIndex.current;
    for (const [scopeKey, localIndexes] of parsed.contextLocalIndexes) {
        let arr = stepIdx.get(scopeKey);
        if (!arr) {
            arr = [];
            stepIdx.set(scopeKey, arr);
        }
        for (let i = 0; i < localIndexes.length; i++) arr.push(prevTotal + localIndexes[i]);
        if (!context.runtime.firstStepIndexByScope.has(scopeKey) && localIndexes.length > 0) {
            let minL = localIndexes[0]!;
            for (let i = 1; i < localIndexes.length; i++) {
                if (localIndexes[i]! < minL) minL = localIndexes[i]!;
            }
            context.runtime.firstStepIndexByScope.set(scopeKey, prevTotal + minL);
        }
    }
    for (const [opcode, localIndexes] of parsed.opcodeLocalIndexes) {
        let arr = opcodeIdx.get(opcode);
        if (!arr) {
            arr = [];
            opcodeIdx.set(opcode, arr);
        }
        for (let i = 0; i < localIndexes.length; i++) arr.push(prevTotal + localIndexes[i]);
    }
    context.runtime.perfStepIndexMs += performance.now() - applyIndexStartMs;

    if (
        prevTotal === 0 ||
        Math.floor(prevTotal / STEP_COUNT_STORE_INTERVAL) !==
            Math.floor(newTotal / STEP_COUNT_STORE_INTERVAL)
    ) {
        context.setStepCount(newTotal);
    }

    // 首批到达时：仅展开 step[0] 供 applyStep 初始导航用（1次分配而非整批）
    if (prevTotal === 0 && batchSize > 0) {
        const firstScope = `${compact[0]}:${compact[1]}`;
        if (context.runtime.frameByCtx.has(firstScope)) {
            context.allStepsRef.current[0] = unpackCompactStep(compact, stackEntries, 0);
            context.applyStep(0);
        }
    }
    maybeLogStreamPerf(context);
}

function drainParsedStepBatches(context: MessageHandlerContext) {
    while (true) {
        const parsed = context.runtime.stepBatchPendingResults.get(context.runtime.stepBatchNextResultSeq);
        if (!parsed) break;
        context.runtime.stepBatchPendingResults.delete(context.runtime.stepBatchNextResultSeq);
        context.runtime.stepBatchNextResultSeq += 1;
        applyParsedStepBatch(parsed, context);
    }
    if (context.runtime.finishedDeferred && context.runtime.stepBatchPendingCount === 0) {
        context.runtime.finishedDeferred = false;
        finalizeFinished(context);
    }
}

function ensureStepBatchWorker(context: MessageHandlerContext): Worker {
    if (context.runtime.stepBatchWorker) return context.runtime.stepBatchWorker;

    const worker = new StepBatchWorkerInline();
    worker.onmessage = (event: MessageEvent<{
        kind: "parsed"; seq: number;
        compact: Float64Array; stackEntries: StepStackEntry[];
        contextLocalIndexes: Array<[string, number[]]>;
        opcodeLocalIndexes: Array<[number, number[]]>;
        parseMs: number; indexBuildMs: number;
    }>) => {
        const msg = event.data;
        if (!msg || msg.kind !== "parsed") return;
        // compact 经 transferList 零复制到达，流式阶段直接暂存，Finished 后统一展开
        // [perf probe] 计时"假如当场展开"需要多少时间，供决策是否回到到达即展开方案
        const _t0 = performance.now();
        const _probe = unpackCompactToSteps(msg.compact, msg.stackEntries);
        const _unpackMs = performance.now() - _t0;
        void _probe; // 防止被 tree-shake
        if (context.runtime.perfStepBatchCount === 0 || context.runtime.perfStepBatchCount % 50 === 49) {
            console.log(`[perf.probe] seq=${msg.seq} unpackMs=${_unpackMs.toFixed(2)} steps=${_probe.length}`);
        }
        context.runtime.stepBatchPendingCount = Math.max(0, context.runtime.stepBatchPendingCount - 1);
        context.runtime.stepBatchPendingResults.set(msg.seq, {
            compact: msg.compact,
            stackEntries: msg.stackEntries,
            stepCount: (msg.compact.length / 8) | 0,
            contextLocalIndexes: msg.contextLocalIndexes,
            opcodeLocalIndexes: msg.opcodeLocalIndexes,
            parseMs: msg.parseMs,
            indexBuildMs: msg.indexBuildMs,
        });
        drainParsedStepBatches(context);
    };
    worker.onerror = (err) => {
        console.error("[step-batch-worker] parse failed", err);
    };
    context.runtime.stepBatchWorker = worker;
    return worker;
}

function scheduleCallFramesFlush(context: MessageHandlerContext) {
    if (context.runtime.callFramesFlushTimer !== null) return;
    context.runtime.callFramesFlushTimer = setTimeout(() => {
        context.runtime.callFramesFlushTimer = null;
        context.setCallFrames(context.callFramesRef.current.filter(f => !f.isVmHelper));
    }, 350);
}

/**
 * 处理 StepBatch 消息
 */
export function handleStepBatch(
    body: Uint8Array,
    context: MessageHandlerContext
) {
    const worker = ensureStepBatchWorker(context);
    const seq = context.runtime.stepBatchRequestSeq++;
    context.runtime.stepBatchPendingCount += 1;
    const transferBody = body.slice();
    worker.postMessage({ kind: "parse", seq, body: transferBody }, [transferBody.buffer]);
}

/**
 * 处理 FoundrySourceJson 消息（Foundry 模式源码+sourcemap，仅内存）
 * 格式: [transaction_id:4][context_id:2][json_len:4][json_bytes]
 */
export function handleFoundrySourceJson(
    body: Uint8Array,
    context: MessageHandlerContext
): void {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const transactionId = dv.getUint32(0, false);
    const contextId     = dv.getUint16(4, false);
    const jsonLen       = dv.getUint32(6, false);
    const jsonStr       = new TextDecoder().decode(body.slice(10, 10 + jsonLen));
    const frame = context.runtime.frameByCtx.get(frameScopeKey(transactionId, contextId));
    if (frame) {
        frame.foundrySourceJson = jsonStr;
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
    let transactionId = 0;
    let contextId: number;
    let bytecodeLen: number;
    let bytecode: Uint8Array;
    if (body.byteLength >= 12) {
        transactionId = dv.getUint32(2, false);
        contextId = dv.getUint16(6, false);
        bytecodeLen = dv.getUint32(8, false);
        bytecode = body.slice(12, 12 + bytecodeLen);
    } else {
        contextId = dv.getUint16(2, false);
        bytecodeLen = dv.getUint32(4, false);
        bytecode = body.slice(8, 8 + bytecodeLen);
    }
    const scope = frameScopeKey(transactionId, contextId);

    // console.log(
    //     `收到 contract bytecode: depth=${depth}, contextId=${contextId}, bytecode长度=${bytecode.length}`
    // );


    context.runtime.perfContractSourceCount += 1;
    const bcKey = _hashBytecode(bytecode);
    let opcodes = context.runtime.disasmCache.get(bcKey);
    if (!opcodes) {
        const disasmStartMs = performance.now();
        opcodes = disassemble(bytecode);
        context.runtime.perfContractDisasmMs += performance.now() - disasmStartMs;
        context.runtime.disasmCache.set(bcKey, opcodes);
    }

    // 使用紧凑循环替代 Array.from/map/join，降低大字节码的字符串化开销
    const hexStartMs = performance.now();
    const bytecodeHex = fastHex(bytecode);
    context.runtime.perfContractHexMs += performance.now() - hexStartMs;

    const newFrame: CallFrame = {
        id: `frame-${transactionId}-${contextId}`,
        contextId: contextId,
        transactionId,
        depth: depth,
        address: '',
        bytecode: bytecodeHex,
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
    const pending = context.runtime.pendingFrameEnters.get(scope);
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
        if (pending.is_vm_helper === true) {
            newFrame.isVmHelper = true;
            if (typeof pending.args === 'string' && pending.args.length > 0) {
                newFrame.vmHelperArgs = pending.args;
            }
            if (pending.insert_before_ctx_id != null) {
                newFrame.vmInsertBeforeCtxId = pending.insert_before_ctx_id as number;
            }
        }
        context.runtime.pendingFrameEnters.delete(scope);
    }

    context.callFramesRef.current.push(newFrame);
    context.runtime.frameByCtx.set(scope, newFrame);
    scheduleCallFramesFlush(context);

    // 如果还没有开始播放，检查是否可以应用某一步（用增量 firstStepIndexByScope，避免对整段 trace findIndex）
    if (
        context.currentStepIndexRef.current === -1 &&
        context.runtime.totalStreamedStepCount > 0
    ) {
        let best = -1;
        for (const scope of context.runtime.frameByCtx.keys()) {
            const idx = context.runtime.firstStepIndexByScope.get(scope);
            if (idx !== undefined && (best < 0 || idx < best)) best = idx;
        }
        if (best >= 0 && best < context.runtime.totalStreamedStepCount) {
            // 从 compact 批次直接读 scope，无需创建完整 StepData
            const scope = getScopeAtIndex(context.runtime.allCompactBatches, best);
            if (scope) {
                const frame = context.runtime.frameByCtx.get(scope);
                if (frame) context.setActiveTab(frame.id);
            }
            context.applyStep(best);
        } else {
            context.setActiveTab(newFrame.id);
        }
    }
    maybeLogStreamPerf(context);
}

/**
 * 处理 ContextUpdateAddress 消息
 */
export function handleContextUpdateAddress(
    body: Uint8Array,
    context: MessageHandlerContext
) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);

    let transactionId = 0;
    let contextId: number;
    let addressBytes: Uint8Array;
    if (body.byteLength >= 26) {
        transactionId = dv.getUint32(0, false);
        contextId = dv.getUint16(4, false);
        addressBytes = body.slice(6, 26);
    } else {
        contextId = dv.getUint16(0, false);
        addressBytes = body.slice(2, 22);
    }
    const address = fastHex(addressBytes);

    const frame = context.runtime.frameByCtx.get(frameScopeKey(transactionId, contextId));
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
    /** 旧包体无 transaction_id，JSON 自 offset 10 起；新包体在 10–14 为 u32 BE */
    const hasTransactionId = body.byteLength >= 15;
    const transactionId = hasTransactionId ? dv.getUint32(10, false) : undefined;
    const jsonOffset = hasTransactionId ? 14 : 10;
    const jsonData = new TextDecoder().decode(body.slice(jsonOffset));

    try {
        const logData = JSON.parse(jsonData);
        const logEntry: LogEntry = {
            address: logData.address,
            topics: logData.topics || [],
            data: logData.data || '0x',
            stepIndex: stepCount,
            contextId: contextId,
            ...(transactionId !== undefined ? { transactionId } : {}),
        };

        const tid = transactionId ?? 0;
        const frame = context.runtime.frameByCtx.get(frameScopeKey(tid, contextId));
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

    let transactionId = 0;
    let contextId: number;
    let frameStepCount: number;
    let dstOffset: number;
    let memoryData: Uint8Array;
    // 新: transaction_id(4) + context_id(2) + step_count(8) + dst_offset(4) + data
    // 旧: context_id(2) + step_count(8) + dst_offset(4) + data
    if (body.byteLength >= 18) {
        transactionId = dv.getUint32(0, false);
        contextId = dv.getUint16(4, false);
        frameStepCount = Number(dv.getBigUint64(6, false));
        dstOffset = dv.getUint32(14, false);
        memoryData = body.slice(18);
    } else {
        contextId = dv.getUint16(0, false);
        frameStepCount = Number(dv.getBigUint64(2, false));
        dstOffset = dv.getUint32(10, false);
        memoryData = body.slice(14);
    }

    // 直接 push 到 ref，立即可见，不走 React 异步队列
    const patch: MemoryPatch = {
        frameStepCount,
        dstOffset,
        data: new Uint8Array(memoryData),  // 复制一份，避免引用问题
    };

    const frame = context.runtime.frameByCtx.get(frameScopeKey(transactionId, contextId));
    if (frame) {
        frame.memoryPatches.push(patch);
    }
}

/**
 * 处理 ReturnData 消息 - 存储 frame 的返回数据
 * 旧: context_id(2) + step_count(8) + data
 * 新: transaction_id(4) + context_id(2) + step_count(8) + data
 */
export function handleReturnData(
    body: Uint8Array,
    context: MessageHandlerContext
) {
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);

    let transactionId = 0;
    let contextId: number;
    let stepIndex: number;
    let returnData: Uint8Array;
    if (body.byteLength >= 14) {
        transactionId = dv.getUint32(0, false);
        contextId = dv.getUint16(4, false);
        stepIndex = Number(dv.getBigUint64(6, false));
        returnData = body.slice(14);
    } else {
        contextId = dv.getUint16(0, false);
        stepIndex = Number(dv.getBigUint64(2, false));
        returnData = body.slice(10);
    }

    // 转换为 hex string
    const dataHex = fastHex(returnData);

    const entry: ReturnDataEntry = {
        stepIndex,
        contextId,
        data: dataHex,
        ...(transactionId !== 0 ? { transactionId } : {}),
    };

    const frame = context.runtime.frameByCtx.get(frameScopeKey(transactionId, contextId));
    if (frame) {
        frame.returnDataList.push(entry);
        scheduleCallFramesFlush(context);
    }
}

/** StorageChange body 不含 type 字节；旧版 128 字节，新版在 step_index 后多 4 字节 transaction_id */
const STORAGE_CHANGE_BODY_LEGACY = 128;

/**
 * 处理 StorageChange 消息
 * 格式: storage_type(1) + is_read(1) + context_id(2) + step_index(8) [+ transaction_id(4)] + address(20) + slot(32) + old_value(32) + new_value(32)
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
    const hasTransactionId = body.byteLength >= STORAGE_CHANGE_BODY_LEGACY + 4;
    const transactionId = hasTransactionId ? dv.getUint32(12, false) : undefined;
    const addrStart = hasTransactionId ? 16 : 12;
    const toHex = (slice: Uint8Array) => fastHex(slice);
    const address = toHex(body.slice(addrStart, addrStart + 20));
    const key     = toHex(body.slice(addrStart + 20, addrStart + 52));
    const hadValue = toHex(body.slice(addrStart + 52, addrStart + 84));
    const newValue = toHex(body.slice(addrStart + 84, addrStart + 116));

    const entry: StorageChangeEntry = {
        isRead,
        storageType,
        stepIndex,
        contextId,
        address,
        key,
        hadValue,
        newValue,
        ...(transactionId !== undefined ? { transactionId } : {}),
    };

    const tid = transactionId ?? 0;
    const frame = context.runtime.frameByCtx.get(frameScopeKey(tid, contextId));
    if (frame) {
        frame.storageChanges.push(entry);
        // 不触发 React 重渲染，播放时前端会直接读 ref
    }
}

/**
 * 处理 KeccakOp 消息
 * 格式: [transaction_id:4][context_id:2][step_index:8][hash:32][input_len:4][input...]
 */
export function handleKeccakOp(
    body: Uint8Array,
    context: MessageHandlerContext
) {
    if (body.byteLength < 4 + 2 + 8 + 32 + 4) return;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const transactionId = dv.getUint32(0, false);
    const contextId = dv.getUint16(4, false);
    const stepIndex = Number(dv.getBigUint64(6, false));
    const hashBytes = body.slice(14, 46);
    const inputLen = dv.getUint32(46, false);
    const inputBytes = body.slice(50, 50 + inputLen);

    const hash = '0x' + fastHex(hashBytes);
    const input = inputBytes.length > 0 ? fastHex(inputBytes) : '';

    let m1 = context.runtime.keccakOps.get(transactionId);
    if (!m1) { m1 = new Map(); context.runtime.keccakOps.set(transactionId, m1); }
    let m2 = m1.get(contextId);
    if (!m2) { m2 = new Map(); m1.set(contextId, m2); }
    m2.set(stepIndex, { transactionId, contextId, stepIndex, hash, input, inputLength: inputLen });
}

// computeMemoryAtStep: hex tables
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

/** 仅由 memoryPatches 重建内存（前端通常无快照，只靠补丁） */
export function memoryBytesFromPatches(
    patches: MemoryPatch[],
    maxFrameStepInclusive: number,
): Uint8Array {
    const relevant = patches.filter((p) => p.frameStepCount <= maxFrameStepInclusive);
    if (relevant.length === 0) return new Uint8Array(0);
    let maxSize = 0;
    for (const p of relevant) {
        const end = p.dstOffset + p.data.length;
        if (end > maxSize) maxSize = end;
    }
    const memBytes = new Uint8Array(maxSize);
    for (const p of relevant) {
        memBytes.set(p.data, p.dstOffset);
    }
    return memBytes;
}

function u256HexToBigInt(h: string | undefined): bigint | null {
    if (!h) return null;
    const x = h.startsWith("0x") ? h.slice(2) : h;
    if (!x) return null;
    try {
        return BigInt("0x" + x);
    } catch {
        return null;
    }
}

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
    if (snapshots.length === 0) {
        const bytes = memoryBytesFromPatches(patches, frameStepCount);
        if (bytes.length === 0) return "0x";
        const hexParts = new Array<string>(bytes.length);
        for (let i = 0; i < bytes.length; i++) hexParts[i] = _MEM_HEX[bytes[i]!];
        return "0x" + hexParts.join("");
    }

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
    const body = data.subarray(1);

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

        case MsgType.KeccakOp:
            handleKeccakOp(body, context);
            break;

        case MsgType.FoundrySourceJson:
            handleFoundrySourceJson(body, context);
            break;

        case MsgType.StateChange: {
            // 格式: [transaction_id:4][frame_id:2][step_index:8][json...]
            const scDv = new DataView(body.buffer, body.byteOffset, body.byteLength);
            const scTransactionId = scDv.getUint32(0, false);
            const scFrameId = scDv.getUint16(4, false);
            const scStepIndex = Number(scDv.getBigUint64(6, false));
            const scParsed = JSON.parse(new TextDecoder().decode(body.slice(14))) as Record<string, unknown>;
            const scEntry: StateChangeEntry = {
                stepIndex: scStepIndex,
                transactionId: scTransactionId,
                frameId: scFrameId,
                category: scParsed.category as StateChangeEntry["category"],
                kind: scParsed.kind as StateChangeEntry["kind"],
                address: scParsed.address as string | undefined,
                isCreatedGlobally: scParsed.isCreatedGlobally as boolean | undefined,
                target: scParsed.target as string | undefined,
                hadBalance: scParsed.hadBalance as string | undefined,
                oldBalance: scParsed.oldBalance as string | undefined,
                from: scParsed.from as string | undefined,
                to: scParsed.to as string | undefined,
                balance: scParsed.balance as string | undefined,
                previousNonce: scParsed.previousNonce as number | undefined,
                newNonce: scParsed.newNonce as number | undefined,
                newBalance: scParsed.newBalance as string | undefined,
            };
            useDebugStore.getState().sync({
                stateChanges: [...useDebugStore.getState().stateChanges, scEntry],
            });
            break;
        }

        case MsgType.FrameExit: {
            // 旧: [frame_id:2] [result:1] [success:1] [gas_used:8] [output_len:4] [output:N]
            // 新: [transaction_id:4] [frame_id:2] [result:1] [success:1] [gas_used:8] [output_len:4] [output:N]
            const exitDv = new DataView(body.buffer, body.byteOffset, body.byteLength);
            let exitOff = 0;
            let exitTransactionId = 0;
            if (body.byteLength >= 20) {
                exitTransactionId = exitDv.getUint32(0, false);
                exitOff = 4;
            }
            const exitFrameId = exitDv.getUint16(exitOff, false);
            const exitResult = exitDv.getUint8(exitOff + 2);
            const exitSuccess = exitDv.getUint8(exitOff + 3) === 1;
            const exitGasUsed = Number(exitDv.getBigUint64(exitOff + 4, false));
            const exitOutputLen = exitDv.getUint32(exitOff + 12, false);
            const exitOutputBytes = body.slice(exitOff + 16, exitOff + 16 + exitOutputLen);
            const exitOutput = fastHex(exitOutputBytes);
            const exitFrame = context.runtime.frameByCtx.get(frameScopeKey(exitTransactionId, exitFrameId));
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
            // 旧: [frame_id:2] [contract:20] [target:20] [value:32]
            // 新: [transaction_id:4] [frame_id:2] [contract:20] [target:20] [value:32]
            const sdDv = new DataView(body.buffer, body.byteOffset, body.byteLength);
            let sdOff = 0;
            let sdTransactionId = 0;
            if (body.byteLength >= 78) {
                sdTransactionId = sdDv.getUint32(0, false);
                sdOff = 4;
            }
            const sdFrameId = sdDv.getUint16(sdOff, false);
            const sdContract = fastHex(body.slice(sdOff + 2, sdOff + 22));
            const sdTarget = fastHex(body.slice(sdOff + 22, sdOff + 42));
            const sdValueBytes = body.slice(sdOff + 42, sdOff + 74);
            const sdValue = fastHex(sdValueBytes);
            const sdFrame = context.runtime.frameByCtx.get(frameScopeKey(sdTransactionId, sdFrameId));
            if (sdFrame) {
                sdFrame.selfdestructContract = sdContract;
                sdFrame.selfdestructTarget = sdTarget;
                sdFrame.selfdestructValue = sdValue;
                scheduleCallFramesFlush(context);
            }
            break;
        }

        case MsgType.FrameEnter: {
            const frameInfo = JSON.parse(new TextDecoder().decode(body)) as {
                frame_id: number;
                transaction_id?: number;
            };
            const tid = (frameInfo.transaction_id as number | undefined) ?? 0;
            context.runtime.pendingFrameEnters.set(
                frameScopeKey(tid, frameInfo.frame_id as number),
                frameInfo,
            );
            break;
        }

        case MsgType.BalanceChanges: {
            try {
                const parsed = JSON.parse(new TextDecoder().decode(body));
                if (Array.isArray(parsed) && parsed.length > 0) {
                    const first = parsed[0] as Record<string, unknown>;
                    // 多笔格式：[{ transaction_id, changes: AddressBalance[] }, ...]
                    if ("transaction_id" in first && "changes" in first) {
                        const merged: Array<Record<string, unknown>> = [];
                        for (const group of parsed as Array<Record<string, unknown>>) {
                            const tidRaw = group.transaction_id;
                            const tid =
                                typeof tidRaw === "number" && Number.isFinite(tidRaw) ? tidRaw : 0;
                            const changes = Array.isArray(group.changes) ? group.changes : [];
                            for (const c of changes) {
                                if (c && typeof c === "object") {
                                    merged.push({
                                        ...(c as Record<string, unknown>),
                                        transactionId: tid,
                                    });
                                }
                            }
                        }
                        useDebugStore
                            .getState()
                            .sync({ balanceChanges: merged as unknown as AddressBalance[] });
                    } else {
                        // 单笔旧格式：AddressBalance[]
                        useDebugStore.getState().sync({ balanceChanges: parsed });
                    }
                } else {
                    useDebugStore.getState().sync({ balanceChanges: parsed });
                }
            } catch (e) {
                console.error('[BalanceChanges] parse failed', e);
            }
            break;
        }

        case MsgType.Finished: {
            if (body.length > 0) {
                try {
                    const meta = JSON.parse(new TextDecoder().decode(body)) as {
                        txBoundaries?: unknown;
                    };
                    if (Array.isArray(meta.txBoundaries) && meta.txBoundaries.length > 0) {
                        const nums = meta.txBoundaries.filter(
                            (x): x is number => typeof x === "number" && Number.isFinite(x),
                        );
                        if (nums.length > 0) {
                            useDebugStore.getState().sync({ txBoundaries: nums });
                        }
                    }
                } catch (e) {
                    console.warn("[Finished] optional meta parse failed", e);
                }
            }
            if (context.runtime.stepBatchPendingCount > 0) {
                context.runtime.finishedDeferred = true;
                break;
            }
            finalizeFinished(context);
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

/**
 * 在调试结束后一次性构建扁平 call tree 节点列表
 * O(n) 单次遍历
 */
export function buildCallTree(steps: StepData[], frames: CallFrame[], keccakOps?: Map<number, Map<number, Map<number, KeccakEntry>>>): CallTreeNode[] {
    const nodes: CallTreeNode[] = [];
    const seenScope = new Set<string>();
    const frameMap = new Map(frames.map(f => [frameScopeKeyFromFrame(f), f]));

    // 传递性回滚集合：按 transactionId 分组建 contextId→frame Map，O(1) 祖先查找
    const frameMapByTid = new Map<number, Map<number, CallFrame>>();
    for (const f of frames) {
        const tid = f.transactionId ?? 0;
        let m = frameMapByTid.get(tid);
        if (!m) { m = new Map(); frameMapByTid.set(tid, m); }
        m.set(f.contextId, f);
    }
    const failedScopes = new Set<string>(
        frames.filter(f => f.success === false).map(f => frameScopeKeyFromFrame(f))
    );
    const revertedScopes = new Set<string>();
    for (const frame of frames) {
        let cur: CallFrame | undefined = frame;
        const myScope = frameScopeKeyFromFrame(frame);
        const tid = frame.transactionId ?? 0;
        const tidMap = frameMapByTid.get(tid);
        while (cur) {
            if (failedScopes.has(frameScopeKeyFromFrame(cur))) {
                revertedScopes.add(myScope);
                break;
            }
            cur = cur.parentId != null ? tidMap?.get(cur.parentId) : undefined;
        }
    }

    const logQueueByScope = new Map<string, LogEntry[]>();
    for (const frame of frames) {
        const sk = frameScopeKeyFromFrame(frame);
        logQueueByScope.set(sk, [...frame.logs].sort((a, b) => a.stepIndex - b.stepIndex));
    }
    const logPtrByScope = new Map<string, number>();

    // storageChangeMap: tid -> contextId -> stepIndex -> entry
    // 数値复合 key，封闭主循环里每步的字符串模板分配
    const storageChangeMap = new Map<number, Map<number, Map<number, StorageChangeEntry>>>();
    for (const frame of frames) {
        const ftid = frame.transactionId ?? 0;
        for (const sc of frame.storageChanges) {
            const stid = sc.transactionId ?? ftid;
            let m1 = storageChangeMap.get(stid);
            if (!m1) { m1 = new Map(); storageChangeMap.set(stid, m1); }
            let m2 = m1.get(sc.contextId);
            if (!m2) { m2 = new Map(); m1.set(sc.contextId, m2); }
            m2.set(sc.stepIndex, sc);
        }
    }

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const sk = frameScopeKeyFromStep(step);
        const stepTid = step.transactionId ?? 0;

        // frame 节点：该 (transaction, context) 首次出现时插入
        if (!seenScope.has(sk)) {
            seenScope.add(sk);
            const frame = frameMap.get(sk);
            nodes.push({
                id: nodes.length,
                type: 'frame',
                stepIndex: i,
                transactionId: stepTid,
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
                // Frame itself succeeded but an ancestor failed → changes were rolled back
                revertedByParent: frame?.success !== false && revertedScopes.has(sk),
            });
        }

        const op = step.opcode;
        // O(1) lookup with numeric keys — no string template allocation per step
        const scForStep = storageChangeMap.get(stepTid)?.get(step.contextId)?.get(i + 1);

        // SLOAD (0x54): stack top = slot
        if (op === 0x54 && step.stackTop) {
            const sc = scForStep;
            nodes.push({
                id: nodes.length,
                type: 'sload',
                stepIndex: i,
                transactionId: stepTid,
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
            const sc = scForStep;
            nodes.push({
                id: nodes.length,
                type: 'sstore',
                stepIndex: i,
                transactionId: stepTid,
                contextId: step.contextId,
                depth: step.depth + 1,
                slot: step.stackTop,
                oldValue: sc?.hadValue,
                newValue: sc?.newValue ?? step.stackSecond,
                reverted: revertedScopes.has(sk),
            });
        }
        // TLOAD (0x5c): transient storage load, stack top = slot
        else if (op === 0x5c && step.stackTop) {
            nodes.push({
                id: nodes.length,
                type: 'tload',
                stepIndex: i,
                transactionId: stepTid,
                contextId: step.contextId,
                depth: step.depth + 1,
                slot: step.stackTop,
            });
        }
        // TSTORE (0x5d): transient storage write, stack[top]=slot, stack[top-1]=value
        else if (op === 0x5d && step.stackTop) {
            const sc = scForStep;
            nodes.push({
                id: nodes.length,
                type: 'tstore',
                stepIndex: i,
                transactionId: stepTid,
                contextId: step.contextId,
                depth: step.depth + 1,
                slot: step.stackTop,
                oldValue: sc?.hadValue,
                newValue: sc?.newValue ?? step.stackSecond,
                reverted: revertedScopes.has(sk),
            });
        }
        // KECCAK256 (0x20): 数据来自后端 KeccakOp 消息（同 StorageChange 模式）
        else if (op === 0x20) {
            const entry = keccakOps?.get(stepTid)?.get(step.contextId)?.get(i);
            const sizeBI = step.stackSecond ? u256HexToBigInt(step.stackSecond) : null;
            nodes.push({
                id: nodes.length,
                type: 'keccak256',
                stepIndex: i,
                transactionId: stepTid,
                contextId: step.contextId,
                depth: step.depth + 1,
                keccakInputLength: entry?.inputLength ?? (sizeBI !== null && sizeBI <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sizeBI) : 0),
                keccakInputPreview: entry?.input,
                keccakHash: entry?.hash,
            });
        }
        // LOG0-LOG4 (0xa0-0xa4): consume from per-context log queue
        else if (op >= 0xa0 && op <= 0xa4) {
            const queue = logQueueByScope.get(sk) ?? [];
            const ptr = logPtrByScope.get(sk) ?? 0;
            const logEntry = queue[ptr];
            logPtrByScope.set(sk, ptr + 1);
            nodes.push({
                id: nodes.length,
                type: 'log',
                stepIndex: i,
                transactionId: stepTid,
                contextId: step.contextId,
                depth: step.depth + 1,
                topics: logEntry?.topics ?? [],
                logData: logEntry?.data,
                reverted: revertedScopes.has(sk),
            });
        }
    }

    // 补全轮：将 frame.logs 中未被 LOG 操作码步骤消费的日志条目插入 calltree
    // 处理 Foundry dump 中 LOG 步骤可能缺失的情况（calltree-emit 来自文本，步骤来自 dump）
    const logFallbackInserts: Array<{ at: number; node: CallTreeNode }> = [];
    for (const [sk, queue] of logQueueByScope) {
        const ptr = logPtrByScope.get(sk) ?? 0;
        if (ptr >= queue.length) continue; // 全部已消费，无需补全
        const frameNodeIdx = nodes.findIndex(n =>
            n.type === 'frame' &&
            frameScopeKey(n.transactionId ?? 0, n.contextId) === sk
        );
        if (frameNodeIdx < 0) continue;
        const frameNode = nodes[frameNodeIdx];
        const frameDepth = frameNode.depth;
        // 该 frame 子树的末尾位置（下一个同深或浅的节点之前）
        let endIdx = frameNodeIdx + 1;
        while (endIdx < nodes.length && nodes[endIdx].depth > frameDepth) endIdx++;
        for (let j = ptr; j < queue.length; j++) {
            const logEntry = queue[j];
            logFallbackInserts.push({
                at: endIdx,
                node: {
                    id: 0,
                    type: 'log',
                    stepIndex: logEntry.stepIndex,
                    transactionId: logEntry.transactionId ?? frameNode.transactionId,
                    contextId: logEntry.contextId ?? frameNode.contextId,
                    depth: frameDepth + 1,
                    topics: logEntry.topics ?? [],
                    logData: logEntry.data,
                    reverted: revertedScopes.has(sk),
                },
            });
        }
    }
    logFallbackInserts.sort((a, b) => b.at - a.at || b.node.stepIndex - a.node.stepIndex);
    for (const { at, node } of logFallbackInserts) {
        nodes.splice(at, 0, node);
    }

    // 第二轮：将 VM helper 帧精确插入 calltree 中的对应位置
    // 每个 helper 携带 vmInsertBeforeCtxId = 紧随其后的第一个真实 EVM 兄弟帧 contextId（0 = 无）
    const pendingInserts: Array<{ at: number; calltreeOrder: number; node: CallTreeNode }> = [];
    let calltreeHelperOrder = 0;
    for (const frame of frames) {
        if (!frame.isVmHelper) continue;
        const sk = frameScopeKeyFromFrame(frame);
        if (seenScope.has(sk)) continue;
        seenScope.add(sk);

        const helperNode: CallTreeNode = {
            id: 0, // 最后统一重编号
            type: 'frame',
            stepIndex: -1,
            transactionId: frame.transactionId ?? 0,
            contextId: frame.contextId,
            depth: frame.depth,
            callType: frame.callType,
            address: frame.address,
            caller: frame.caller,
            target: frame.target,
            value: frame.value,
            success: frame.success,
            gasUsed: frame.gasUsed,
            vmHelperArgs: frame.vmHelperArgs,
        };

        const tid = frame.transactionId ?? 0;
        let insertAt = nodes.length;

        if (frame.vmInsertBeforeCtxId && frame.vmInsertBeforeCtxId > 0) {
            // 插到下一个真实 EVM 兄弟帧的 frame node 之前
            const beforeIdx = nodes.findIndex(
                n => n.type === 'frame' && n.contextId === frame.vmInsertBeforeCtxId && (n.transactionId ?? 0) === tid
            );
            if (beforeIdx >= 0) insertAt = beforeIdx;
        } else {
            // 无后继真实兄弟：插到父帧子树末尾
            const parentCtxId = frame.parentId;
            if (parentCtxId != null && parentCtxId > 0) {
                const parentIdx = nodes.findIndex(
                    n => n.type === 'frame' && n.contextId === parentCtxId && (n.transactionId ?? 0) === tid
                );
                if (parentIdx >= 0) {
                    const parentDepth = nodes[parentIdx].depth;
                    let endIdx = parentIdx + 1;
                    while (endIdx < nodes.length && nodes[endIdx].depth > parentDepth) endIdx++;
                    insertAt = endIdx;
                }
            }
        }

        pendingInserts.push({ at: insertAt, calltreeOrder: calltreeHelperOrder++, node: helperNode });
    }

    pendingInserts.sort((a, b) => b.at - a.at || b.calltreeOrder - a.calltreeOrder);
    for (const { at, node } of pendingInserts) {
        nodes.splice(at, 0, node);
    }
    // 重编号 id（用作 React key）
    nodes.forEach((n, i) => { n.id = i; });

    return nodes;
}
