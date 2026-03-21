import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Crosshair } from "lucide-react";
import { toast } from "sonner";
import type { MemoryAccessParam } from "@/lib/opcodes";
import { useDebugStore } from "@/store/debugStore";
import { PanelContextMenu, PanelContextMenuContent, PanelContextMenuItem,
  PanelContextMenuTrigger,
} from "@/components/ui/panel-context-menu";
// import { addValueRecordFromStack } from "@/components/NotesDrawer";

type StackMemoryItem = (MemoryAccessParam & { resolvedOffset: number; resolvedEnd: number }) | null;

interface StackViewerProps {
  stackLabels?: string[];
  stackMemoryAccess?: StackMemoryItem[];
  onMemoryHighlight?: (range: { start: number; end: number } | null) => void;
  onSeekTo?: (index: number) => void;
}

const ROW_HEIGHT = 20;

export function StackViewer({ stackLabels = [], stackMemoryAccess = [], onMemoryHighlight, onSeekTo }: StackViewerProps) {
  const stack = useDebugStore((s) => s.stack);
  const currentStepIndex = useDebugStore((s) => s.currentStepIndex);
  const parentRef = useRef<HTMLDivElement>(null);

  // 逆序栈：后进先出，最新的元素在最上面
  const reversedStack = [...stack].reverse();

  const virtualizer = useVirtualizer({
    count: reversedStack.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="py-1 px-3 flex-shrink-0 bg-muted/50 border-b">
        <CardTitle className="text-xs">Stack ({stack.length})</CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex-1 min-h-0">
        {stack.length > 0 ? (
          <div
            ref={parentRef}
            className="h-full overflow-auto border-t scrollbar-hidden"
          >
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                // 计算原始栈的索引（从底部数）
                const originalIndex = stack.length - 1 - virtualRow.index;
                return (
                  <PanelContextMenu key={virtualRow.key}>
                    <PanelContextMenuTrigger asChild>
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    className={`flex items-center px-3 text-[11px] font-mono border-b ${
                      virtualRow.index % 2 === 0 ? "bg-muted/30" : ""
                    }`}
                  >
                    <span className="w-8 text-muted-foreground">{originalIndex}</span>
                    <span className="flex-1 truncate">
                      <span
                        className="rounded-sm px-0.5"
                      >{reversedStack[virtualRow.index]}</span>
                    </span>
                    {stackMemoryAccess[virtualRow.index] && (
                      <span
                        className="ml-1 cursor-pointer text-orange-400 hover:text-orange-300 shrink-0"
                        title={`Highlight memory [${stackMemoryAccess[virtualRow.index]!.resolvedOffset} : ${stackMemoryAccess[virtualRow.index]!.resolvedEnd}]`}
                        onClick={() => {
                          const m = stackMemoryAccess[virtualRow.index]!;
                          onMemoryHighlight?.({ start: m.resolvedOffset, end: m.resolvedEnd });
                        }}
                      >
                        <Crosshair size={10} />
                      </span>
                    )}
                    {stackLabels[virtualRow.index] && (
                      <span className="ml-1 text-[10px] text-blue-400 font-normal shrink-0">
                        {stackLabels[virtualRow.index]}
                      </span>
                    )}
                  </div>
                    </PanelContextMenuTrigger>
                    <PanelContextMenuContent>
                      <PanelContextMenuItem
                        onSelect={() => navigator.clipboard.writeText(reversedStack[virtualRow.index])}
                      >
                        Copy Value
                      </PanelContextMenuItem>
                      <PanelContextMenuItem
                        onSelect={() => {
                          const stripped = reversedStack[virtualRow.index].replace(/^0x/i, "").replace(/^0+/, "") || "0";
                          navigator.clipboard.writeText("0x" + stripped);
                        }}
                      >
                        Copy as Hex
                      </PanelContextMenuItem>
                      <PanelContextMenuItem
                        onSelect={() => {
                          const hex = reversedStack[virtualRow.index].replace(/^0x/i, "");
                          navigator.clipboard.writeText("0x" + hex.slice(-40).toLowerCase());
                        }}
                      >
                        Copy as Address
                      </PanelContextMenuItem>
                      <PanelContextMenuItem
                        onSelect={() => {
                          try {
                            const dec = BigInt(reversedStack[virtualRow.index]).toString(10);
                            navigator.clipboard.writeText(dec);
                          } catch {
                            navigator.clipboard.writeText(reversedStack[virtualRow.index]);
                          }
                        }}
                      >
                        Copy as Uint256 (dec)
                      </PanelContextMenuItem>
                      <PanelContextMenuItem
                        onSelect={async () => {
                          const val = reversedStack[virtualRow.index];
                          try {
                            const result = await invoke<number | null>("find_value_origin", {
                              globalIndex: currentStepIndex,
                              valueHex: val,
                            });
                            if (result !== null && result !== undefined) {
                              onSeekTo?.(result);
                              toast.success(`Value source at step ${result}`);
                            } else {
                              toast.info("No source found in this context");
                            }
                          } catch (e) {
                            toast.error(`Find origin failed: ${e}`);
                          }
                        }}
                      >
                        Find Last Show
                      </PanelContextMenuItem>
                      {/* Notes: hidden until feature is complete
                      <PanelContextMenuSeparator />
                      <PanelContextMenuItem
                        onSelect={() => addValueRecordFromStack(currentStepIndex, originalIndex, reversedStack[virtualRow.index])}
                      >
                        Record Value
                      </PanelContextMenuItem>
                      */}
                    </PanelContextMenuContent>
                  </PanelContextMenu>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm border-t">
            Empty Stack
          </div>
        )}
      </CardContent>
    </Card>
  );
}
