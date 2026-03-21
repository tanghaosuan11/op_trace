import fourbyteDb from "@/lib/fourbyteDb.json";
import { getUserFn, saveUserFn, getUserEv, saveUserEv } from "@/lib/userFourbyteDb";
import { decodeEventLog, decodeFunctionData } from "viem";

const LOCAL_DB = fourbyteDb as Record<string, { fn?: string; ev?: string } | null>;

/** 从本地 DB + Tauri Store 缓存查 function signature（4 字节 selector） */
export function getFnLocal(selector: string): string | undefined {
  return LOCAL_DB[selector]?.fn ?? getUserFn(selector);
}

/** 从本地 DB + Tauri Store 缓存查 event signature（32 字节 topic[0]） */
export function getEvLocal(selector: string): string | undefined {
  return LOCAL_DB[selector]?.ev ?? getUserEv(selector);
}

export interface SignatureLookupResult {
  fn?: string;
  ev?: string;
}

/**
 * 从 Sourcify 4byte 签名库查询 function/event signature。
 * - function selector：calldata 前 4 字节（0x + 8 hex）
 * - event topic：topic[0] 的完整 32 字节（0x + 64 hex）
 * 查到的结果自动写入 Tauri Store 缓存。
 */
export async function lookupSignature4Byte(selector: string): Promise<SignatureLookupResult> {
  const url = `https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=${selector}&event=${selector}&filter=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const fn = (json?.result?.function?.[selector] ?? [])[0]?.name as string | undefined;
  const ev = (json?.result?.event?.[selector] ?? [])[0]?.name as string | undefined;
  if (fn) saveUserFn(selector, fn);
  if (ev) saveUserEv(selector, ev);
  return { fn, ev };
}

export interface DecodedLogArg {
  type: string;
  indexed: boolean;
  value: string;
}

export interface DecodedLogResult {
  eventName: string;
  args: DecodedLogArg[];
}

/**
 * 用 viem 解析 log：根据事件签名推断 indexed 数量（topics.length - 1），构造 ABI 后解码。
 * 签名格式：EventName(type1,type2,...)，来自 4byte 数据库，不含参数名和 indexed 信息。
 */
export function decodeLogEntry(
  evSig: string,
  topics: string[],
  data: string,
): DecodedLogResult | null {
  try {
    const match = evSig.match(/^(\w+)\((.*)\)$/);
    if (!match) return null;
    const [, name, paramsStr] = match;
    const paramTypes = paramsStr ? paramsStr.split(",").map((p) => p.trim()) : [];
    // topics[0] 是签名哈希，其余每个 topic 对应一个 indexed 参数
    const indexedCount = topics.length - 1;

    // 动态构造 ABI，前 indexedCount 个参数标记为 indexed
    const abiInputs = paramTypes.map((type, i) => ({
      type,
      name: `p${i}`,
      indexed: i < indexedCount,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decoded: any = decodeEventLog({
      abi: [{ type: "event", name, inputs: abiInputs }],
      data: data as `0x${string}`,
      topics: topics as [`0x${string}`, ...`0x${string}`[]],
    });

    return {
      eventName: name,
      args: paramTypes.map((type, i) => ({
        type,
        indexed: i < indexedCount,
        value: formatDecodedValue(decoded.args?.[`p${i}`]),
      })),
    };
  } catch {
    return null;
  }
}

export interface DecodedCalldataArg {
  type: string;
  value: string;
}

/**
 * 用 viem 解析 calldata：根据函数签名构造 ABI 后解码，返回每个参数的类型+值。
 * 签名格式：funcName(type1,type2,...)，来自 4byte 数据库。
 */
export function decodeCalldataEntry(
  fnSig: string,
  calldataHex: string,
): DecodedCalldataArg[] | null {
  try {
    const match = fnSig.match(/^(\w+)\((.*)\)$/);
    if (!match) return null;
    const [, name, paramsStr] = match;
    const paramTypes = paramsStr ? paramsStr.split(",").map((p) => p.trim()) : [];
    if (paramTypes.length === 0) return [];
    const abiInputs = paramTypes.map((type, i) => ({ type, name: `p${i}` }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { args } = decodeFunctionData({
      abi: [{ type: "function", name, inputs: abiInputs }],
      data: calldataHex as `0x${string}`,
    }) as unknown as { args: any[] };
    return paramTypes.map((type, i) => ({
      type,
      value: formatDecodedValue(args?.[i]),
    }));
  } catch {
    return null;
  }
}

function formatDecodedValue(val: unknown): string {
  if (val === undefined || val === null) return "?";
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "boolean") return String(val);
  if (typeof val === "string") return val;
  if (val instanceof Uint8Array)
    return "0x" + Array.from(val).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (Array.isArray(val)) return "[" + val.map(formatDecodedValue).join(", ") + "]";
  if (typeof val === "object")
    return JSON.stringify(val, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  return String(val);
}
