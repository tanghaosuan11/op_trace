/** TS types for symbolic solve; mirrors Rust. Entry: `invoke("symbolic_solve", ...)`. */

import { invoke } from "@/lib/ipc-bridge";

/**
 * 符号执行配置：指定哪些 calldata 字节偏移被视为符号变量
 *
 * 例：ERC-20 transfer(address, uint256)
 * ```
 * calldata_symbols: [[4, "recipient"], [36, "amount"]]
 * ```
 */
export interface SymConfig {
  /** 每项 [offsetBytes, varName]，offset 是 CALLDATALOAD 的字节起始偏移 */
  calldata_symbols: [number, string][];
  callvalue_sym?: boolean;
  caller_sym?: boolean;
  origin_sym?: boolean;
  timestamp_sym?: boolean;
  block_number_sym?: boolean;
  /** 初始存储状态中被视为符号的 slot，每项 [slot_hex64, varName] */
  storage_symbols?: [string, string][];
}

/** 对目标 JUMPI 步骤的期望 */
export type SymGoal =
  | { type: "TakeJump" }
  | { type: "SkipJump" }
  | { type: "EqualValue"; value: string }; // 64位十六进制，无0x前缀

/** 一个符号变量的解 */
export interface SymInput {
  /** 变量名，如 "cd_4" */
  name: string;
  /** 十六进制值，带 0x 前缀，如 "0x0000...0001" */
  value_hex: string;
  /** 如果是 cd_ 开头的 calldata 变量，这里是字节偏移 */
  calldata_offset?: number;
}

/** Z3 求解结果（对应 Rust SolverResult enum，serde tag = "status"） */
export type SolverResult =
  | { status: "Sat"; inputs: SymInput[]; target_transaction_id: number }
  | { status: "Unsat"; target_transaction_id: number }
  | { status: "Unknown"; reason: string; target_transaction_id: number }
  | { status: "Error"; message: string; target_transaction_id?: number };

/** 分层回退的一次尝试记录 */
export interface FallbackAttempt {
  tier: string;
  source_count: number;
  result_status: string;
}

/** symbolic_auto_solve 返回类型 */
export interface AutoSolveResult {
  result: SolverResult;
  explain?: SolveExplain | null;
  sources: SymSource[];
  auto_config: SymConfig;
  attempts?: FallbackAttempt[];
}

/** 符号源（对应 Rust SymSource enum），serde tag = "kind" */
export type SymSource =
  | { kind: "Calldata"; data: { tx_id: number; offset: number } }
  | { kind: "Callvalue"; data: { tx_id: number } }
  | { kind: "Caller"; data: { tx_id: number } }
  | { kind: "Origin"; data: { tx_id: number } }
  | { kind: "Timestamp" }
  | { kind: "BlockNumber" }
  | { kind: "StorageInitial"; data: { tx_id: number; slot: string } };

/** Unsat 原因分类（对应 Rust UnsatReason, serde tag = "code"） */
export type UnsatReason =
  | { code: "PathContradiction"; conflict_step?: number | null }
  | { code: "ConcreteCondition" }
  | { code: "NoUsefulSources" };

/** Unknown 原因分类（对应 Rust UnknownReason, serde tag = "code"） */
export type UnknownReason =
  | { code: "UninterpretedFunctions"; uf_count: number }
  | { code: "Timeout" }
  | { code: "Other"; detail: string };

/** 解释分类（对应 Rust ExplainCategory, serde tag = "kind"） */
export type ExplainCategory =
  | { kind: "UnsatPath" } & UnsatReason
  | { kind: "UnknownSolver" } & UnknownReason
  | { kind: "Error" };

/** 求解失败诊断（对应 Rust SolveExplain） */
export interface SolveExplain {
  category: ExplainCategory;
  message: string;
  suggestions: string[];
  symbolic_constraint_count: number;
  uf_constraint_count: number;
}

export interface SymbolicSolveParams {
  /** 根交易原始 calldata，十六进制（带或不带 0x） */
  calldata_hex: string;
  /** 多 tx 时按交易 ID 传入各笔 calldata；单 tx 可省略 */
  calldata_by_tx?: [number, string][];
  sym_config: SymConfig;
  /** 目标 JUMPI 的全局步骤索引 */
  target_step: number;
  goal: SymGoal;
  /** Z3 可执行路径（null = 使用 PATH 中的 z3） */
  z3_path?: string | null;
  session_id?: string;
}

/**
 * 调用后端 symbolic_solve Tauri 命令
 */
export async function symbolicSolve(params: SymbolicSolveParams): Promise<SolverResult> {
  return invoke<SolverResult>("symbolic_solve", {
    calldata_hex: params.calldata_hex,
    calldata_by_tx: params.calldata_by_tx ?? null,
    sym_config: params.sym_config,
    target_step: params.target_step,
    goal: params.goal,
    z3_path: params.z3_path ?? null,
    session_id: params.session_id,
  });
}

/**
 * 从 calldata hex + SymInput 列表，构建修改后的 calldata（用于 Fork 验证）
 *
 * @param originalCalldata 原始 calldata（带0x）
 * @param inputs Z3 求解出的变量列表
 * @returns 修改后的 calldata（带0x）
 */
export function patchCalldataWithResults(
  originalCalldata: string,
  inputs: SymInput[]
): string {
  const hex = originalCalldata.replace(/^0x/i, "");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  for (const inp of inputs) {
    if (inp.calldata_offset == null) continue;
    const valHex = inp.value_hex.replace(/^0x/i, "").padStart(64, "0");
    const off = inp.calldata_offset;
    for (let i = 0; i < 32 && off + i < bytes.length; i++) {
      bytes[off + i] = parseInt(valHex.slice(i * 2, i * 2 + 2), 16);
    }
  }

  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 简短展示 value_hex（去掉前导零，保留有效部分，最多16字符）
 */
export function fmtSymInputValue(inp: SymInput): string {
  const stripped = inp.value_hex.replace(/^0x0*/i, "");
  if (!stripped) return "0x0";
  if (stripped.length <= 16) return "0x" + stripped;
  return "0x…" + stripped.slice(-12);
}
