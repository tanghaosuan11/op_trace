/**
 * 全局应用配置 — 统一管理所有用户配置项
 *
 * - FrontendConfig: 仅前端 UI 使用
 * - BackendConfig:  需传给 Rust 后端
 * - AppConfig = FrontendConfig & BackendConfig
 *
 * 持久化到 Tauri Store (settings.json)。
 * 启动时 initAppConfig() 加载 → loadAppConfig() 返回给 store。
 * 运行时 setConfig(patch) 写 store + 持久化。
 */
import { storeGet, storeSet } from "./tauriStore";

// ── 前端专用配置（只影响 UI 行为） ──────────────────────────────
export interface FrontendConfig {
  /** 开发者调试 UI */
  isDebug: boolean;
  /** 区块链浏览器 URL（用于前端链接，如 https://etherscan.io） */
  scanUrl: string;
  /** 播放时遇到 PauseOp 直接跳转到最近匹配步 */
  pauseOpJump: boolean;
  /** 播放时遇到 PauseConv 命中直接跳转到最近匹配步 */
  pauseCondJump: boolean;
}

// ── 需要传给后端的配置 ──────────────────────────────────────────
export interface BackendConfig {
  /** 自动保存/读取 AlloyDB 磁盘缓存 */
  useAlloyCache: boolean;
  /** RPC 节点 URL */
  rpcUrl: string;
  /** 使用 prestateTracer 精确预填状态（适用于块内非首笔交易） */
  usePrestate: boolean;  /** Fork 模式：传递 patches 重跑交易 */
  forkMode: boolean;}

export type AppConfig = FrontendConfig & BackendConfig;

export const DEFAULT_CONFIG: AppConfig = {
  isDebug: false,
  useAlloyCache: true,
  usePrestate: false,
  forkMode: false,
  pauseOpJump: true,
  pauseCondJump: true,
  rpcUrl: "https://mainnet.infura.io/v3/c60b0bb42f8a4c6481ecd229eddaca27",
  scanUrl: "https://etherscan.io/",
};

// ── Tauri Store 持久化 ──────────────────────────────────────────

const STORE_KEY = "app.config";
let _config: AppConfig = { ...DEFAULT_CONFIG };
let _inited = false;

/** 应用启动时调用，从 Tauri Store 加载配置到内存 */
export async function initAppConfig(): Promise<void> {
  if (_inited) return;
  const saved = await storeGet<Partial<AppConfig>>(STORE_KEY);
  if (saved) {
    // 合并默认值，防止旧版本缺字段
    _config = { ...DEFAULT_CONFIG, ...saved };
  }
  // 兼容旧版 isDebug (之前单独存在 "app.isDebug")
  const legacyDebug = await storeGet<boolean>("app.isDebug");
  if (legacyDebug != null && !saved) {
    _config.isDebug = legacyDebug;
  }
  // 兼容旧版 rpcUrl (之前由 rpcConfig.ts 单独存在 "selected_rpc_url")
  if (!saved?.rpcUrl) {
    const legacyRpc = await storeGet<string>("selected_rpc_url");
    if (legacyRpc) _config.rpcUrl = legacyRpc;
  }
  _inited = true;
}

/** 返回当前内存中的完整配置快照（供 App.tsx 启动时同步到 store） */
export function loadAppConfig(): { config: AppConfig } {
  return { config: { ..._config } };
}

/** 更新配置（局部 patch），同时写回 Tauri Store */
export function setConfig(patch: Partial<AppConfig>): AppConfig {
  Object.assign(_config, patch);
  storeSet(STORE_KEY, _config);
  return { ..._config };
}

/** 提取后端需要的配置子集（debugActions.ts 中传给 invoke） */
export function getBackendConfig(): BackendConfig {
  return { useAlloyCache: _config.useAlloyCache, rpcUrl: _config.rpcUrl, usePrestate: _config.usePrestate, forkMode: _config.forkMode };
}
