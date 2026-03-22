/**
 * 快捷键定义表
 */

import type { CommandId } from "./commands";
import { useDebugStore } from "@/store/debugStore";

export interface ShortcutDef {
  commandId: CommandId;
  description: string;
  /**
   * 可选条件：返回 false 时快捷键不触发。
   * 保持轻量 —— 直接读 store.getState()，不订阅。
   */
  when?: () => boolean;
}

// ── 条件谓词（复用） ──────────────────────────────────────────────────────────

const isDebugging = () => useDebugStore.getState().stepCount > 0;

// 后期添加新快捷键直接在此追加一行即可。

export const SHORTCUT_MAP: Record<string, ShortcutDef> = {
  // 调试步进
  "j":                { commandId: "debug.stepInto",   description: "Step Into",    when: isDebugging },
  "k":                { commandId: "debug.stepBack",   description: "Step Back",    when: isDebugging },
  // "":              { commandId: "debug.stepOver",   description: "Step Over",    when: isDebugging },
  // "":        { commandId: "debug.stepOut",    description: "Step Out",     when: isDebugging },
  "space":            { commandId: "debug.continue",   description: "Continue / Pause", when: isDebugging },

  // 导航历史
  "alt+ArrowLeft":    { commandId: "nav.back",         description: "Navigate Back" },
  "alt+ArrowRight":   { commandId: "nav.forward",      description: "Navigate Forward" },

  // 界面
  "t":     { commandId: "ui.toggleCallTree",  description: "Toggle Call Tree",
             when: () => useDebugStore.getState().callTreeNodes.length > 0 },
  "u":     { commandId: "ui.toggleUtilities", description: "Toggle Utilities" },
  "l":     { commandId: "ui.toggleLogs",      description: "Toggle Log Drawer" },
  "a":     { commandId: "ui.toggleAnalysis",  description: "Toggle Analysis" },
  // "ctrl+shift+b":     { commandId: "ui.toggleBookmarks", description: "Toggle Bookmarks" },
  // "L":     { commandId: "ui.toggleCondList",  description: "Toggle Condition List" },
};

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** e.key → 规范名称映射（覆盖浏览器原始值） */
const KEY_ALIASES: Record<string, string> = {
  " ": "space",
};

/** 将 KeyboardEvent 编码为与 SHORTCUT_MAP 的 key 格式一致的字符串。 */
export function encodeKey(e: KeyboardEvent): string {
  // 单独按下修饰键时不产生 combo
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return "";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const key = KEY_ALIASES[e.key] ?? (e.key.length === 1 ? e.key.toLowerCase() : e.key);
  parts.push(key);
  return parts.join("+");
}
