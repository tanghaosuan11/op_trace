/**
 * Shadow State 诊断工具
 * 用于在浏览器控制台调试 shadow 状态
 */

import { invoke } from "@/lib/ipc-bridge";

export interface ShadowValidationMismatch {
  step: number;
  /** 多笔调试：与 frame_id 一起区分调用帧（0-based，与 trace 一致） */
  transaction_id?: number | null;
  frame_id: number | null;
  opcode: number;
  opcode_name: string;
  stack_index: number;
  shadow_id: number;
  expected_evm: string;
  actual_shadow: string;
  reason: string;
}

export interface ShadowValidationReport {
  checked_steps: number;
  checked_slots: number;
  mismatch_count: number;
  mismatches: ShadowValidationMismatch[];
}

/**
 * 打印指定范围内的步骤调试信息
 * @param start 起始步骤编号
 * @param end 结束步骤编号
 */
export async function debugShadowSteps(start: number, end: number, sessionId?: string): Promise<string> {
  try {
    const result = await invoke<string>("debug_shadow_steps", { 
      start: Math.floor(start),
      end: Math.floor(end),
      sessionId,
    });
    console.log("=== Shadow Steps Debug Info ===");
    console.log(result);
    return result;
  } catch (error) {
    console.error("❌ Failed to debug shadow steps:", error);
    throw error;
  }
}

/**
 * 统计指定范围内被跳过的步骤
 * @param start 起始步骤编号
 * @param end 结束步骤编号
 * @returns [总步数, NO_NODE数, 超出范围数]
 */
export async function countSkippedShadowSteps(
  start: number,
  end: number,
  sessionId?: string,
): Promise<[number, number, number]> {
  try {
    const result = await invoke<[number, number, number]>(
      "count_skipped_shadow_steps",
      {
        start: Math.floor(start),
        end: Math.floor(end),
        sessionId,
      }
    );
    console.log(`=== Shadow Steps Count (${start}..${end}) ===`);
    console.log(`Total steps: ${result[0]}`);
    console.log(`NO_NODE count: ${result[1]}`);
    console.log(`Out-of-range count: ${result[2]}`);
    return result;
  } catch (error) {
    console.error("❌ Failed to count skipped shadow steps:", error);
    throw error;
  }
}

/**
 * 导出所有步骤的影子信息到tmp文件
 * @returns 导出文件的路径
 */
export async function exportAllShadowSteps(sessionId?: string): Promise<string> {
  try {
    const result = await invoke<string>("export_all_shadow_steps", { sessionId });
    console.log("✅ Shadow steps exported to:", result);
    return result;
  } catch (error) {
    console.error("❌ Failed to export all shadow steps:", error);
    throw error;
  }
}

export async function validateShadowSteps(maxMismatches = 200, sessionId?: string): Promise<ShadowValidationReport> {
  return invoke<ShadowValidationReport>("validate_shadow_steps", {
    maxMismatches: Math.max(1, Math.floor(maxMismatches)),
    sessionId,
  });
}
