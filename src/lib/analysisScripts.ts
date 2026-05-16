/**
 * 分析脚本管理模块。
 * - 内置脚本：通过 Vite ?raw import 打包进 bundle
 * - 用户脚本：通过 Tauri plugin-store 持久化到 scripts.json
 */
import { load, type Store } from "@tauri-apps/plugin-store";

import guideCode from "./analysis-scripts/guide.js?raw";
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
  /** If true, the Run button is disabled for this entry */
  isGuide?: boolean;
}

export const BUILTIN_SCRIPTS: ScriptEntry[] = [
  { id: "builtin:guide",          name: "📖 Guide",           code: guideCode,          readonly: true, updatedAt: 0, isGuide: true },
  { id: "builtin:gas-top",        name: "Gas Cost Top 20",    code: gasTopCode,          readonly: true, updatedAt: 0 },
  { id: "builtin:sstore-summary", name: "SSTORE Summary",     code: sstoreSummaryCode,   readonly: true, updatedAt: 0 },
  { id: "builtin:opcode-freq",    name: "Opcode Frequency",   code: opcodeFreqCode,      readonly: true, updatedAt: 0 },
  { id: "builtin:call-summary",   name: "Call Summary",       code: callSummaryCode,     readonly: true, updatedAt: 0 },
  { id: "builtin:log-summary",    name: "Log Summary",        code: logSummaryCode,      readonly: true, updatedAt: 0 },
];

let _store: Store | null = null;
let _loading: Promise<Store> | null = null;

function makeLocalStorageMock(prefix: string): Store {
  const k = (key: string) => `optrace:${prefix}:${key}`;
  return {
    async get<T>(key: string): Promise<T | null | undefined> { const v = localStorage.getItem(k(key)); return v != null ? JSON.parse(v) as T : undefined; },
    async set(key: string, value: unknown) { localStorage.setItem(k(key), JSON.stringify(value)); },
    async delete(key: string) { localStorage.removeItem(k(key)); },
    async clear() {}, async reset() {}, async has(key: string) { return localStorage.getItem(k(key)) != null; },
    async keys() { return []; }, async values() { return []; }, async entries() { return []; }, async length() { return 0; },
    async reload() {}, async save() {}, async close() {},
    onKeyChange: () => Promise.resolve(() => {}), onChange: () => Promise.resolve(() => {}),
  } as unknown as Store;
}

async function getScriptsStore(): Promise<Store> {
  if (_store) return _store;
  if (!_loading) {
    _loading = load("scripts.json", { autoSave: true, defaults: {} }).then((s) => {
      _store = s;
      return s;
    }).catch(() => { _store = makeLocalStorageMock('scripts'); return _store!; });
  }
  return _loading;
}

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

export function mergeScripts(userScripts: UserScript[]): ScriptEntry[] {
  return [
    ...BUILTIN_SCRIPTS,
    ...userScripts.map((u) => ({ ...u, readonly: false })),
  ];
}
