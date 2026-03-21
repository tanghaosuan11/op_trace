/**
 * 分析脚本管理模块。
 * - 内置脚本：通过 Vite ?raw import 打包进 bundle
 * - 用户脚本：通过 Tauri plugin-store 持久化到 scripts.json
 */
import { load, type Store } from "@tauri-apps/plugin-store";

// ── 内置脚本（?raw import） ───────────────────────────────────
import gasTopCode from "./analysis-scripts/gas-top.js?raw";
import sstoreSummaryCode from "./analysis-scripts/sstore-summary.js?raw";
import opcodeFreqCode from "./analysis-scripts/opcode-freq.js?raw";
import callSummaryCode from "./analysis-scripts/call-summary.js?raw";
import logSummaryCode from "./analysis-scripts/log-summary.js?raw";

export interface ScriptEntry {
  id: string;
  name: string;
  code: string;
  readonly: boolean;
  updatedAt: number;
}

export const BUILTIN_SCRIPTS: ScriptEntry[] = [
  { id: "builtin:gas-top",        name: "Gas 消耗 Top 20",    code: gasTopCode,        readonly: true, updatedAt: 0 },
  { id: "builtin:sstore-summary", name: "SSTORE 操作汇总",    code: sstoreSummaryCode,  readonly: true, updatedAt: 0 },
  { id: "builtin:opcode-freq",    name: "Opcode 频率统计",    code: opcodeFreqCode,     readonly: true, updatedAt: 0 },
  { id: "builtin:call-summary",   name: "CALL 调用统计",      code: callSummaryCode,    readonly: true, updatedAt: 0 },
  { id: "builtin:log-summary",    name: "LOG 事件汇总",       code: logSummaryCode,     readonly: true, updatedAt: 0 },
];

// ── Tauri Store 单例 ─────────────────────────────────────────
let _store: Store | null = null;
let _loading: Promise<Store> | null = null;

async function getScriptsStore(): Promise<Store> {
  if (_store) return _store;
  if (!_loading) {
    _loading = load("scripts.json", { autoSave: true, defaults: {} }).then((s) => {
      _store = s;
      return s;
    });
  }
  return _loading;
}

// ── 用户脚本 CRUD ────────────────────────────────────────────

export interface UserScript {
  id: string;
  name: string;
  code: string;
  updatedAt: number;
}

export async function listUserScripts(): Promise<UserScript[]> {
  const s = await getScriptsStore();
  return (await s.get<UserScript[]>("scripts")) ?? [];
}

export async function saveUserScript(script: UserScript): Promise<void> {
  const s = await getScriptsStore();
  const all = (await s.get<UserScript[]>("scripts")) ?? [];
  const idx = all.findIndex((x) => x.id === script.id);
  if (idx >= 0) all[idx] = script;
  else all.push(script);
  await s.set("scripts", all);
}

export async function deleteUserScript(id: string): Promise<void> {
  const s = await getScriptsStore();
  const all = ((await s.get<UserScript[]>("scripts")) ?? []).filter((x) => x.id !== id);
  await s.set("scripts", all);
}

// ── 合并列表 ─────────────────────────────────────────────────

export function mergeScripts(userScripts: UserScript[]): ScriptEntry[] {
  return [
    ...BUILTIN_SCRIPTS,
    ...userScripts.map((u) => ({ ...u, readonly: false })),
  ];
}
