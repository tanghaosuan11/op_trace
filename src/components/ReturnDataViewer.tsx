import { useState } from "react";
import { Card } from "@/components/ui/card";
import { RefreshCw } from "lucide-react";
import { useDebugStore } from "@/store/debugStore";

export function ReturnDataViewer() {
  const data = useDebugStore((s) => s.returnData);
  const error = useDebugStore((s) => s.returnError);
  const [splitMode, setSplitMode] = useState(false);

  const hex = data.startsWith("0x") ? data.slice(2) : data;

  const getSplitLines = (): string[] => {
    const lines: string[] = [];
    for (let i = 0; i < hex.length; i += 64) {
      lines.push(hex.slice(i, i + 64).padEnd(64, "0"));
    }
    return lines;
  };

  return (
    <Card className="h-full flex flex-col">
      <div className="text-xs font-semibold px-2 py-1 border-b bg-muted/50 flex items-center justify-between">
        <span>Return Data</span>
        {data && !error && (
          <button
            className="h-5 w-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setSplitMode((v) => !v)}
            title={splitMode ? "Switch to raw" : "Switch to split 32"}
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto text-[11px] font-mono p-2 scrollbar-hidden">
        {error ? (
          <div className="text-red-500">
            <div className="font-semibold mb-2">Error:</div>
            <div className="text-[11px] break-all">{error}</div>
          </div>
        ) : data ? (
          splitMode ? (
            <div className="space-y-0.5">
              {getSplitLines().map((line, i) => (
                <div key={i} className="text-[11px] break-all">
                  {line}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] break-all text-muted-foreground">
              {data.startsWith("0x") ? data : "0x" + data}
            </div>
          )
        ) : (
          <div className="text-center text-muted-foreground p-4">
            No return data
          </div>
        )}
      </div>
    </Card>
  );
}
