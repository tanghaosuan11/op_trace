import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";

interface TxInfoProps {
  txHash?: string;
  from?: string;
  to?: string;
  value?: bigint;
  gasPrice?: bigint;
  gasLimit?: bigint;
  gasUsed?: bigint;
  data?: string;
  status?: "success" | "reverted";
  isLoading?: boolean;
  error?: string;
  readOnly?: boolean;
  onFieldChange?: (field: string, value: string) => void;
}

export function TxInfo({
  txHash,
  from,
  to,
  value,
  gasPrice,
  gasLimit,
  gasUsed,
  data,
  status,
  isLoading,
  error,
  readOnly,
  onFieldChange,
}: TxInfoProps) {
  if (isLoading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading transaction...</span>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-6">
        <div className="flex items-start gap-2 text-destructive">
          <XCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Error</div>
            <div className="text-sm">{error}</div>
          </div>
        </div>
      </Card>
    );
  }

  if (!txHash) {
    return (
      <Card className="p-6">
        <div className="text-center text-muted-foreground text-sm">
          Enter a transaction hash to view details
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="font-semibold text-sm flex-shrink-0">Transaction</h3>
          {status && (
            <Badge
              variant={status === "success" ? "default" : "destructive"}
              className="flex items-center gap-1 h-5"
            >
              {status === "success" ? (
                <>
                  <CheckCircle2 className="h-3 w-3" />
                  Success
                </>
              ) : (
                <>
                  <XCircle className="h-3 w-3" />
                  Reverted
                </>
              )}
            </Badge>
          )}
        </div>

        <div className="flex gap-2 items-center">
          <Label className="text-xs text-muted-foreground w-14 flex-shrink-0">TxHash</Label>
          <div className="font-mono text-xs text-muted-foreground truncate flex-1 select-all">{txHash}</div>
        </div>

        {from && (
          <div className="flex gap-2 items-center">
            <Label className="text-xs text-muted-foreground w-14 flex-shrink-0">From</Label>
            <Input
              value={from}
              onChange={(e) => onFieldChange?.("from", e.target.value)}
              readOnly={readOnly}
              className="font-mono text-xs h-7 flex-1"
            />
          </div>
        )}

        {to && (
          <div className="flex gap-2 items-center">
            <Label className="text-xs text-muted-foreground w-14 flex-shrink-0">To</Label>
            <Input
              value={to}
              onChange={(e) => onFieldChange?.("to", e.target.value)}
              readOnly={readOnly}
              className="font-mono text-xs h-7 flex-1"
            />
          </div>
        )}

        {value !== undefined && (
          <div className="flex gap-2 items-center">
            <Label className="text-xs text-muted-foreground w-14 flex-shrink-0">Value</Label>
            <Input
              value={(Number(value) / 1e18).toFixed(6)}
              onChange={(e) => onFieldChange?.("value", e.target.value)}
              readOnly={readOnly}
              className="font-mono text-xs h-7 flex-1"
            />
            <span className="text-[10px] text-muted-foreground flex-shrink-0">ETH</span>
          </div>
        )}

        {gasPrice !== undefined && (
          <div className="flex gap-2 items-center">
            <Label className="text-xs text-muted-foreground w-14 flex-shrink-0">GasPrice</Label>
            <Input
              value={(Number(gasPrice) / 1e9).toFixed(2)}
              onChange={(e) => onFieldChange?.("gasPrice", e.target.value)}
              readOnly={readOnly}
              className="font-mono text-xs h-7 flex-1"
            />
            <span className="text-[10px] text-muted-foreground flex-shrink-0">Gwei</span>
          </div>
        )}

        {(gasLimit !== undefined || gasUsed !== undefined) && (
          <div className="flex gap-2 items-center">
            {gasUsed !== undefined && (
              <>
                <Label className="text-xs text-muted-foreground w-14 flex-shrink-0">GasUsed</Label>
                <div className="font-mono text-xs h-7 flex items-center px-3 rounded-md border bg-muted text-muted-foreground flex-1">
                  {gasUsed.toLocaleString()}
                </div>
              </>
            )}
            {gasLimit !== undefined && (
              <>
                <Label className="text-xs text-muted-foreground w-16 flex-shrink-0 text-right">GasLimit</Label>
                <Input
                  value={gasLimit.toString()}
                  onChange={(e) => onFieldChange?.("gasLimit", e.target.value)}
                  readOnly={readOnly}
                  className="font-mono text-xs h-7 flex-1"
                />
              </>
            )}
          </div>
        )}

        {data && (
          <div className="flex gap-2">
            <Label className="text-xs text-muted-foreground w-14 flex-shrink-0 pt-2">Data</Label>
            <Textarea
              value={data}
              onChange={(e) => onFieldChange?.("data", e.target.value)}
              readOnly={readOnly}
              className="font-mono text-xs resize-y min-h-[60px] flex-1"
              rows={10}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
