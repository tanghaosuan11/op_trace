import { useState } from "react";
import { useDebugStore } from "@/store/debugStore";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExternalLink, RefreshCw } from "lucide-react";
import { createPublicClient, http } from "viem";
import { getBackendConfig } from "@/lib/appConfig";

async function openScanAddress(scanUrl: string, address: string) {
  try {
    const base = scanUrl.replace(/\/$/, "");
    const url = `${base}/address/${address}`;
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(`${scanUrl.replace(/\/$/, "")}/address/${address}`, "_blank", "noopener");
  }
}

function addCommas(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 将带符号的 wei 字符串 (+xxx / -xxx) 转为 ETH，保留 8 位小数 */
function weiToEth(wei: string): string {
  const sign = wei.startsWith("+") ? "+" : "-";
  const abs = BigInt(wei.replace(/^[+-]/, ""));
  const whole = abs / BigInt("1000000000000000000");
  const frac = abs % BigInt("1000000000000000000");
  const fracStr = frac.toString().padStart(18, "0").slice(0, 8).replace(/0+$/, "") || "0";
  return `${sign}${addCommas(whole)}.${fracStr}`;
}

/** 将带符号的 raw 整数字符串按 decimals 转为人类可读数字，保留 8 位小数 */
function applyDecimals(raw: string, decimals: number): string {
  const sign = raw.startsWith("+") ? "+" : "-";
  const abs = BigInt(raw.replace(/^[+-]/, ""));
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = decimals > 0
    ? frac.toString().padStart(decimals, "0").slice(0, 8).replace(/0+$/, "") || "0"
    : "0";
  return `${sign}${addCommas(whole)}.${fracStr}`;
}

interface TokenInfo {
  symbol: string;
  decimals: number;
}

const ERC20_ABI = [
  { name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { name: "symbol", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
] as const;

async function fetchTokenInfoBatch(
  contracts: string[],
  rpcUrl: string,
): Promise<Record<string, TokenInfo>> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const results: Record<string, TokenInfo> = {};
  await Promise.all(
    contracts.map(async (addr) => {
      try {
        const [decimals, symbol] = await Promise.all([
          client.readContract({ address: addr as `0x${string}`, abi: ERC20_ABI, functionName: "decimals" }),
          client.readContract({ address: addr as `0x${string}`, abi: ERC20_ABI, functionName: "symbol" }),
        ]);
        results[addr.toLowerCase()] = { symbol: symbol as string, decimals: Number(decimals) };
      } catch {
        // ignore contracts that don't implement ERC20 metadata
      }
    }),
  );
  return results;
}

function DeltaBadge({ delta }: { delta: string }) {
  const positive = delta.startsWith("+");
  return (
    <span className={`font-mono text-[11px] ${positive ? "text-green-400" : "text-red-400"}`}>
      {delta}
    </span>
  );
}

function AddrLink({ address, scanUrl }: { address: string; scanUrl: string }) {
  const canOpen = !!scanUrl;
  return (
    <span
      className={`font-mono text-[10px] break-all ${canOpen ? "cursor-pointer hover:text-blue-400 hover:underline" : ""} inline-flex items-start gap-0.5`}
      onClick={canOpen ? () => openScanAddress(scanUrl, address) : undefined}
    >
      {address}
      {canOpen && <ExternalLink className="h-2.5 w-2.5 mt-0.5 flex-shrink-0 opacity-50" />}
    </span>
  );
}

export function BalanceChangesViewer() {
  const changes = useDebugStore((s) => s.balanceChanges);
  const scanUrl = useDebugStore((s) => s.config.scanUrl);
  const [tokenInfoMap, setTokenInfoMap] = useState<Record<string, TokenInfo>>({});
  const [fetching, setFetching] = useState(false);

  const handleFetchTokenInfo = async () => {
    const { rpcUrl } = getBackendConfig();
    if (!rpcUrl) return;
    const all = [...new Set(changes.flatMap((c) => c.tokens.map((t) => t.contract)))];
    if (all.length === 0) return;
    setFetching(true);
    try {
      const info = await fetchTokenInfoBatch(all, rpcUrl);
      setTokenInfoMap(info);
    } finally {
      setFetching(false);
    }
  };

  if (changes.length === 0) {
    return (
      <Card className="h-full flex items-center justify-center">
        <div className="text-sm text-muted-foreground">暂无余额变化</div>
      </Card>
    );
  }

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <div className="text-xs font-semibold px-3 py-1.5 border-b bg-muted/50 flex-shrink-0 flex items-center justify-between gap-2">
        <span>Balance Changes ({changes.length} addresses)</span>
        <span className="text-[10px] font-normal text-muted-foreground/60 italic flex-1 text-center">
          Duplicate token symbols are common — always verify the contract address
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={handleFetchTokenInfo}
          disabled={fetching}
          className="h-6 px-2 text-[10px] gap-1"
        >
          <RefreshCw className={`h-3 w-3 ${fetching ? "animate-spin" : ""}`} />
          {fetching ? "Fetching…" : "Fetch Token Info"}
        </Button>
      </div>
      <div className="flex-1 overflow-auto scrollbar-hidden">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-background border-b z-10">
            <tr>
              <th className="text-left font-medium text-muted-foreground px-3 py-1.5">Address</th>
              <th className="text-left font-medium text-muted-foreground px-3 py-1.5 w-[180px]">ETH</th>
              <th className="text-left font-medium text-muted-foreground px-3 py-1.5">Token Changes</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((entry, i) => (
              <tr key={i} className="border-b hover:bg-muted/30 align-top">
                {/* Address */}
                <td className="px-3 py-1.5">
                  <AddrLink address={entry.address} scanUrl={scanUrl} />
                </td>

                {/* ETH — wei 转 ETH 保留 8 位小数 */}
                <td className="px-3 py-1.5">
                  {entry.eth ? <DeltaBadge delta={weiToEth(entry.eth)} /> : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>

                {/* Tokens */}
                <td className="px-3 py-1.5">
                  {entry.tokens.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {entry.tokens.map((t, j) => {
                        const info = tokenInfoMap[t.contract.toLowerCase()];
                        const displayDelta = info
                          ? applyDecimals(t.delta, info.decimals)
                          : t.delta;
                        return (
                          <div key={j} className="flex items-start gap-2 flex-wrap">
                            <AddrLink address={t.contract} scanUrl={scanUrl} />
                            {info && (
                              <span className="text-[10px] text-muted-foreground font-mono bg-muted/60 px-1 rounded">
                                {info.symbol}
                              </span>
                            )}
                            <DeltaBadge delta={displayDelta} />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
