import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  debugShadowSteps,
  exportAllShadowSteps,
  validateShadowSteps,
  type ShadowValidationReport,
} from "@/lib/shadowDiagnostics";
import { toast } from "sonner";
import { useDebugStore } from "@/store/debugStore";

interface ShadowDiagnosticsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShadowDiagnosticsDialog({
  open,
  onOpenChange,
}: ShadowDiagnosticsDialogProps) {
  const sessionId = useDebugStore((s) => s.sessionId);
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("100");
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<ShadowValidationReport | null>(null);

  const handleQuery = async () => {
    try {
      setLoading(true);
      const startNum = parseInt(start);
      const endNum = parseInt(end);

      if (isNaN(startNum) || isNaN(endNum)) {
        console.error("Invalid input: start and end must be numbers");
        return;
      }

      if (startNum >= endNum) {
        console.error("Invalid input: start must be less than end");
        return;
      }

      console.log(`📊 Querying shadow steps ${startNum}..${endNum}`);
      

      // 再显示详细信息
      await debugShadowSteps(startNum, endNum, sessionId);
      
      console.log("\n✅ Shadow diagnostics completed. Check the console above.");
    } catch (error) {
      console.error("Error querying shadow steps:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleExportAll = async () => {
    try {
      setLoading(true);
      toast.message("Export started. Large sessions may take some time.");
      console.log("📁 Exporting all shadow steps to file...");
      const filePath = await exportAllShadowSteps(sessionId);
      toast.success(`Export completed: ${filePath}`);
      console.log(`✅ Export completed! File saved to: ${filePath}`);
    } catch (error) {
      console.error("Error exporting shadow steps:", error);
      toast.error("Export failed");
    } finally {
      setLoading(false);
    }
  };

  const handleValidate = async () => {
    try {
      setLoading(true);
      const result = await validateShadowSteps(300, sessionId);
      setReport(result);
      if (result.mismatch_count === 0) {
        toast.success(
          `Shadow validation passed (${result.checked_steps.toLocaleString()} steps, ${result.checked_slots.toLocaleString()} slots)`
        );
      } else {
        toast.error(
          `Shadow validation found ${result.mismatch_count.toLocaleString()} mismatches (showing ${result.mismatches.length})`
        );
      }
    } catch (error) {
      console.error("Error validating shadow steps:", error);
      toast.error("Shadow validation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Shadow Stack Diagnostics</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="start">Start Step</Label>
            <Input
              id="start"
              type="number"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder="0"
              min="0"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="end">End Step</Label>
            <Input
              id="end"
              type="number"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              placeholder="100"
              min="0"
            />
          </div>

          <div className="text-xs text-muted-foreground bg-muted p-2 rounded">
            <p>
              Queries shadow stack information for the specified step range.
            </p>
            <p className="mt-1">Results are printed to the browser console.</p>
          </div>

          {report && (
            <div className="text-xs border rounded p-2 space-y-2 max-h-44 overflow-auto">
              <div className="font-medium">
                Checked {report.checked_steps.toLocaleString()} steps /{" "}
                {report.checked_slots.toLocaleString()} slots, mismatches:{" "}
                {report.mismatch_count.toLocaleString()}
              </div>
              {report.mismatches.slice(0, 20).map((m, idx) => {
                const scope =
                  m.transaction_id != null
                    ? `tx ${m.transaction_id + 1} frame ${m.frame_id ?? "-"}`
                    : `frame ${m.frame_id ?? "-"}`;
                return (
                  <div key={`${m.step}-${m.stack_index}-${idx}`} className="font-mono text-[11px]">
                    step {m.step} {scope} idx {m.stack_index} nid {m.shadow_id} {m.reason}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 flex flex-col sm:flex-row sm:justify-between sm:items-center">
          <Button
            variant="outline"
            onClick={handleExportAll}
            disabled={loading}
            className="w-full sm:w-auto"
          >
            {loading ? "Exporting..." : "📁 Export All"}
          </Button>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            <Button
              variant="outline"
              onClick={handleValidate}
              disabled={loading}
              className="flex-1 sm:flex-none"
            >
              {loading ? "Validating..." : "Validate Shadow"}
            </Button>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
              className="flex-1 sm:flex-none"
            >
              Cancel
            </Button>
            <Button onClick={handleQuery} disabled={loading} className="flex-1 sm:flex-none">
              {loading ? "Querying..." : "Query"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
