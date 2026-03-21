import { useRef, useEffect, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDebugStore } from "@/store/debugStore";

interface CallFrameInfo {
  id: string;
  contextId: number;
  depth: number;
}

interface TabBarProps {
  activeTab: string;
  callFrames: CallFrameInfo[];
  onTabChange: (tabId: string) => void;
}

export function TabBar({ 
  activeTab, 
  callFrames, 
  onTabChange,
}: TabBarProps) {
  const hiddenFrameIds = useDebugStore((s) => s.hiddenFrameIds);
  const visibleFrames = useMemo(
    () => callFrames.filter((f) => !hiddenFrameIds.has(f.id)),
    [callFrames, hiddenFrameIds]
  );

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: visibleFrames.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    horizontal: true,
    overscan: 5,
    gap: 2,
  });

  // activeTab 变化时自动滚动到对应标签
  useEffect(() => {
    if (activeTab === "main") return;
    const idx = visibleFrames.findIndex(f => f.id === activeTab);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'auto' });
    }
  }, [activeTab]);

  return (
    <div className="flex-shrink-0 border-b flex items-center bg-muted/30">
      <div className="flex-shrink-0 px-1.5">
        <button
          onClick={() => onTabChange("main")}
          className={`px-2 py-1 text-xs rounded-t border-b-2 transition-colors ${
            activeTab === "main"
              ? "border-primary bg-background text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          Main
        </button>
      </div>

      <div
        ref={parentRef}
        className="flex-1 overflow-x-auto overflow-y-hidden"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        <style>{`
          .tab-container::-webkit-scrollbar {
            display: none;
          }
        `}</style>
        <div
          className="tab-container"
          style={{
            width: `${virtualizer.getTotalSize()}px`,
            height: '28px',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const frame = visibleFrames[virtualItem.index];
            return (
              <button
                key={frame.id}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                onClick={() => onTabChange(frame.id)}
                className={`px-2 py-0.5 text-xs rounded-t border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === frame.id
                    ? "border-primary bg-background text-foreground"
                    : "border-transparent text-muted-foreground"
                }`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  transform: `translateX(${virtualItem.start}px)`,
                }}
              >
                Frame {frame.contextId}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-shrink-0 px-2">
        <div className="text-xs text-muted-foreground">
          {visibleFrames.length}/{callFrames.length} frames
        </div>
      </div>
    </div>
  );
}
