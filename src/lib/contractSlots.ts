/** Storage slot typing; persisted in `contracts.json` (separate from settings). */
import { load, type Store } from "@tauri-apps/plugin-store";

/** 基础值类型：address / bool / uintN / intN / bytesN / bytes / string */
export interface SolPrimitive {
  kind: "primitive";
  type: string; // e.g. "address", "uint256", "bool", "bytes32"
}

/** 数组类型：T[] 或 T[N] */
export interface SolArray {
  kind: "array";
  element: SolType;
  size?: number; // undefined = 动态数组 []
}

/**
 * 映射类型：mapping(K => V)
 * Solidity 约束：key 只能是值类型（SolPrimitive）
 */
export interface SolMapping {
  kind: "mapping";
  key: SolPrimitive;
  value: SolType;
}

/** 结构体：多个命名字段 */
export interface SolStruct {
  kind: "struct";
  name?: string;
  fields: Array<{ name: string; type: SolType }>;
}

/**
 * 打包槽：多个值类型共用同一个 32 字节槽（Solidity slot packing）。
 * byteOffset 从 LSB（最低字节 = 最右字节）起算，与 Solidity 实际布局一致。
 */
export interface SolPacked {
  kind: "packed";
  fields: Array<{
    name: string;
    type: SolPrimitive; // 打包槽内只有值类型
    byteOffset: number; // 从 LSB 起的字节偏移（0 = 最低字节）
    byteSize: number;   // 占用字节数
  }>;
}

export type SolType = SolPrimitive | SolArray | SolMapping | SolStruct | SolPacked;

export interface SlotInfo {
  /** 32 字节 hex 字符串，e.g. "0x0000...0001"，对应 SSTORE/SLOAD 的 key */
  slotHex: string;
  /** 用户自定义名称，例如 "balances", "owner" */
  name?: string;
  type: SolType;
}

export interface ContractSlots {
  chainId: number;
  address: string;  // 小写
  slots: SlotInfo[];
  updatedAt: number; // Date.now()
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

async function getContractsStore(): Promise<Store> {
  if (_store) return _store;
  if (!_loading) {
    _loading = load("contracts.json", { autoSave: true, defaults: {} }).then((s) => {
      _store = s;
      return s;
    }).catch(() => { _store = makeLocalStorageMock('slots'); return _store!; });
  }
  return _loading;
}

function storeKey(chainId: number, address: string): string {
  return `slots:${chainId}:${address.toLowerCase()}`;
}

export async function getContractSlots(
  chainId: number,
  address: string
): Promise<ContractSlots | null> {
  const s = await getContractsStore();
  const val = await s.get<ContractSlots>(storeKey(chainId, address));
  return val ?? null;
}

export async function saveContractSlots(data: ContractSlots): Promise<void> {
  const s = await getContractsStore();
  await s.set(storeKey(data.chainId, data.address), {
    ...data,
    address: data.address.toLowerCase(),
    updatedAt: Date.now(),
  });
}

export async function deleteContractSlots(
  chainId: number,
  address: string
): Promise<void> {
  const s = await getContractsStore();
  await s.delete(storeKey(chainId, address));
}

/** slot 数字（或 bigint）→ 32 字节 hex 字符串 */
export function slotNumberToHex(slot: number | bigint): string {
  return "0x" + BigInt(slot).toString(16).padStart(64, "0");
}

/**
 * 将用户输入的 slot 字符串（十进制或 0x 前缀 hex）
 * 标准化为 32 字节小写 hex 字符串。
 * 抛出 Error 若格式非法。
 */
export function normalizeSlotHex(input: string): string {
  const t = input.trim();
  try {
    const n = t.startsWith("0x") || t.startsWith("0X") ? BigInt(t) : BigInt(t);
    return "0x" + n.toString(16).padStart(64, "0");
  } catch {
    throw new Error(`Invalid slot: "${input}"`);
  }
}

/** 将 SolType 转换为可读字符串 */
export function solTypeToString(t: SolType): string {
  switch (t.kind) {
    case "primitive":
      return t.type;
    case "array":
      return `${solTypeToString(t.element)}[${t.size ?? ""}]`;
    case "mapping":
      return `mapping(${t.key.type} => ${solTypeToString(t.value)})`;
    case "struct": {
      const fs = t.fields.map((f) => `${solTypeToString(f.type)} ${f.name}`).join("; ");
      return t.name ? `struct ${t.name} { ${fs} }` : `{ ${fs} }`;
    }
    case "packed": {
      const fs = t.fields.map((f) => `${f.type.type} ${f.name}@${f.byteOffset}`).join(", ");
      return `packed(${fs})`;
    }
  }
}
