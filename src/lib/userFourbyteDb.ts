/**
 * 用户自定义的 4byte 签名缓存。
 * 内存缓存 + Tauri Store 持久化（替代 localStorage）。
 * 应用启动时调用 initUserFourbyteDb() 加载缓存到内存。
 */
import { storeGet, storeSet } from "./tauriStore";

const FN_KEY = "userFourbyteDb";
const EV_KEY = "userFourbyteEvDb";

let fnCache: Record<string, string> = {};
let evCache: Record<string, string> = {};
let _inited = false;

/** 应用启动时调用，从 Tauri Store 加载缓存到内存 */
export async function initUserFourbyteDb(): Promise<void> {
  if (_inited) return;
  const [fn, ev] = await Promise.all([
    storeGet<Record<string, string>>(FN_KEY),
    storeGet<Record<string, string>>(EV_KEY),
  ]);
  fnCache = fn ?? {};
  evCache = ev ?? {};
  _inited = true;
}

export function getUserFn(selector: string): string | undefined {
  return fnCache[selector];
}

export function saveUserFn(selector: string, fn: string) {
  fnCache[selector] = fn;
  storeSet(FN_KEY, { ...fnCache });
}

export function getUserEv(selector: string): string | undefined {
  return evCache[selector];
}

export function saveUserEv(selector: string, ev: string) {
  evCache[selector] = ev;
  storeSet(EV_KEY, { ...evCache });
}
