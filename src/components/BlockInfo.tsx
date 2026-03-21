import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

interface BlockInfoProps {
  blockNumber?: bigint;
  timestamp?: bigint;
  gasLimit?: bigint;
  baseFeePerGas?: bigint;
  isLoading?: boolean;
  readOnly?: boolean;
  onFieldChange?: (field: string, value: string) => void;
}

export function BlockInfo({
  blockNumber,
  timestamp,
  gasLimit,
  baseFeePerGas,
  isLoading,
  readOnly,
  onFieldChange,
}: BlockInfoProps) {
  if (isLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading block...</span>
        </div>
      </Card>
    );
  }

  if (blockNumber === undefined) {
    return (
      <Card className="p-6">
        <div className="text-center text-muted-foreground text-sm">
          Block info will appear here
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-3">
      <div className="space-y-2">
        <h3 className="font-semibold text-sm mb-1">Block</h3>

        {blockNumber !== undefined && (
          <div className="flex gap-2 items-center">
            <Label className="text-xs text-muted-foreground w-16 flex-shrink-0">Number</Label>
            <Input
              value={blockNumber.toString()}
              onChange={(e) => onFieldChange?.("blockNumber", e.target.value)}
              readOnly={readOnly}
              className="font-mono text-xs h-7 flex-1"
            />
          </div>
        )}

        {timestamp !== undefined && (
          <div className="flex gap-2 items-center">
            <Label className="text-xs text-muted-foreground w-16 flex-shrink-0">Time</Label>
            <Input
              value={new Date(Number(timestamp) * 1000).toLocaleString()}
              onChange={(e) => onFieldChange?.("timestamp", e.target.value)}
              readOnly={readOnly}
              className="font-mono text-xs h-7 flex-1"
            />
          </div>
        )}

        {gasLimit !== undefined && (
          <div className="flex gap-2 items-center">
            <Label className="text-xs text-muted-foreground w-16 flex-shrink-0">GasLimit</Label>
            <Input
              value={gasLimit.toString()}
              onChange={(e) => onFieldChange?.("gasLimit", e.target.value)}
              readOnly={readOnly}
              className="font-mono text-xs h-7 flex-1"
            />
          </div>
        )}

        {baseFeePerGas !== undefined && (
          <div className="flex gap-2 items-center">
            <Label className="text-xs text-muted-foreground w-16 flex-shrink-0">BaseFee</Label>
            <Input
              value={(Number(baseFeePerGas) / 1e9).toFixed(2)}
              onChange={(e) => onFieldChange?.("baseFeePerGas", e.target.value)}
              readOnly={readOnly}
              className="font-mono text-xs h-7 flex-1"
            />
            <span className="text-[10px] text-muted-foreground flex-shrink-0">Gwei</span>
          </div>
        )}
      </div>
    </Card>
  );
}
