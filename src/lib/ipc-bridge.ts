// 统一 IPC 层：Tauri 用 @tauri-apps/api/core，VSCode 用 window.__optrace_vscode_invoke__

// 是否运行在 VSCode webview 中
const isVSCode = typeof (window as unknown as Record<string, unknown>).__optrace_vscode_invoke__ !== 'undefined';

// VSCode postMessage 不支持 BigInt/Function，序列化前先清理

function sanitizeForJson(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'function') return undefined;
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sanitizeForJson);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = sanitizeForJson(val);
    if (s !== undefined) out[k] = s;
  }
  return out;
}



type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let _invoke: InvokeFn;

if (isVSCode) {
  const vsInvoke = (window as unknown as Record<string, unknown>).__optrace_vscode_invoke__ as InvokeFn;
  _invoke = ((cmd: string, args?: Record<string, unknown>) =>
    vsInvoke(cmd, sanitizeForJson(args) as Record<string, unknown>)
  ) as InvokeFn;
} else {
  // 动态 import 避免 bundler 在 VSCode 模式下报错
  _invoke = (async (cmd: string, args?: Record<string, unknown>) => {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke(cmd, args);
  }) as InvokeFn;
}

export const invoke: InvokeFn = _invoke;

// Channel：Tauri 用原生 Channel，VSCode 用 daemon push event

export type ChannelHandler<T = unknown> = (data: T) => void;
export class Channel<T = unknown> {
  private _handler: ChannelHandler<T> | null = null;

  set onmessage(handler: ChannelHandler<T>) {
    this._handler = handler;
    if (isVSCode) {
      const onEvent = (window as unknown as Record<string, unknown>).__optrace_on_event__ as (
        event: string, handler: (data: unknown) => void
      ) => void;
      if (onEvent) {
        // daemon 推送 base64 编码的二进制帧，解码为 ArrayBuffer
        onEvent('op_trace_msg', (data: unknown) => {
          let decoded: T;
          if (typeof data === 'string') {
            const binStr = atob(data);
            const bytes = new Uint8Array(binStr.length);
            for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
            decoded = bytes.buffer as unknown as T;
          } else {
            decoded = data as T;
          }
          handler(decoded);
        });
      }
    }
  }

  get onmessage(): ChannelHandler<T> | null {
    return this._handler;
  }

  // 兼容 Tauri Channel 接口
  get id(): number { return 0; }
}

// Store 兼容层：VSCode 用 localStorage 模拟

export interface StoreCompat {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
}

export async function loadStore(_path: string): Promise<StoreCompat> {
  if (isVSCode) {
    return {
      async get<T>(key: string): Promise<T | null> {
        const raw = localStorage.getItem('optrace:' + key);
        return raw ? JSON.parse(raw) : null;
      },
      async set(key: string, value: unknown): Promise<void> {
        localStorage.setItem('optrace:' + key, JSON.stringify(value));
      },
      async save(): Promise<void> {},
    };
  } else {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load(_path);
    return {
      async get<T>(key: string): Promise<T | null> {
        const val = await store.get<T>(key);
        return val ?? null; // 确保返回 T | null 而非 T | undefined
      },
      async set(key: string, value: unknown): Promise<void> {
        await store.set(key, value);
      },
      async save(): Promise<void> {
        await store.save();
      },
    };
  }
}

// 窗口 API 兼容层

export async function closeCurrentWindow(): Promise<void> {
  if (isVSCode) {
    // 通知 extension host 关闭 panel
    invoke('__close_panel__', {}).catch(() => {});
  } else {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    win.close();
  }
}

export function isRunningInVSCode(): boolean {
  return isVSCode;
}
