import { useDebugStore } from "@/store/debugStore";
import { Card } from "@/components/ui/card";
import { ExternalLink } from "lucide-react";

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

/** 将带符号的 wei 字符串 (+xxx / -xxx) 转为 ETH，保留 8 位小数 */
function weiToEth(wei: string): string {
  const sign = wei.startsWith("+") ? "+" : "-";
  const abs = BigInt(wei.replace(/^[+-]/, ""));
  const whole = abs / BigInt("1000000000000000000");
  const frac = abs % BigInt("1000000000000000000");
  const fracStr = frac.toString().padStart(18, "0").slice(0, 8).replace(/0+$/, "") || "0";
  return `${sign}${whole}.${fracStr}`;
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

  if (changes.length === 0) {
    return (
      <Card className="h-full flex items-center justify-center">
        <div className="text-sm text-muted-foreground">暂无余额变化</div>
      </Card>
    );
  }

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <div className="text-xs font-semibold px-3 py-1.5 border-b bg-muted/50 flex-shrink-0">
        Balance Changes ({changes.length} addresses)
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
                      {entry.tokens.map((t, j) => (
                        <div key={j} className="flex items-start gap-2">
                          <AddrLink address={t.contract} scanUrl={scanUrl} />
                          <DeltaBadge delta={t.delta} />
                        </div>
                      ))}
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
