/// <reference lib="webworker" />

import { parseStepBatchCompact, buildIndexesFromCompact, StepStackEntry } from "./stepPlayer";

interface ParseRequest {
  kind: "parse";
  seq: number;
  body: Uint8Array;
}

interface ParseResponse {
  kind: "parsed";
  seq: number;
  // Float64Array（8 doubles/step）：[transactionId, contextId, depth, pc, opcode, gasCost, gasRemaining, frameStepCount]
  // 通过 transferList 零复制传回主线程，避免结构化克隆 StepData[] 的开销。
  compact: Float64Array;
  stackEntries: StepStackEntry[];
  contextLocalIndexes: Array<[string, number[]]>;
  opcodeLocalIndexes: Array<[number, number[]]>;
  parseMs: number;
  indexBuildMs: number;
}

const workerScope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<ParseRequest>) => {
  const msg = event.data;
  if (!msg || msg.kind !== "parse") return;

  const parseStart = performance.now();
  const { compact, stackEntries } = parseStepBatchCompact(msg.body);
  const parseMs = performance.now() - parseStart;

  const indexStart = performance.now();
  const { contextLocalIndexes, opcodeLocalIndexes } = buildIndexesFromCompact(compact);
  const indexBuildMs = performance.now() - indexStart;

  const response: ParseResponse = {
    kind: "parsed",
    seq: msg.seq,
    compact,
    stackEntries,
    contextLocalIndexes,
    opcodeLocalIndexes,
    parseMs,
    indexBuildMs,
  };
  // compact.buffer 零复制 transfer
  workerScope.postMessage(response, [compact.buffer]);
};

export {};

