/**
 * 条件断点（Conditional Pause）
 *
 * PauseCondition 描述一条断点规则。
 * checkPauseCondition() 在每步执行时调用，返回命中的描述字符串或 null。
 *
 * 规则类型：
 *   sstore_slot       — 写入指定 storage slot 时暂停
 *   sload_slot        — 读取指定 storage slot 时暂停
 *   call_address      — CALL/STATICCALL/DELEGATECALL 目标地址匹配时暂停
 *   call_selector     — CALL/STATICCALL/DELEGATECALL 且 calldata 前 4 字节匹配时暂停
 *   log_topic         — LOG1~LOG4 且 topic[0] 匹配时暂停
 *   contract_address  — 当前执行合约地址匹配时，该合约内所有步骤均命中
 *   target_address    — 当前 frame 的 call target 地址匹配时，该 frame 内所有步骤均命中
 */

import type { StepData } from "./stepPlayer";

/* ── 类型定义 ──────────────────────────────────────────────────── */

export type PauseConditionType =
  | "sstore_slot"
  | "sload_slot"
  | "call_address"
  | "call_selector"
  | "log_topic"
  | "contract_address"
  | "target_address";

export interface PauseCondition {
  id: string;
  type: PauseConditionType;
  /** 主匹配值（slot hex / address / selector / topic） */
  value: string;
  /** 是否启用，false 时跳过 */
  enabled: boolean;
}

/**
 * 条件树节点。
 *  - leaf: 单条条件
 *  - compound: 两个子节点用 AND/OR 合并（最多嵌套 1 层，即最多 3 叶子）
 */
export type CondNode =
  | { kind: "leaf"; id: string; cond: PauseCondition }
  | { kind: "compound"; id: string; op: "AND" | "OR"; left: CondNode; right: CondNode };

/** 从树中收集所有叶子 PauseCondition */
export function collectLeaves(node: CondNode): PauseCondition[] {
  if (node.kind === "leaf") return [node.cond];
  return [...collectLeaves(node.left), ...collectLeaves(node.right)];
}

/** 条件树中叶子节点数量 */
export function leafCount(node: CondNode): number {
  if (node.kind === "leaf") return 1;
  return leafCount(node.left) + leafCount(node.right);
}

/** 条件组：组内 AND/OR，组间始终 OR（保留以兼容 Rust 接口） */
export interface ConditionGroup {
  id: string;
  /** "AND" | "OR" */
  logic: "AND" | "OR";
  conditions: PauseCondition[];
}

export const PAUSE_CONDITION_LABELS: Record<PauseConditionType, string> = {
  sstore_slot: "SSTORE slot",
  sload_slot: "SLOAD slot",
  call_address: "Call address",
  call_selector: "Call selector",
  log_topic: "LOG topic",
  contract_address: "Contract addr",
  target_address: "Target addr",
};

/* ── opcode 常量 ───────────────────────────────────────────────── */

const OP_SSTORE       = 0x55;
const OP_SLOAD        = 0x54;
const OP_CALL         = 0xf1;
const OP_STATICCALL   = 0xfa;
const OP_DELEGATECALL = 0xf4;
const OP_LOG1         = 0xa1;
const OP_LOG4         = 0xa4;

/* ── 规范化 hex 字符串（统一小写，去 0x 前缀，不补齐）────────── */

function normalizeHex(s: string): string {
  return s.toLowerCase().replace(/^0x/, "");
}

/* ── 从 StepData 的部分栈字段取 hex ─────────────────────────── */

function partialStackHex(step: StepData, pos: number): string | null {
  let v: string | undefined;
  if (pos === 0) v = step.stackTop;
  else if (pos === 1) v = step.stackSecond;
  else if (pos === 2) v = step.stackThird;
  if (v === undefined) return null;
  return normalizeHex(v);
}

/* ── 主检测函数 ────────────────────────────────────────────────── */

/**
 * 检测当前步骤是否命中条件组。组内 AND/OR，组间 OR。
 * 注意：stack 是步骤执行**前**的状态。
 * @returns 命中时返回描述字符串，否则 null
 */
export function checkPauseConditions(
  step: StepData,
  groups: ConditionGroup[]
): string | null {
  if (groups.length === 0) return null;
  const op = step.opcode;

  for (const group of groups) {
    if (group.conditions.length === 0) continue;
    const isAnd = group.logic === "AND";
    const descriptions: string[] = [];
    let groupHit = isAnd;

    for (const cond of group.conditions) {
      const target = normalizeHex(cond.value);
      if (!target) { if (isAnd) { groupHit = false; break; } continue; }
      const result = checkSingleCondition(step, op, cond.type, target);
      if (isAnd) {
        if (result) descriptions.push(result);
        else { groupHit = false; break; }
      } else {
        if (result) { descriptions.push(result); groupHit = true; break; }
      }
    }

    if (groupHit && descriptions.length > 0) return descriptions.join(" AND ");
  }
  return null;
}

function checkSingleCondition(
  step: StepData,
  op: number,
  type: PauseConditionType,
  target: string,
): string | null {
  switch (type) {
    case "sstore_slot": {
      if (op !== OP_SSTORE) return null;
      const slot = partialStackHex(step, 0);
      if (slot !== null && slot === target.padStart(64, "0").slice(-64)) return `SSTORE slot 0x${target}`;
      return null;
    }
    case "sload_slot": {
      if (op !== OP_SLOAD) return null;
      const slot = partialStackHex(step, 0);
      if (slot !== null && slot === target.padStart(64, "0").slice(-64)) return `SLOAD slot 0x${target}`;
      return null;
    }
    case "call_address": {
      if (op !== OP_CALL && op !== OP_STATICCALL && op !== OP_DELEGATECALL) return null;
      const addr = partialStackHex(step, 1);
      if (addr !== null && addr.endsWith(target.replace(/^0+/, ""))) {
        const opName = op === OP_CALL ? "CALL" : op === OP_STATICCALL ? "STATICCALL" : "DELEGATECALL";
        return `${opName} → 0x${target}`;
      }
      return null;
    }
    case "call_selector": {
      if (op !== OP_CALL && op !== OP_STATICCALL && op !== OP_DELEGATECALL) return null;
      const cd = step.calldata;
      if (!cd) return null;
      const sel = normalizeHex(cd).slice(0, 8);
      if (sel === target.slice(0, 8)) return `Call selector 0x${target.slice(0, 8)}`;
      return null;
    }
    case "log_topic": {
      if (op < OP_LOG1 || op > OP_LOG4) return null;
      const topic = partialStackHex(step, 2);
      if (topic !== null && topic === target.padStart(64, "0").slice(-64)) return `LOG topic 0x${target}`;
      return null;
    }
    // contract_address and target_address are per-frame conditions;
    // checkSingleCondition is used only for live step playback where we don't have frame address data.
    // These are handled purely by the Rust backend scan.
    case "contract_address":
    case "target_address":
      return null;
  }
}

/* ── 扫描命中结果 ──────────────────────────────────────────────── */

export interface ScanHit {
  step_index: number;
  context_id: number;
  pc: number;
  opcode: number;
  description: string;
}

/**
 * 对单个叶子条件调用 Rust 扫描，返回命中步骤集合。
 */
async function scanLeaf(cond: PauseCondition): Promise<Set<number>> {
  if (!cond.enabled) return new Set();
  const { invoke } = await import("@tauri-apps/api/core");
  const hits: ScanHit[] = await invoke("scan_conditions", {
    conditions: [{ id: "leaf", logic: "OR", conditions: [cond] }],
  });
  return new Set<number>(hits.map(h => h.step_index));
}

/**
 * 递归对 CondNode 树求命中集合（前端合并）。
 */
async function evalCondNode(node: CondNode): Promise<{ hitSet: Set<number>; hits: ScanHit[] }> {
  if (node.kind === "leaf") {
    const hitSet = await scanLeaf(node.cond);
    // 重新拿 hit 对象（需要完整 ScanHit）
    if (hitSet.size === 0) return { hitSet, hits: [] };
    const { invoke } = await import("@tauri-apps/api/core");
    const hits: ScanHit[] = await invoke("scan_conditions", {
      conditions: [{ id: "leaf", logic: "OR", conditions: [node.cond] }],
    });
    return { hitSet, hits };
  }

  const [leftResult, rightResult] = await Promise.all([
    evalCondNode(node.left),
    evalCondNode(node.right),
  ]);

  let hitSet: Set<number>;
  if (node.op === "AND") {
    hitSet = new Set([...leftResult.hitSet].filter(i => rightResult.hitSet.has(i)));
  } else {
    hitSet = new Set([...leftResult.hitSet, ...rightResult.hitSet]);
  }

  // 合并 hits，仅保留最终命中步骤的条目
  const combined = [...leftResult.hits, ...rightResult.hits].filter(h => hitSet.has(h.step_index));
  // 去重（同一步骤仅保留一条）
  const seen = new Set<number>();
  const hits = combined.filter(h => { if (seen.has(h.step_index)) return false; seen.add(h.step_index); return true; });
  hits.sort((a, b) => a.step_index - b.step_index);

  return { hitSet, hits };
}

/**
 * 对 CondNode 列表（多个根节点间 OR）求命中集合，
 * 或对旧 ConditionGroup[] 格式求命中集合（向后兼容）。
 */
export async function rebuildConditionHitSet(
  groupsOrNodes: ConditionGroup[] | CondNode[],
): Promise<{ hitSet: Set<number>; hits: ScanHit[] }> {
  if (groupsOrNodes.length === 0) return { hitSet: new Set(), hits: [] };

  // 判断是新 CondNode[] 还是旧 ConditionGroup[]
  if ((groupsOrNodes[0] as CondNode).kind !== undefined) {
    // 新路径：多根节点间 OR 合并
    const nodes = groupsOrNodes as CondNode[];
    const results = await Promise.all(nodes.map(n => evalCondNode(n)));
    const hitSet = new Set<number>(results.flatMap(r => [...r.hitSet]));
    const seen = new Set<number>();
    const hits = results.flatMap(r => r.hits)
      .filter(h => { if (seen.has(h.step_index)) return false; seen.add(h.step_index); return true; });
    hits.sort((a, b) => a.step_index - b.step_index);
    return { hitSet, hits };
  }

  // 旧路径：直接传 groups 给 Rust（兼容）
  const groups = groupsOrNodes as ConditionGroup[];
  const { invoke } = await import("@tauri-apps/api/core");
  const hits: ScanHit[] = await invoke("scan_conditions", { conditions: groups });
  const hitSet = new Set<number>(hits.map(h => h.step_index));
  return { hitSet, hits };
}
