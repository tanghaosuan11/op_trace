/**
 * 合约 Storage 槽位类型系统。
 * 使用独立的 contracts.json Tauri Store（与 settings.json 隔离）。
 */
import { load, type Store } from "@tauri-apps/plugin-store";

// ── SolType 判别联合 ────────────────────────────────────────────

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

// ── 槽位定义 ─────────────────────────────────────────────────────

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

// ── 独立 Store 实例（contracts.json）─────────────────────────────

let _store: Store | null = null;
let _loading: Promise<Store> | null = null;

async function getContractsStore(): Promise<Store> {
  if (_store) return _store;
  if (!_loading) {
    _loading = load("contracts.json", { autoSave: true, defaults: {} }).then((s) => {
      _store = s;
      return s;
    });
  }
  return _loading;
}

function storeKey(chainId: number, address: string): string {
  return `slots:${chainId}:${address.toLowerCase()}`;
}

// ── CRUD ─────────────────────────────────────────────────────────

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

// ── 工具函数 ─────────────────────────────────────────────────────

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
