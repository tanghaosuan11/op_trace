/**
 * 统一的 Tauri Store 封装。
 * 所有持久化数据通过此模块读写，替代 localStorage。
 * 文件保存在 app data 目录下的 settings.json。
 */
import { load, type Store } from "@tauri-apps/plugin-store";

let _store: Store | null = null;
let _loading: Promise<Store> | null = null;

/** 获取单例 Store 实例 */
export async function getStore(): Promise<Store> {
  if (_store) return _store;
  if (!_loading) {
    _loading = load("settings.json", { autoSave: true, defaults: {} }).then((s) => {
      _store = s;
      return s;
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
  const s = await getStore();
  await s.set(key, value);
}

/** 删除 key */
export async function storeDel(key: string): Promise<void> {
  const s = await getStore();
  await s.delete(key);
}

/**
 * 从 localStorage 迁移数据到 Tauri Store。
 * 仅在首次运行时执行（检查 migrated 标记）。
 */
export async function migrateFromLocalStorage(): Promise<void> {
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
