import { Card } from "@/components/ui/card";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { useDebugStore } from "@/store/debugStore";

export function StateDiffViewer() {
  const diffs = useDebugStore((s) => s.stateDiffs);
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: diffs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 5,
  });

  return (
    <Card className="h-full flex flex-col">
      <div className="text-xs font-semibold px-2 py-1 border-b bg-muted/50">
        State Diff ({diffs.length})
      </div>
      <div ref={parentRef} className="flex-1 overflow-auto text-[11px] scrollbar-hidden">
        {diffs.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground">
            暂无状态变更
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const diff = diffs[virtualRow.index];
              return (
                <div
                  key={virtualRow.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="px-2 py-1 border-b hover:bg-muted/50"
                >
                  <div className="text-[11px] font-mono">
                    <div className="text-muted-foreground truncate mb-1">
                      {diff.address} / {diff.key}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-red-500 truncate flex-1">
                        - {diff.oldValue}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-green-500 truncate flex-1">
                        + {diff.newValue}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
