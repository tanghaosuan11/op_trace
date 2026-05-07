import { useRef, useState, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { useDebugStore } from "@/store/debugStore";
import {
  PanelContextMenu, PanelContextMenuContent, PanelContextMenuItem,
  PanelContextMenuSeparator, PanelContextMenuTrigger,
} from "@/components/ui/panel-context-menu";
// import { addValueRecordFromMemory } from "@/components/NotesDrawer";

export interface MemoryHighlightRange {
  start: number; // byte offset (inclusive)
  end: number;   // byte offset (inclusive)
  className?: string; // tailwind bg class, default: "bg-yellow-400/40"
}

interface MemoryViewerProps {
  highlightRanges?: MemoryHighlightRange[];
  onSelectionChange?: (range: { start: number; end: number } | null) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

const ROW_HEIGHT = 24;
const BYTES_PER_ROW = 32;

export function MemoryViewer({ highlightRanges = [], onSelectionChange, scrollContainerRef }: MemoryViewerProps) {
  const memory = useDebugStore((s) => s.memory);
  const activePanelId = useDebugStore((s) => s.activePanelId);
  const isActive = activePanelId === "memory";

  const internalRef = useRef<HTMLDivElement>(null);
  const parentRef = scrollContainerRef || internalRef;
  const [selectedRange, setSelectedRange] = useState<{ start: number; end: number } | null>(null);
  const isDragging = useRef(false);
  const dragStart = useRef<number | null>(null);
  const lastRightClickedRow = useRef<number>(0);

  // 全局 mouseup：即使鼠标移出组件也能结束拖拽
  useEffect(() => {
    const handleGlobalMouseUp = () => { isDragging.current = false; };
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
  }, []);

  const handleByteMouseDown = (e: React.MouseEvent, byteIndex: number) => {
    if (e.button === 2) return;
    // 点击已选中的单一字节则取消选择
    if (selectedRange && selectedRange.start === byteIndex && selectedRange.end === byteIndex) {
      setSelectedRange(null);
      onSelectionChange?.(null);
      dragStart.current = null;
      return;
    }
    isDragging.current = true;
    dragStart.current = byteIndex;
    const range = { start: byteIndex, end: byteIndex };
    setSelectedRange(range);
    onSelectionChange?.(range);
  };

  const handleByteMouseEnter = (byteIndex: number) => {
    if (isDragging.current && dragStart.current !== null) {
      const start = Math.min(dragStart.current, byteIndex);
      const end = Math.max(dragStart.current, byteIndex);
      const range = { start, end };
      setSelectedRange(range);
      onSelectionChange?.(range);
    }
  };

  const handleByteMouseUp = () => {
    isDragging.current = false;
  };

  const getByteClassName = (byteIndex: number): string => {
    // 用户选择高亮优先级最高
    if (selectedRange && byteIndex >= selectedRange.start && byteIndex <= selectedRange.end) {
      return "bg-blue-500/50 text-blue-100 rounded-sm";
    }
    // 外部传入的高亮区间
    for (const hr of highlightRanges) {
      if (byteIndex >= hr.start && byteIndex <= hr.end) {
        return hr.className ?? "bg-yellow-400/40 rounded-sm";
      }
    }
    return "";
  };

  const getByteStyle = (_byteIndex: number) => undefined;

  // 对话框状态
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [offsetInput, setOffsetInput] = useState("");
  const [lenInput, setLenInput] = useState("");
  const [base, setBase] = useState<"10" | "16">("16");
  const [extractedData, setExtractedData] = useState("");
  const [extractError, setExtractError] = useState("");

  // 将 hex 字符串转换为行数据
  const hexData = memory.startsWith("0x") ? memory.slice(2) : memory;
  const totalBytes = Math.floor(hexData.length / 2);
  const rowCount = Math.ceil(totalBytes / BYTES_PER_ROW);

  // 生成列头（00-1F）
  const columnHeaders = Array.from({ length: BYTES_PER_ROW }, (_, i) => 
    i.toString(16).padStart(2, "0").toUpperCase()
  );

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  // 当外部高亮变化时，自动滚动到第一个高亮区间的起始行
  useEffect(() => {
    if (highlightRanges.length > 0) {
      const firstByte = highlightRanges[0].start;
      const rowIndex = Math.floor(firstByte / BYTES_PER_ROW);
      if (rowIndex < rowCount) {
        virtualizer.scrollToIndex(rowIndex, { align: "center", behavior: "auto" });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightRanges]);

  const getRowData = (rowIndex: number) => {
    const startByte = rowIndex * BYTES_PER_ROW;
    const startHex = startByte * 2;
    const endHex = Math.min(startHex + BYTES_PER_ROW * 2, hexData.length);
    const rowHex = hexData.slice(startHex, endHex);
    
    const bytes = [];
    for (let i = 0; i < rowHex.length; i += 2) {
      bytes.push(rowHex.slice(i, i + 2));
    }
    // Pad incomplete row with "00"
    while (bytes.length < BYTES_PER_ROW) {
      bytes.push("00");
    }
    
    return {
      offset: startByte.toString(16).padStart(4, "0").toUpperCase(),
      bytes,
    };
  };

  // 提取内存数据
  const handleExtract = () => {
    setExtractError("");
    setExtractedData("");

    try {
      // 解析 offset 和 len
      const offset = base === "16" 
        ? parseInt(offsetInput, 16) 
        : parseInt(offsetInput, 10);
      const len = base === "16" 
        ? parseInt(lenInput, 16) 
        : parseInt(lenInput, 10);

      if (isNaN(offset) || isNaN(len)) {
        setExtractError("Please enter valid numbers");
        return;
      }

      if (offset < 0 || len < 0) {
        setExtractError("Offset and length must be non-negative");
        return;
      }

      if (offset >= totalBytes) {
        setExtractError(`Offset out of range (max: ${totalBytes - 1})`);
        return;
      }

      const actualLen = Math.min(len, totalBytes - offset);
      if (actualLen < len) {
        setExtractError(`Only ${actualLen} byte(s) available from offset`);
      }

      // 提取数据
      const startHex = offset * 2;
      const endHex = startHex + actualLen * 2;
      const extracted = hexData.slice(startHex, endHex);
      setExtractedData("0x" + extracted);
    } catch (error) {
      setExtractError("Extract failed: " + (error instanceof Error ? error.message : String(error)));
    }
  };

  const handleCopySelection = () => {
    if (!selectedRange) return;
    const startHex = selectedRange.start * 2;
    const endHex = (selectedRange.end + 1) * 2;
    const copied = "0x" + hexData.slice(startHex, endHex);
    navigator.clipboard.writeText(copied);
    const byteCount = selectedRange.end - selectedRange.start + 1;
    toast(`Copied ${byteCount} byte${byteCount > 1 ? "s" : ""} to clipboard`, { duration: 1500 });
  };

  const handleCopyRow = () => {
    const rowStart = lastRightClickedRow.current * BYTES_PER_ROW;
    const startHex = rowStart * 2;
    const endHex = startHex + BYTES_PER_ROW * 2;
    const rowHex = hexData.slice(startHex, Math.min(endHex, hexData.length));
    navigator.clipboard.writeText("0x" + rowHex.padEnd(BYTES_PER_ROW * 2, "0"));
    toast(`Copied row ${lastRightClickedRow.current} (32 bytes) to clipboard`, { duration: 1500 });
  };

  const handleSelectionToUtf8 = () => {
    if (!selectedRange) return;
    const startHex = selectedRange.start * 2;
    const endHex = (selectedRange.end + 1) * 2;
    const slice = hexData.slice(startHex, endHex);
    const matched = slice.match(/.{1,2}/g) ?? [];
    const bytes = new Uint8Array(matched.map((b) => parseInt(b, 16)));
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    navigator.clipboard.writeText(text);
    toast(`UTF-8: ${text}`, { duration: 3000 });
  };

  return (
    <>
      <Card data-panel-id="memory" className={`h-full flex flex-col transition-all ${
        isActive ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""
      }`}>
        <CardHeader className="py-1 px-3 flex-shrink-0 bg-muted/50 border-b">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Memory ({totalBytes} bytes)</CardTitle>
            <div className="flex items-center gap-1">
              <span
                title={selectedRange ? `Copy selected (${selectedRange.end - selectedRange.start + 1} bytes)` : "No selection"}
                className={selectedRange ? "cursor-pointer hover:opacity-70" : "opacity-30 cursor-default"}
                onClick={handleCopySelection}
              >
                <Copy size={13} />
              </span>
              {/* <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={handleOpenDialog}
              >
                Export
              </Button> */}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0 flex-1 min-h-0">
          {totalBytes > 0 ? (
            <div className="h-full flex flex-col border-t">
              {/* 列头 */}
              <div className="flex items-center px-2 py-1 text-xs font-mono bg-muted/50 border-b sticky top-0 z-10">
                <span className="w-12 text-muted-foreground"></span>
                <span className="flex-1 flex gap-0.5">
                  {columnHeaders.map((header, i) => (
                    <span key={i} className="w-[18px] text-center text-muted-foreground text-[10px]">
                      {header}
                    </span>
                  ))}
                </span>
              </div>
              {/* 数据区域 */}
              <PanelContextMenu>
                <PanelContextMenuTrigger asChild>
                  <div
                    ref={parentRef}
                    className="flex-1 overflow-auto select-none scrollbar-hidden"
                  >
                    <div
                      style={{
                        height: `${virtualizer.getTotalSize()}px`,
                        width: "100%",
                        position: "relative",
                      }}
                    >
                      {virtualizer.getVirtualItems().map((virtualRow) => {
                        const { offset, bytes } = getRowData(virtualRow.index);
                        return (
                          <div
                            key={virtualRow.key}
                            style={{
                              position: "absolute",
                              top: 0,
                              left: 0,
                              width: "100%",
                              height: `${virtualRow.size}px`,
                              transform: `translateY(${virtualRow.start}px)`,
                            }}
                            className={`flex items-center px-2 text-xs font-mono border-b ${
                              virtualRow.index % 2 === 0 ? "bg-muted/30" : ""
                            }`}
                            onContextMenu={() => { lastRightClickedRow.current = virtualRow.index; }}
                          >
                            <span className="w-12 text-muted-foreground text-[10px] pointer-events-none select-none">{offset}</span>
                            <span className="flex-1 flex gap-0.5">
                              {bytes.map((byte, i) => {
                                const byteIndex = virtualRow.index * BYTES_PER_ROW + i;
                                return (
                                  <span
                                    key={i}
                                    className={`w-[18px] text-center text-[10px] select-none cursor-pointer ${getByteClassName(byteIndex)}`}
                                    style={getByteStyle(byteIndex)}
                                    onMouseDown={(e) => handleByteMouseDown(e, byteIndex)}
                                    onMouseEnter={() => handleByteMouseEnter(byteIndex)}
                                    onMouseUp={handleByteMouseUp}
                                  >
                                    {byte}
                                  </span>
                                );
                              })}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </PanelContextMenuTrigger>
                <PanelContextMenuContent>
                  <PanelContextMenuItem
                    disabled={!selectedRange}
                    onSelect={handleCopySelection}
                  >
                    Copy Selection
                  </PanelContextMenuItem>
                  <PanelContextMenuItem onSelect={handleCopyRow}>
                    Copy Row (32 bytes)
                  </PanelContextMenuItem>
                  <PanelContextMenuSeparator />
                  <PanelContextMenuItem
                    disabled={!selectedRange}
                    onSelect={handleSelectionToUtf8}
                  >
                    Selection → UTF-8
                  </PanelContextMenuItem>
                  {/* Notes: hidden until feature is complete
                  <PanelContextMenuSeparator />
                  <PanelContextMenuItem
                    disabled={!selectedRange}
                    onSelect={() => {
                      if (!selectedRange) return;
                      const start = selectedRange.start;
                      const len = selectedRange.end - selectedRange.start + 1;
                      const startHex = start * 2;
                      const endHex = (selectedRange.end + 1) * 2;
                      const val = "0x" + hexData.slice(startHex, endHex);
                      const stepIndex = useDebugStore.getState().currentStepIndex;
                      addValueRecordFromMemory(stepIndex, start, len, val);
                    }}
                  >
                    Record Selection
                  </PanelContextMenuItem>
                  */}
                </PanelContextMenuContent>
              </PanelContextMenu>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm border-t">
              Empty
            </div>
          )}
        </CardContent>
      </Card>

      {/* 提取内存对话框 */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Export Memory</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Number Base</Label>
              <Select value={base} onValueChange={(v) => setBase(v as "10" | "16")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="16">16</SelectItem>
                  <SelectItem value="10">10</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="offset">
                Offset {base === "16" ? "(hex)" : "(dec)"}
              </Label>
              <Input
                id="offset"
                placeholder={base === "16" ? "20 OR 0x20" : " 32"}
                value={offsetInput}
                onChange={(e) => setOffsetInput(e.target.value)}
                className="font-mono"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="len">
                Length {base === "16" ? "(hex)" : "(dec)"}
              </Label>
              <Input
                id="len"
                placeholder={base === "16" ? "20 OR 0x20" : " 32"}
                value={lenInput}
                onChange={(e) => setLenInput(e.target.value)}
                className="font-mono"
              />
            </div>

            {extractedData && (
              <div className="space-y-2">
                <Label>Result</Label>
                <div className="h-40 overflow-auto p-3 bg-muted rounded-md">
                  <div className="text-xs font-mono break-all">
                    {extractedData}
                  </div>
                </div>
              </div>
            )}

            {/* 错误信息 */}
            {extractError && (
              <div className="text-sm text-amber-600">
                {extractError}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleExtract}>
              Ok
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
