// 地址标签系统 — 获取并缓存链上地址的标签信息。

import { load, type Store } from "@tauri-apps/plugin-store";
import { invoke } from "@/lib/ipc-bridge";


/** 单个地址标签 */
export interface AddressLabelItem {
  address: string;        
  chainId: number;
  label: string;           
  name?: string;          
  symbol?: string;        
  website?: string;
  image?: string | null;
}

/** 缓存的地址标签数据 */
export interface CachedAddressLabels {
  address: string;
  chainId: number;
  labels: AddressLabelItem[]; 
  fetchedAt: number;          
}

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

async function getAddressLabelsStore(): Promise<Store> {
  if (_store) return _store;
  if (!_loading) {
    _loading = load("address_labels.json", { autoSave: true, defaults: {} }).then((s) => {
      _store = s;
      return s;
    }).catch(() => { _store = makeLocalStorageMock('addr'); return _store!; });
  }
  return _loading;
}

function storeKey(chainId: number, address: string): string {
  return `labels:${chainId}:${address.toLowerCase()}`;
}


/** 正在进行中的 API 请求 Map —— key: "${address}"，value: Promise<AddressLabelItem[]> */
const _inflight = new Map<string, Promise<AddressLabelItem[]>>();

/** 请求队列 */
const _queue: Array<{
  address: string;
  resolve: (labels: AddressLabelItem[]) => void;
  reject: (err: Error) => void;
}> = [];

/** 当前并发数 */
let _concurrentCount = 0;
const MAX_CONCURRENT = 5;

/** 处理队列中的下一个任务 */
async function _processQueue(): Promise<void> {
  if (_concurrentCount >= MAX_CONCURRENT || _queue.length === 0) {
    return;
  }

  _concurrentCount++;
  const task = _queue.shift()!;

  try {
    const labels = await fetchLabelsFromAPI(task.address);
    task.resolve(labels);
  } catch (err) {
    task.reject(err instanceof Error ? err : new Error(String(err)));
  }

  _concurrentCount--;
  _processQueue(); // 继续处理下一个
}

/**
 * 将 API 请求加入队列，支持去重。
 * 如果已有相同地址的请求正在处理，直接返回那个 Promise。
 */
function _queueFetchWithDedup(address: string): Promise<AddressLabelItem[]> {
  const key = address.toLowerCase();

  // 如果已在处理，直接返回
  if (_inflight.has(key)) {
    return _inflight.get(key)!;
  }

  // 创建新 Promise 并加入队列
  const promise = new Promise<AddressLabelItem[]>((resolve, reject) => {
    _queue.push({ address: key, resolve, reject });
  });

  _inflight.set(key, promise);

  // Promise 完成后清理 inflight
  promise
    .finally(() => {
      _inflight.delete(key);
    })
    .catch(() => {
      // 避免未处理的 rejection
    });

  // 开始处理
  _processQueue();

  return promise;
}


/**
 * 从 eth-labels.com API 获取地址标签（通过 Tauri 后端代理）。
 * 返回该地址在所有 chain 上的标签数组，未做过滤。
 */
async function fetchLabelsFromAPI(address: string): Promise<AddressLabelItem[]> {
  try {
    const data: AddressLabelItem[] = await invoke("fetch_address_labels", {
      address: address.toLowerCase(),
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn(`[AddressLabel] Tauri command failed: ${err}`);
    return [];
  }
}


// 获取指定地址和 chain 的标签。
export async function getAddressLabel(
  chainId: number,
  address: string
): Promise<AddressLabelItem | null> {
  const key = storeKey(chainId, address);
  const store = await getAddressLabelsStore();

  // 1. 尝试从本地读取
  try {
    const cached = await store.get<CachedAddressLabels>(key);
    if (cached) {
      const firstMatch = cached.labels.find((l) => l.chainId === chainId);
      if (firstMatch) {
        console.log(`[AddressLabel] Cache hit: ${address} on chain ${chainId}`);
        return firstMatch;
      }
    }
  } catch (err) {
    console.warn(`[AddressLabel] Cache read error: ${err}`);
  }

  // 2. API 获取（通过队列）
  console.log(`[AddressLabel] Queue fetch: ${address}`);
  const allLabels = await _queueFetchWithDedup(address);
  if (allLabels.length === 0) {
    return null;
  }

  // 3. 筛选与 chainId 一致的第一个
  const matchedLabel = allLabels.find((l) => l.chainId === chainId);
  if (!matchedLabel) {
    return null;
  }

  // 4. 存入本地（所有标签都存，但只返回当前 chain 的第一个）
  try {
    await store.set(key, {
      address: address.toLowerCase(),
      chainId,
      labels: allLabels,
      fetchedAt: Date.now(),
    } as CachedAddressLabels);
  } catch (err) {
    console.warn(`[AddressLabel] Cache write error: ${err}`);
  }

  console.log(`[AddressLabel] API result cached: ${address} on chain ${chainId}`);
  return matchedLabel;
}

// 批量获取地址标签
export async function getAddressLabels(
  chainId: number,
  addresses: string[]
): Promise<(AddressLabelItem | null)[]> {
  const store = await getAddressLabelsStore();
  const results: (AddressLabelItem | null)[] = new Array(addresses.length).fill(null);
  const toFetch: { index: number; address: string }[] = [];

  // 第一步：检查本地缓存，避免不必要的 API 请求
  for (let i = 0; i < addresses.length; i++) {
    const addr = addresses[i];
    const key = storeKey(chainId, addr);

    try {
      const cached = await store.get<CachedAddressLabels>(key);
      if (cached) {
        const firstMatch = cached.labels.find((l) => l.chainId === chainId);
        if (firstMatch) {
          results[i] = firstMatch;
          console.log(`[AddressLabel] Cache hit: ${addr} on chain ${chainId}`);
          continue;
        }
      }
    } catch (err) {
      console.warn(`[AddressLabel] Cache read error for ${addr}: ${err}`);
    }

    // 本地无，加入待查询列表
    toFetch.push({ index: i, address: addr });
  }

  // 第二步：去重 — 相同地址只查询一次
  const uniqueFetch = new Map<string, { index: number; address: string }[]>();
  for (const item of toFetch) {
    const normalized = item.address.toLowerCase();
    if (!uniqueFetch.has(normalized)) {
      uniqueFetch.set(normalized, []);
    }
    uniqueFetch.get(normalized)!.push(item);
  }

  // 第三步：批量查询（通过队列，自动并发控制）
  const fetchPromises: Array<Promise<void>> = [];

  for (const [normalizedAddr, items] of uniqueFetch) {
    const promise = _queueFetchWithDedup(normalizedAddr)
      .then((allLabels) => {
        // 对所有相同地址的结果赋值
        const matchedLabel = allLabels.find((l) => l.chainId === chainId) || null;
        for (const item of items) {
          results[item.index] = matchedLabel;
        }

        // 存入本地（所有标签都存）
        if (allLabels.length > 0) {
          store
            .set(storeKey(chainId, normalizedAddr), {
              address: normalizedAddr,
              chainId,
              labels: allLabels,
              fetchedAt: Date.now(),
            } as CachedAddressLabels)
            .catch((err) => {
              console.warn(
                `[AddressLabel] Cache write error for ${normalizedAddr}: ${err}`
              );
            });
        }
      })
      .catch((err) => {
        console.warn(`[AddressLabel] Fetch error for ${normalizedAddr}: ${err}`);
        // 失败时对应位置保持 null
      });

    fetchPromises.push(promise);
  }

  // 等待所有 API 请求完成
  await Promise.all(fetchPromises);

  return results;
}

// 删除指定地址和 chain 的缓存标签。
export async function deleteAddressLabelCache(
  chainId: number,
  address: string
): Promise<void> {
  const store = await getAddressLabelsStore();
  await store.delete(storeKey(chainId, address));
}

// 清空所有缓存标签。
export async function clearAllAddressLabelCache(): Promise<void> {
  const store = await getAddressLabelsStore();
  // plugin-store 没有 clear 方法，只能逐个删除，但这里我们直接清空整个文件
  // 通过重新初始化来实现
  const keys = await store.keys();
  for (const key of keys) {
    if (key.startsWith("labels:")) {
      await store.delete(key);
    }
  }
}

// 获取所有缓存的地址标签信息（用于诊断）。
export async function getAllAddressLabelCache(): Promise<CachedAddressLabels[]> {
  const store = await getAddressLabelsStore();
  const keys = await store.keys();
  const results: CachedAddressLabels[] = [];

  for (const key of keys) {
    if (key.startsWith("labels:")) {
      const cached = await store.get<CachedAddressLabels>(key);
      if (cached) {
        results.push(cached);
      }
    }
  }

  return results;
}

// 获取请求队列状态（用于诊断和监控）。
export function getQueueStatus(): {
  queueLength: number;
  inflightCount: number;
  concurrentCount: number;
  maxConcurrent: number;
  inflightAddresses: string[];
} {
  return {
    queueLength: _queue.length,
    inflightCount: _inflight.size,
    concurrentCount: _concurrentCount,
    maxConcurrent: MAX_CONCURRENT,
    inflightAddresses: Array.from(_inflight.keys()),
  };
}

// 等待所有正在运行的 API 请求完成。
export async function waitForAllPendingRequests(): Promise<void> {
  if (_queue.length === 0 && _inflight.size === 0) {
    return;
  }

  // 等待所有 inflight 的 Promise
  const promises = Array.from(_inflight.values());
  await Promise.all(promises).catch(() => {
    // 忽略单个请求的错误
  });
}
