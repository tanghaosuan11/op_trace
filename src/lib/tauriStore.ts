/**
 * 统一的 Tauri Store 封装。
 * 所有持久化数据通过此模块读写，替代 localStorage。
 * 文件保存在 app data 目录下的 settings.json。
 */
import { load, type Store } from "@tauri-apps/plugin-store";
import { getWindowMode } from "./windowMode";

let _store: Store | null = null;
let _loading: Promise<Store> | null = null;

/** 获取单例 Store 实例（非 Tauri 环境自动 fallback 到 localStorage） */
export async function getStore(): Promise<Store> {
  if (_store) return _store;
  if (!_loading) {
    _loading = load("settings.json", { autoSave: true, defaults: {} }).then((s) => {
      _store = s;
      return s;
    }).catch(() => {
      // 非 Tauri 环境（VSCode webview 等）：用 localStorage 作为 fallback
      const mock: Store = {
        async get<T>(key: string): Promise<T | null | undefined> {
          const v = localStorage.getItem('optrace:store:' + key);
          return v != null ? (JSON.parse(v) as T) : undefined;
        },
        async set(key: string, value: unknown): Promise<void> {
          localStorage.setItem('optrace:store:' + key, JSON.stringify(value));
        },
        async delete(key: string): Promise<void> {
          localStorage.removeItem('optrace:store:' + key);
        },
        async clear(): Promise<void> {},
        async reset(): Promise<void> {},
        async has(key: string): Promise<boolean> { return localStorage.getItem('optrace:store:' + key) != null; },
        async keys(): Promise<string[]> { return []; },
        async values(): Promise<unknown[]> { return []; },
        async entries(): Promise<[string, unknown][]> { return []; },
        async length(): Promise<number> { return 0; },
        async reload(): Promise<void> {},
        async save(): Promise<void> {},
        async close(): Promise<void> {},
        onKeyChange<T>(_key: string, _cb: (v: T | null) => void) { return Promise.resolve(() => {}); },
        onChange(_cb: (key: string, v: unknown) => void) { return Promise.resolve(() => {}); },
      } as unknown as Store;
      _store = mock;
      return mock;
    });
  }
  return _loading;
}

/** 读取值 */
export async function storeGet<T>(key: string): Promise<T | undefined> {
  const s = await getStore();
  const val = await s.get<T>(key);
  return val ?? undefined;
}

/** 写入值 */
export async function storeSet<T>(key: string, value: T): Promise<void> {
  if (getWindowMode().readonly) return;
  const s = await getStore();
  await s.set(key, value);
}

/** 删除 key */
export async function storeDel(key: string): Promise<void> {
  if (getWindowMode().readonly) return;
  const s = await getStore();
  await s.delete(key);
}

/**
 * 从 localStorage 迁移数据到 Tauri Store。
 * 仅在首次运行时执行（检查 migrated 标记）。
 */
export async function migrateFromLocalStorage(): Promise<void> {
  if (getWindowMode().readonly) return;
  const s = await getStore();
  const migrated = await s.get<boolean>("_migrated_from_ls");
  if (migrated) return;

  // 迁移 4byte 签名缓存
  const fnDb = localStorage.getItem("userFourbyteDb");
  if (fnDb) {
    try { await s.set("userFourbyteDb", JSON.parse(fnDb)); } catch {}
  }
  const evDb = localStorage.getItem("userFourbyteEvDb");
  if (evDb) {
    try { await s.set("userFourbyteEvDb", JSON.parse(evDb)); } catch {}
  }

  // 迁移 RPC 配置
  const chainId = localStorage.getItem("selected_chain_id");
  if (chainId) await s.set("selected_chain_id", parseInt(chainId, 10));
  const rpcUrl = localStorage.getItem("selected_rpc_url");
  if (rpcUrl) await s.set("selected_rpc_url", rpcUrl);

  // 迁移 app 配置
  const isDebug = localStorage.getItem("app.isDebug");
  if (isDebug) await s.set("app.isDebug", isDebug === "true");

  await s.set("_migrated_from_ls", true);
}
