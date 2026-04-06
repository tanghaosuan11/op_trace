import { useState, useEffect } from "react";
import {
  keccak256, toBytes, isHex, isAddress, getAddress,
  pad, concat,
  parseAbiItem,
  encodeFunctionData,
  decodeFunctionData,
  toFunctionSelector,
  formatUnits, parseUnits,
  createPublicClient, http,
} from "viem";
import type { Abi, AbiFunction, AbiParameter } from "viem";
import { BottomSheetShell } from "@/components/ui/bottom-sheet-shell";
import { SheetClose } from "@/components/ui/sheet";
import { X, Pin, PinOff, Wrench, Copy, Eye, PenLine, Code } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDebugStore } from "@/store/debugStore";
import { useDrawerActions } from "@/hooks/useDrawerActions";
import { getSelectedRpc } from "@/lib/rpcConfig";

type Tool = "conv" | "hash4byte" | "checksum" | "abi" | "slot";

const TOOLS: { id: Tool; label: string }[] = [
  { id: "conv",      label: "Conv"       },
  { id: "hash4byte", label: "Keccak·4byte" },
  // { id: "checksum",  label: "Checksum"  },
  { id: "abi",       label: "ABI Encode" },
  { id: "slot",      label: "SlotRead"   },
];

function parseNumber(val: string): bigint | null {
  const s = val.trim();
  if (!s) return null;
  try {
    if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
    if (/^[0-9a-fA-F]+$/.test(s) && /[a-fA-F]/.test(s)) return BigInt("0x" + s);
    return BigInt(s);
  } catch { return null; }
}

function Err({ msg }: { msg: string }) {
  return <p className="text-xs text-amber-500">{msg}</p>;
}
function ResultBox({ value }: { value: string }) {
  return <div className="text-xs font-mono px-2 py-1 bg-muted rounded select-all break-all">{value}</div>;
}

function BaseConvTool() {
  // 记录当前正在编辑的进制和原始输入，其他栏位从解析结果派生
  const [src, setSrc] = useState<{ base: number; raw: string } | null>(null);

  const parsed = (() => {
    if (!src?.raw.trim()) return null;
    try {
      const s = src.raw.trim();
      if (src.base === 2)  return BigInt("0b" + s.replace(/^0b/i, ""));
      if (src.base === 8)  return BigInt("0o" + s.replace(/^0o/i, ""));
      if (src.base === 16) return BigInt("0x" + s.replace(/^0x/i, ""));
      return BigInt(s);
    } catch { return null; }
  })();

  const val = (base: number) => {
    if (src?.base === base) return src.raw;
    if (parsed === null) return "";
    if (base === 2)  return parsed.toString(2);
    if (base === 8)  return "0o" + parsed.toString(8);
    if (base === 10) return parsed.toString(10);
    return "0x" + parsed.toString(16).toLowerCase();
  };

  const rows = [
    { base: 2,  ph: "1010" },
    { base: 8,  ph: "377"  },
    { base: 10, ph: "255"  },
    { base: 16, ph: "ff"   },
  ];

  return (
    <div className="space-y-1">
      {rows.map(({ base, ph }) => (
        <div key={base} className="flex items-center gap-1.5">
          <span className="text-[11px] font-mono text-muted-foreground w-4 text-right shrink-0 select-none">{base}</span>
          <Input
            value={val(base)}
            onChange={(e) => setSrc({ base, raw: e.target.value })}
            onFocus={() => { if (src?.base !== base) setSrc({ base, raw: val(base) }); }}
            placeholder={ph}
            className="font-mono h-7 text-xs"
            autoFocus={base === 10}
          />
        </div>
      ))}
      {src?.raw.trim() && parsed === null && <Err msg="Invalid input" />}
    </div>
  );
}

function GweiTool() {
  const [input, setInput] = useState("");
  const [unit, setUnit] = useState<"wei" | "gwei" | "ether">("gwei");
  let wei: bigint | null = null, err = "";
  try {
    if (input.trim()) wei = parseUnits(input.trim(), unit === "wei" ? 0 : unit === "gwei" ? 9 : 18);
  } catch { err = "Invalid number"; }
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input placeholder="1.5" value={input} onChange={(e) => setInput(e.target.value)}
          className="font-mono h-7 text-xs flex-1" />
        <Select value={unit} onValueChange={(v) => setUnit(v as typeof unit)}>
          <SelectTrigger className="h-7 text-xs w-20 font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="wei" className="text-xs font-mono">wei</SelectItem>
            <SelectItem value="gwei" className="text-xs font-mono">gwei</SelectItem>
            <SelectItem value="ether" className="text-xs font-mono">ether</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {err ? <Err msg={err} /> : wei !== null && (
        <div className="space-y-0.5 text-xs font-mono">
          {[
            { label: "wei",   value: wei.toString() },
            { label: "gwei",  value: formatUnits(wei, 9) },
            { label: "ether", value: formatUnits(wei, 18) },
            { label: "hex",   value: "0x" + wei.toString(16).toLowerCase() },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="text-muted-foreground shrink-0 w-8">{label}</span>
              <span className="select-all break-all">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Keccak256Tool() {
  const [input, setInput] = useState("");
  const [asHex, setAsHex] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const compute = () => {
    setError(""); setResult("");
    const s = input.trim(); if (!s) return;
    try {
      const bytes = asHex
        ? (isHex(s) ? toBytes(s as `0x${string}`) : (() => { throw new Error("Invalid hex"); })())
        : new TextEncoder().encode(s);
      setResult(keccak256(bytes));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-center">
        <Input placeholder={asHex ? "0xdeadbeef..." : "transfer(address,uint256)"} value={input}
          onChange={(e) => { setInput(e.target.value); setResult(""); setError(""); }}
          className="font-mono h-7 text-xs flex-1"
          onKeyDown={(e) => e.key === "Enter" && compute()} autoFocus />
        <label className="flex items-center gap-1 cursor-pointer select-none shrink-0">
          <input type="checkbox" checked={asHex}
            onChange={(e) => { setAsHex(e.target.checked); setResult(""); setError(""); }}
            className="h-3 w-3 accent-primary" />
          <span className="text-[11px] text-muted-foreground">hex</span>
        </label>
        <Button size="sm" className="h-7 px-3 text-xs shrink-0" onClick={compute}>Hash</Button>
      </div>
      {error && <Err msg={error} />}
      {result && (
        <div className="space-y-0.5 text-xs font-mono">
          <ResultBox value={result} />
          <div className="px-1 text-muted-foreground">4-byte: <span className="text-foreground select-all">{result.slice(0, 10)}</span></div>
        </div>
      )}
    </div>
  );
}

function KeccakFourByteTool() {
  return (
    <div className="grid min-h-0 grid-cols-1 gap-2 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
      <div className="min-w-0 space-y-1.5 pb-2 sm:pb-0 sm:pr-2">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Keccak256</p>
        <Keccak256Tool />
      </div>
      <div className="min-w-0 space-y-1.5 pt-2 sm:pt-0 sm:pl-2">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">4byte.directory</p>
        <FourByteTool />
      </div>
    </div>
  );
}

function FourByteTool() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const handleLookup = async () => {
    const selector = input.trim().replace(/^0x/i, "");
    if (selector.length !== 8 || !/^[0-9a-fA-F]{8}$/.test(selector)) { setError("Need 8 hex chars"); return; }
    setLoading(true); setError(""); setResults([]);
    try {
      const res = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=0x${selector}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const r: string[] = (json.results ?? []).map((x: { text_signature: string }) => x.text_signature);
      setResults(r.length ? r : ["No matches found"]);
    } catch (e) {
      setError("Lookup failed: " + (e instanceof Error ? e.message : String(e)));
    } finally { setLoading(false); }
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input placeholder="a9059cbb  or  0xa9059cbb" value={input}
          onChange={(e) => { setInput(e.target.value); setError(""); setResults([]); }}
          className="font-mono h-7 text-xs flex-1"
          onKeyDown={(e) => e.key === "Enter" && handleLookup()} />
        <Button size="sm" className="h-7 px-3 text-xs" onClick={handleLookup} disabled={loading}>
          {loading ? "..." : "Lookup"}
        </Button>
      </div>
      {error && <Err msg={error} />}
      {results.length > 0 && (
        <div className="space-y-1 overflow-auto max-h-[90px]">
          {results.map((sig, i) => <div key={i} className="text-xs font-mono px-2 py-1 bg-muted rounded select-all">{sig}</div>)}
        </div>
      )}
    </div>
  );
}

function ChecksumTool() {
  const [input, setInput] = useState("");
  let result = "", err = "";
  const s = input.trim();
  if (s) { try { result = getAddress(s); } catch { err = "Invalid address"; } }
  return (
    <div className="space-y-2">
      <Input placeholder="0xabc...  (any case)" value={input}
        onChange={(e) => setInput(e.target.value)} className="font-mono h-7 text-xs" autoFocus />
      {err && <Err msg={err} />}
      {result && (
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs font-mono items-start">
          <span className="text-muted-foreground pt-0.5">EIP-55</span>
          <div className="flex items-center gap-2">
            <span className="select-all break-all">{result}</span>
            {result === s && <span className="text-emerald-400 shrink-0 text-[10px]">✓</span>}
          </div>
          <span className="text-muted-foreground pt-0.5">lower</span>
          <span className="select-all break-all text-muted-foreground">{result.toLowerCase()}</span>
        </div>
      )}
    </div>
  );
}

/** Parse one argument from UI string according to Solidity ABI type (scalar, tuple, array → JSON). */
function parseAbiArgValue(raw: string, param: AbiParameter): unknown {
  const v = raw.trim();
  const t = param.type;
  const label = param.name ? `${param.name} (${t})` : t;

  if (t === "tuple" || t.startsWith("tuple(")) {
    if (!v) throw new Error(`${label}: empty — use JSON for tuple`);
    return JSON.parse(v);
  }
  if (t.includes("[") && t.includes("]")) {
    if (!v) throw new Error(`${label}: empty — use JSON array`);
    return JSON.parse(v);
  }
  if (t === "address") {
    if (!isAddress(v)) throw new Error(`${label}: invalid address`);
    return getAddress(v);
  }
  if (t === "bool") {
    const l = v.toLowerCase();
    if (l === "true" || l === "1") return true;
    if (l === "false" || l === "0") return false;
    throw new Error(`${label}: use true, false, 1, or 0`);
  }
  if (t.startsWith("uint") && /^uint[0-9]+$/.test(t)) {
    try {
      return BigInt(v);
    } catch {
      throw new Error(`${label}: invalid integer (decimal or 0x hex)`);
    }
  }
  if (t.startsWith("int") && /^int[0-9]+$/.test(t)) {
    try {
      return BigInt(v);
    } catch {
      throw new Error(`${label}: invalid integer (decimal or 0x hex)`);
    }
  }
  if (t === "bytes") {
    if (!isHex(v)) throw new Error(`${label}: dynamic bytes — hex string`);
    return v as `0x${string}`;
  }
  {
    const m = /^bytes([1-9]|[12][0-9]|32)$/.exec(t);
    if (m) {
      if (!isHex(v)) throw new Error(`${label}: fixed bytes — hex`);
      const want = parseInt(m[1], 10);
      const got = (v.length - 2) / 2;
      if (got !== want) throw new Error(`${label}: need exactly ${want} bytes (${want * 2} hex chars)`);
      return v as `0x${string}`;
    }
  }
  if (t === "string") return v;
  throw new Error(`${label}: unsupported type — use JSON for complex types`);
}

function formatFunctionLabel(fn: AbiFunction, selector: string): string {
  const sig = `${fn.name}(${fn.inputs.map((i) => i.type).join(",")})`;
  const short = sig.length > 42 ? `${sig.slice(0, 40)}…` : sig;
  return `${selector.slice(0, 10)}  ${short}`;
}

/** view/pure (eth_call); nonpayable/payable = write */
function isAbiFunctionRead(fn: AbiFunction): boolean {
  const m = fn.stateMutability;
  if (m === "view" || m === "pure") return true;
  if (m === "nonpayable" || m === "payable") return false;
  const legacy = fn as AbiFunction & { constant?: boolean };
  if (legacy.constant === true) return true;
  return false;
}

function AbiTool() {
  const [abiText, setAbiText] = useState("");
  const [abi, setAbi] = useState<Abi | null>(null);
  const [leftError, setLeftError] = useState("");

  const [abiOpMode, setAbiOpMode] = useState<"encode" | "decode">("encode");
  const [fetchEnabled, setFetchEnabled] = useState(false);
  const [fetchAddress, setFetchAddress] = useState("");
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [fetchResult, setFetchResult] = useState("");

  const [fnSelect, setFnSelect] = useState("custom");
  const [customSig, setCustomSig] = useState("");
  const [argValues, setArgValues] = useState<string[]>([]);
  const [argErrors, setArgErrors] = useState<string[]>([]);

  const [decodeCalldata, setDecodeCalldata] = useState("");
  const [decodeResult, setDecodeResult] = useState("");
  const [decodeError, setDecodeError] = useState("");

  const [encoded, setEncoded] = useState("");
  const [encodeError, setEncodeError] = useState("");

  const functions = abi ? abi.filter((x): x is AbiFunction => x.type === "function") : [];

  const currentFunction = ((): AbiFunction | null => {
    if (fnSelect === "custom") {
      const s = customSig.trim();
      if (!s) return null;
      try {
        const item = parseAbiItem(`function ${s}`);
        return item.type === "function" ? item : null;
      } catch {
        return null;
      }
    }
    const m = /^fn-(\d+)$/.exec(fnSelect);
    if (!m || !abi) return null;
    const i = parseInt(m[1], 10);
    return functions[i] ?? null;
  })();

  const params = currentFunction?.inputs ?? [];

  useEffect(() => {
    const t = window.setTimeout(() => {
      const raw = abiText.trim();
    setEncoded("");
    setDecodeResult("");
    setFetchResult("");
    if (!raw) {
        setAbi(null);
        setLeftError("");
        return;
      }
      try {
        const json = JSON.parse(raw) as unknown;
        if (!Array.isArray(json)) {
          setLeftError("ABI must be a JSON array");
          setAbi(null);
          setFnSelect("custom");
          return;
        }
        const parsed = json as Abi;
        setAbi(parsed);
        setLeftError("");
        const fns = parsed.filter((x): x is AbiFunction => x.type === "function");
        setFnSelect((prev) => {
          if (prev === "custom") return "custom";
          const m = /^fn-(\d+)$/.exec(prev);
          if (m) {
            const i = parseInt(m[1], 10);
            if (i < fns.length) return prev;
          }
          return fns.length > 0 ? "fn-0" : "custom";
        });
      } catch (e) {
        setAbi(null);
        setLeftError(e instanceof Error ? e.message : String(e));
        setFnSelect("custom");
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [abiText]);

  const setArgAt = (i: number, val: string) => {
    setArgValues((prev) => {
      const next = [...prev];
      next[i] = val;
      return next;
    });
    setArgErrors((prev) => {
      const next = [...prev];
      next[i] = "";
      return next;
    });
    setEncoded("");
    setEncodeError("");
    setDecodeResult("");
    setDecodeError("");
    setFetchResult("");
    setFetchError("");
  };

  const paramCount = params.length;

  useEffect(() => {
    setArgValues((prev) => Array.from({ length: paramCount }, (_, i) => prev[i] ?? ""));
    setArgErrors(Array.from({ length: paramCount }, () => ""));
  }, [paramCount]);

  const collectEncodeArgs = (fn: AbiFunction): { ok: true; args: unknown[] } | { ok: false; errs: string[] } => {
    const n = fn.inputs.length;
    const errs: string[] = Array(n).fill("");
    const args: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const p = fn.inputs[i];
      const raw = argValues[i] ?? "";
      try {
        args.push(parseAbiArgValue(raw, p));
      } catch (e) {
        errs[i] = e instanceof Error ? e.message : String(e);
      }
    }
    if (errs.some((e) => e)) return { ok: false, errs };
    return { ok: true, args };
  };

  const runEncode = () => {
    setEncodeError("");
    setEncoded("");
    const fn = currentFunction;
    if (!fn) {
      setEncodeError(fnSelect === "custom" ? "Enter a valid function signature" : "Select a function");
      return;
    }
    const collected = collectEncodeArgs(fn);
    if (!collected.ok) {
      setArgErrors(collected.errs);
      setEncodeError("Fix argument errors");
      return;
    }
    try {
      let data: `0x${string}`;
      if (fnSelect === "custom") {
        data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: collected.args as never });
      } else {
        if (!abi) {
          setEncodeError("Paste a valid JSON ABI or use custom");
          return;
        }
        data = encodeFunctionData({ abi, functionName: fn.name, args: collected.args as never });
      }
      setEncoded(data);
      setArgErrors(Array(paramCount).fill(""));
    } catch (e) {
      setEncodeError(e instanceof Error ? e.message : String(e));
    }
  };

  const runFetch = async () => {
    setFetchError("");
    setFetchResult("");
    const fn = currentFunction;
    if (!fn) {
      setFetchError(fnSelect === "custom" ? "Enter a valid function signature" : "Select a function");
      return;
    }
    if (!isAbiFunctionRead(fn)) {
      window.alert(
        "Only view/pure (read) functions can be fetched on-chain. This function is a write (nonpayable/payable).",
      );
      return;
    }
    const collected = collectEncodeArgs(fn);
    if (!collected.ok) {
      setArgErrors(collected.errs);
      setFetchError("Fix argument errors");
      return;
    }
    const addr = fetchAddress.trim();
    if (!addr) {
      setFetchError("Enter contract address");
      return;
    }
    if (!isAddress(addr)) {
      setFetchError("Invalid contract address");
      return;
    }
    const abiForRead = fnSelect === "custom" ? [fn] : abi;
    if (!abiForRead) {
      setFetchError("Paste a valid JSON ABI or use custom");
      return;
    }
    setFetchLoading(true);
    try {
      const client = createPublicClient({ transport: http(getSelectedRpc()) });
      const result = await client.readContract({
        address: getAddress(addr),
        abi: abiForRead,
        functionName: fn.name,
        args: collected.args as never,
      });
      setFetchResult(
        JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      );
      setArgErrors(Array(paramCount).fill(""));
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchLoading(false);
    }
  };

  const runDecode = () => {
    setDecodeError("");
    setDecodeResult("");
    const fn = currentFunction;
    if (!fn) {
      setDecodeError(fnSelect === "custom" ? "Enter a valid function signature" : "Select a function from ABI");
      return;
    }
    const raw = decodeCalldata.trim();
    if (!raw) {
      setDecodeError("Paste calldata hex");
      return;
    }
    const normalized = raw.startsWith("0x") || raw.startsWith("0X") ? raw : `0x${raw}`;
    if (!isHex(normalized)) {
      setDecodeError("Calldata must be hex");
      return;
    }
    const data = normalized as `0x${string}`;
    if (data.length < 10) {
      setDecodeError("Calldata too short (need selector + body)");
      return;
    }
    let expected: string;
    try {
      expected = toFunctionSelector(fn).toLowerCase();
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
      return;
    }
    const actual = data.slice(0, 10).toLowerCase();
    if (actual !== expected) {
      setDecodeError(
        `4-byte selector mismatch: expected ${expected}, got ${actual} (calldata does not match this function)`,
      );
      return;
    }
    try {
      const dec =
        fnSelect === "custom"
          ? decodeFunctionData({ abi: [fn], data })
          : decodeFunctionData({ abi: abi!, data });
      if (dec.functionName !== fn.name) {
        setDecodeError(
          `Decoded function "${dec.functionName}" does not match selected "${fn.name}"`,
        );
        return;
      }
      setDecodeResult(
        JSON.stringify(
          { functionName: dec.functionName, args: dec.args },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
          2,
        ),
      );
    } catch (e) {
      setDecodeError(
        `Decode failed (payload may not match ABI types): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  return (
    <div className="grid min-h-0 w-full flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] gap-2 divide-y divide-border sm:grid-cols-2 sm:grid-rows-1 sm:divide-x sm:divide-y-0">
      <div className="flex min-h-0 flex-col gap-1.5 pb-2 sm:pb-0 sm:pr-2">
        <p className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Contract ABI (JSON)</p>
        <Textarea
          value={abiText}
          onChange={(e) => setAbiText(e.target.value)}
          placeholder='[{"type":"function","name":"transfer",...}]'
          className="min-h-0 flex-1 resize-none font-mono text-xs"
          spellCheck={false}
        />
        {leftError && <Err msg={leftError} />}
        {abi && !leftError && (
          <p className="shrink-0 text-[10px] text-muted-foreground">
            {functions.length} function(s) — selectors in the list →
          </p>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto pt-2 sm:pt-0 sm:pl-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {abiOpMode === "encode" ? "Encode calldata" : "Decode calldata"}
          </p>
          <div className="flex shrink-0 items-center gap-3">
            {abiOpMode === "encode" && (
              <label className="flex cursor-pointer items-center gap-1 select-none">
                <input
                  type="checkbox"
                  checked={fetchEnabled}
                  onChange={(e) => {
                    setFetchEnabled(e.target.checked);
                    setFetchResult("");
                    setFetchError("");
                  }}
                  className="h-3 w-3 accent-primary"
                />
                <span className="text-[11px] text-muted-foreground">Fetch</span>
              </label>
            )}
            <label className="flex cursor-pointer items-center gap-1 select-none">
              <input
                type="checkbox"
                checked={abiOpMode === "decode"}
                onChange={(e) => {
                  const decode = e.target.checked;
                  setAbiOpMode(decode ? "decode" : "encode");
                  setEncoded("");
                  setEncodeError("");
                  setDecodeResult("");
                  setDecodeError("");
                  if (decode) setFetchEnabled(false);
                }}
                className="h-3 w-3 accent-primary"
              />
              <span className="text-[11px] text-muted-foreground">Decode</span>
            </label>
          </div>
        </div>
        <Select
          value={fnSelect}
          onValueChange={(v) => {
            setFnSelect(v);
            setEncoded("");
            setEncodeError("");
            setArgErrors([]);
            setDecodeResult("");
            setDecodeError("");
            setFetchResult("");
            setFetchError("");
          }}
        >
          <SelectTrigger className="h-7 min-w-0 text-xs font-mono [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-1.5 [&>span]:overflow-hidden">
            <SelectValue placeholder="Function" />
          </SelectTrigger>
          <SelectContent className="max-h-[200px]">
            <SelectItem value="custom" className="text-xs font-mono">
              <span className="flex items-center gap-1.5">
                <Code className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
                <span>custom (manual signature)</span>
              </span>
            </SelectItem>
            {functions.map((f, i) => {
              let sel: string;
              try {
                sel = toFunctionSelector(f);
              } catch {
                sel = "0x????????";
              }
              const read = isAbiFunctionRead(f);
              return (
                <SelectItem key={`fn-${i}`} value={`fn-${i}`} className="text-xs font-mono">
                  <span className="flex items-center gap-1.5">
                    {read ? (
                      <Eye className="h-3 w-3 shrink-0 text-emerald-600" aria-hidden />
                    ) : (
                      <PenLine className="h-3 w-3 shrink-0 text-amber-600" aria-hidden />
                    )}
                    <span className="min-w-0 truncate">{formatFunctionLabel(f, sel)}</span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        {fnSelect === "custom" && (
          <Input
            placeholder="transfer(address,uint256)"
            value={customSig}
            onChange={(e) => {
              setCustomSig(e.target.value);
              setEncoded("");
              setEncodeError("");
              setDecodeResult("");
              setDecodeError("");
              setFetchResult("");
              setFetchError("");
            }}
            className="font-mono h-7 text-xs"
          />
        )}

        {abiOpMode === "decode" && (
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground">Calldata (hex)</label>
            <Textarea
              value={decodeCalldata}
              onChange={(e) => {
                setDecodeCalldata(e.target.value);
                setDecodeResult("");
                setDecodeError("");
              }}
              placeholder="0x…"
              className="min-h-[56px] max-h-[120px] resize-y font-mono text-xs"
              spellCheck={false}
            />
            <Button size="sm" className="h-7 px-2 text-xs w-fit" onClick={runDecode}>
              Decode
            </Button>
            {decodeError && <Err msg={decodeError} />}
            {decodeResult && (
              <pre className="max-h-[140px] overflow-auto rounded bg-muted px-2 py-1 font-mono text-xs select-all whitespace-pre-wrap break-all">
                {decodeResult}
              </pre>
            )}
          </div>
        )}

        {abiOpMode === "encode" && (
          <>
            {params.length === 0 && currentFunction && (
              <p className="text-[10px] text-muted-foreground">No parameters</p>
            )}

            {params.map((p, i) => (
              <div key={`${p.name ?? "arg"}-${i}-${p.type}`} className="space-y-0.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <label
                    className="shrink-0 max-w-[42%] text-[10px] font-mono text-muted-foreground sm:max-w-[40%]"
                    title={`${p.name || `arg${i}`}: ${p.type}`}
                  >
                    <span className="text-foreground/90">{p.name || `arg${i}`}</span>
                    <span className="text-muted-foreground">: {p.type}</span>
                  </label>
                  <Input
                    value={argValues[i] ?? ""}
                    onChange={(e) => setArgAt(i, e.target.value)}
                    placeholder={
                      p.type === "tuple" || p.type.startsWith("tuple(") || (p.type.includes("[") && p.type.includes("]"))
                        ? 'JSON e.g. ["0x...", 1]'
                        : p.type === "address"
                          ? "0x…"
                          : p.type === "bool"
                            ? "true / false"
                            : p.type === "string"
                              ? "text"
                              : p.type.startsWith("uint") || p.type.startsWith("int")
                                ? "decimal or 0x…"
                                : p.type.startsWith("bytes")
                                  ? "0x…"
                                  : "value"
                    }
                    className={`min-w-0 flex-1 font-mono h-7 text-xs ${argErrors[i] ? "border-amber-500" : ""}`}
                  />
                </div>
                {argErrors[i] && <p className="text-[10px] leading-tight text-amber-500">{argErrors[i]}</p>}
              </div>
            ))}

            {fetchEnabled && (
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">Contract address</label>
                <Input
                  placeholder="0x…"
                  value={fetchAddress}
                  onChange={(e) => {
                    setFetchAddress(e.target.value);
                    setFetchResult("");
                    setFetchError("");
                  }}
                  className="font-mono h-7 text-xs"
                />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" className="h-7 px-2 text-xs w-fit" onClick={runEncode}>
                Encode
              </Button>
              {fetchEnabled && (
                <Button
                  size="sm"
                  className="h-7 px-2 text-xs w-fit"
                  onClick={() => void runFetch()}
                  disabled={fetchLoading}
                >
                  {fetchLoading ? "…" : "Fetch"}
                </Button>
              )}
            </div>
            {fetchError && <Err msg={fetchError} />}
            {fetchResult && (
              <pre className="max-h-[120px] overflow-auto rounded bg-muted px-2 py-1 font-mono text-xs select-all whitespace-pre-wrap break-all">
                {fetchResult}
              </pre>
            )}
            {encodeError && <Err msg={encodeError} />}
            {encoded && (
              <div className="space-y-0.5">
                <span className="text-[10px] text-muted-foreground">Calldata</span>
                <div className="flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <ResultBox value={encoded} />
                  </div>
                  <button
                    type="button"
                    title="Copy calldata"
                    className="mt-0.5 inline-flex shrink-0 border-0 bg-transparent p-0 text-muted-foreground shadow-none outline-none ring-0 transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => {
                      void navigator.clipboard.writeText(encoded);
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                    <span className="sr-only">Copy calldata</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function normalizeStorageSlotHex(raw: string): `0x${string}` | null {
  const s = raw.trim().replace(/^0x/i, "");
  if (!s || !/^[0-9a-fA-F]+$/.test(s)) return null;
  if (s.length > 64) return null;
  return `0x${s.padStart(64, "0").toLowerCase()}` as `0x${string}`;
}

function SlotTool() {
  const [kind, setKind] = useState<"plain" | "mapping" | "array">("mapping");
  const [baseSlot, setBaseSlot] = useState("0");
  const [mapKey, setMapKey] = useState("");
  const [arrIdx, setArrIdx] = useState("0");
  const [computedSlot, setComputedSlot] = useState("");
  const [calcError, setCalcError] = useState("");

  const [address, setAddress] = useState("");
  const [readSlot, setReadSlot] = useState("");
  const [fetchResult, setFetchResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");

  const computeSlot = (): string | null => {
    try {
      const slotN = parseNumber(baseSlot);
      if (slotN === null) { setCalcError("Invalid base slot"); return null; }
      const slotPadded = pad(`0x${slotN.toString(16)}` as `0x${string}`, { size: 32 });
      if (kind === "plain") return `0x${slotN.toString(16).padStart(64, "0")}`;
      if (kind === "mapping") {
        const k = mapKey.trim(); if (!k) { setCalcError("Key required"); return null; }
        const keyPadded = isAddress(k)
          ? pad(k as `0x${string}`, { size: 32 })
          : (() => { const kn = parseNumber(k); if (kn === null) throw new Error("Invalid key"); return pad(`0x${kn.toString(16)}` as `0x${string}`, { size: 32 }); })();
        return keccak256(concat([keyPadded, slotPadded]));
      }
      if (kind === "array") {
        const base = BigInt(keccak256(slotPadded));
        const idxN = parseNumber(arrIdx); if (idxN === null) { setCalcError("Invalid index"); return null; }
        return `0x${(base + idxN).toString(16).padStart(64, "0")}`;
      }
      return null;
    } catch (e) { setCalcError(e instanceof Error ? e.message : String(e)); return null; }
  };

  const handleCalc = () => {
    setCalcError(""); setComputedSlot("");
    const s = computeSlot(); if (s) setComputedSlot(s);
  };

  const applyComputedToRead = () => {
    if (computedSlot) setReadSlot(computedSlot);
  };

  const handleFetch = async () => {
    setReadError(""); setFetchResult("");
    const addr = address.trim();
    if (!addr || !isAddress(addr)) { setReadError("Valid contract address required"); return; }
    const slotNorm = normalizeStorageSlotHex(readSlot);
    if (!slotNorm) { setReadError("Enter storage slot (hex, ≤32 bytes)"); return; }
    setLoading(true);
    try {
      const client = createPublicClient({ transport: http(getSelectedRpc()) });
      const value = await client.getStorageAt({ address: addr as `0x${string}`, slot: slotNorm });
      setFetchResult(value ?? "0x" + "0".repeat(64));
    } catch (e) { setReadError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 min-h-0 divide-y sm:divide-y-0 sm:divide-x divide-border">
      {/* Left: dynamic slot (mapping / array / plain) */}
      <div className="space-y-1.5 min-w-0 pb-2 sm:pb-0 sm:pr-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Slot calculator</p>
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5 flex-wrap items-center">
            <Select value={kind} onValueChange={(v) => { setKind(v as typeof kind); setComputedSlot(""); setCalcError(""); }}>
              <SelectTrigger className="h-7 text-xs w-24 font-mono shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mapping" className="text-xs font-mono">mapping</SelectItem>
                <SelectItem value="array" className="text-xs font-mono">array</SelectItem>
                <SelectItem value="plain" className="text-xs font-mono">plain</SelectItem>
              </SelectContent>
            </Select>
            <Input placeholder="Base slot (0 or 0x0)" value={baseSlot}
              onChange={(e) => { setBaseSlot(e.target.value); setComputedSlot(""); setCalcError(""); }}
              className="font-mono h-7 text-xs flex-1 min-w-[100px]" />
          </div>
          {kind === "mapping" && (
            <Input placeholder="Key (address or uint)" value={mapKey}
              onChange={(e) => { setMapKey(e.target.value); setComputedSlot(""); setCalcError(""); }}
              className="font-mono h-7 text-xs w-full" />
          )}
          {kind === "array" && (
            <Input placeholder="Element index" value={arrIdx}
              onChange={(e) => { setArrIdx(e.target.value); setComputedSlot(""); setCalcError(""); }}
              className="font-mono h-7 text-xs w-full max-w-[200px]" />
          )}
          <Button size="sm" className="h-7 px-2 text-xs w-fit" onClick={handleCalc}>Calculate</Button>
        </div>
        {calcError && <Err msg={calcError} />}
        {computedSlot && (
          <div className="space-y-0.5">
            <span className="text-[10px] text-muted-foreground">Computed slot</span>
            <ResultBox value={computedSlot} />
          </div>
        )}
      </div>

      {/* Right: eth_getStorageAt by address + slot */}
      <div className="space-y-1.5 min-w-0 pt-2 sm:pt-0 sm:pl-2">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Read storage</p>
        <Input placeholder="Contract address" value={address}
          onChange={(e) => { setAddress(e.target.value); setFetchResult(""); setReadError(""); }}
          className="font-mono h-7 text-xs w-full" />
        <div className="flex gap-1.5 items-center">
          <Input placeholder="Slot (hex key, e.g. 0x…)" value={readSlot}
            onChange={(e) => { setReadSlot(e.target.value); setFetchResult(""); setReadError(""); }}
            className="font-mono h-7 text-xs flex-1 min-w-0"
            onKeyDown={(e) => e.key === "Enter" && handleFetch()} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px] shrink-0"
            title="Fill slot from left calculator"
            onClick={applyComputedToRead}
            disabled={!computedSlot}
          >
            ← calc
          </Button>
          <Button size="sm" className="h-7 px-2 text-xs shrink-0" onClick={handleFetch} disabled={loading}>
            {loading ? "..." : "Read"}
          </Button>
        </div>
        {readError && <Err msg={readError} />}
        {fetchResult && (
          <div className="space-y-0.5">
            <span className="text-[10px] text-muted-foreground">Value</span>
            <ResultBox value={fetchResult} />
          </div>
        )}
      </div>
    </div>
  );
}

function TimestampTool() {
  const [tsInput, setTsInput] = useState("");
  const [tz, setTz] = useState<"local" | "utc">("local");
  const [blockInput, setBlockInput] = useState("");
  const [blockTs, setBlockTs] = useState<number | null>(null);
  const [blockLoading, setBlockLoading] = useState(false);
  const [blockError, setBlockError] = useState("");

  const ts = tsInput.trim() ? Number(tsInput.trim()) : null;
  const tsDate = ts !== null && !isNaN(ts) ? new Date(ts * 1000) : null;

  const fmtDate = (d: Date) => tz === "utc"
    ? [d.toISOString(), d.toUTCString()]
    : [d.toISOString(), d.toLocaleString()];

  const fmtBlockResult = (t: number) => {
    const d = new Date(t * 1000);
    const [iso, human] = fmtDate(d);
    return `${t}  ·  ${iso}  ·  ${human}`;
  };

  const fetchBlock = async () => {
    setBlockError(""); setBlockTs(null);
    const b = blockInput.trim(); if (!b) return;
    setBlockLoading(true);
    try {
      const client = createPublicClient({ transport: http(getSelectedRpc()) });
      const block = await client.getBlock(b === "latest" ? {} : { blockNumber: BigInt(b) });
      setBlockTs(Number(block.timestamp));
    } catch (e) { setBlockError(e instanceof Error ? e.message : String(e)); }
    finally { setBlockLoading(false); }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5 items-center">
        <Input placeholder="Unix timestamp" value={tsInput}
          onChange={(e) => setTsInput(e.target.value)} className="font-mono h-7 text-xs flex-1" />
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs shrink-0"
          onClick={() => setTsInput(String(Math.floor(Date.now() / 1000)))}>Now</Button>
        <Select value={tz} onValueChange={(v) => setTz(v as "local" | "utc")}>
          <SelectTrigger className="h-7 text-xs w-20 font-mono shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local" className="text-xs font-mono">Local</SelectItem>
            <SelectItem value="utc"   className="text-xs font-mono">UTC</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {tsDate && (
        <div className="space-y-0.5">
          {fmtDate(tsDate).map((v, i) => <ResultBox key={i} value={v} />)}
        </div>
      )}
      <div className="flex gap-1.5 items-center border-t pt-1.5">
        <Input placeholder="Block number or 'latest'" value={blockInput}
          onChange={(e) => { setBlockInput(e.target.value); setBlockTs(null); setBlockError(""); }}
          className="font-mono h-7 text-xs flex-1"
          onKeyDown={(e) => e.key === "Enter" && fetchBlock()} />
        <Button size="sm" className="h-7 px-2 text-xs shrink-0" onClick={fetchBlock} disabled={blockLoading}>
          {blockLoading ? "..." : "Fetch"}
        </Button>
      </div>
      {blockError && <Err msg={blockError} />}
      {blockTs !== null && <ResultBox value={fmtBlockResult(blockTs)} />}
    </div>
  );
}

export function UtilitiesDrawer() {
  const isOpen = useDebugStore((s) => s.isUtilitiesOpen);
  const [activeTool, setActiveTool] = useState<Tool>("conv");
  const [pinned, setPinned] = useState(false);
  const { closeUtilities: close } = useDrawerActions();

  return (
    <BottomSheetShell
      open={isOpen}
      onOpenChange={(o) => { if (!o && !pinned) close(); }}
      sheetTitle="Utilities"
      defaultHeightPx={320}
      minHeightPx={200}
      contentForceMount
    >
        {/* Header + tabs — 与 Call Tree / Event Logs 同一套尺寸（11px、h-5 控件、h-3 图标） */}
        <div className="flex flex-nowrap items-center gap-x-1.5 border-b border-border bg-muted/60 px-2 py-1 text-[11px] shrink-0">
          <div className="flex shrink-0 items-center gap-1.5">
            <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 font-semibold tracking-wide text-foreground">Utilities</span>
          </div>
          <div className="flex min-h-5 min-w-0 flex-1 items-center gap-1 overflow-x-auto px-0.5 py-px scrollbar-hidden">
            {TOOLS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTool(id)}
                className={`inline-flex h-5 shrink-0 items-center justify-center rounded px-2 text-[11px] font-medium leading-tight transition-colors ${
                  activeTool === id
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex shrink-0 items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={`h-5 w-5 shrink-0 rounded-md p-0 [&_svg]:size-3 ${pinned ? "text-primary" : "text-muted-foreground"}`}
              title={pinned ? "Unpin drawer" : "Pin drawer (ignore click-outside close)"}
              onClick={() => setPinned((p) => !p)}
            >
              {pinned ? <Pin /> : <PinOff />}
            </Button>
            <SheetClose className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm p-0 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary">
              <X className="h-3 w-3" />
              <span className="sr-only">Close</span>
            </SheetClose>
          </div>
        </div>
        {/* Content */}
        {activeTool === "conv" ? (
          <div className="flex-1 grid grid-cols-3 divide-x overflow-hidden">
            <div className="overflow-auto px-3 pt-1.5 pb-2"><BaseConvTool /></div>
            <div className="overflow-auto px-3 pt-1.5 pb-2"><GweiTool /></div>
            <div className="overflow-auto px-3 pt-1.5 pb-2"><TimestampTool /></div>
          </div>
        ) : activeTool === "abi" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pt-1.5 pb-2">
            <AbiTool />
          </div>
        ) : (
          <div className="flex-1 overflow-auto px-3 pt-1.5 pb-2">
            {activeTool === "hash4byte" && <KeccakFourByteTool />}
            {activeTool === "checksum"   && <ChecksumTool />}
            {activeTool === "slot"       && <SlotTool />}
          </div>
        )}
    </BottomSheetShell>
  );
}
