import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** 底部抽屉共用样式：与 DataFlow 顶边一致（gray-300），避免 border-border 在浅色下像白条 */
export const bottomSheetContentClassName =
  "flex flex-col gap-0 overflow-hidden p-0 [&>button]:hidden border-t border-gray-300 bg-background shadow-[0_-4px_16px_rgba(0,0,0,0.22)]";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function getWindowMaxPx(maxHeightVh: number) {
  if (typeof window === "undefined") return 800;
  return Math.floor(window.innerHeight * maxHeightVh);
}

function getInitialHeightPx(opts: {
  defaultHeightPx?: number;
  defaultHeightVh: number;
  minHeightPx: number;
  maxHeightVh: number;
}) {
  if (typeof window === "undefined") return 400;
  const maxPx = getWindowMaxPx(opts.maxHeightVh);
  if (opts.defaultHeightPx != null) {
    return clamp(opts.defaultHeightPx, opts.minHeightPx, maxPx);
  }
  const vh = opts.defaultHeightVh;
  return clamp(Math.round(window.innerHeight * (vh / 100)), opts.minHeightPx, maxPx);
}

export interface BottomSheetShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `SheetTitle` 仅用于无障碍，通常配合页面内可见标题 */
  sheetTitle: string;
  children: React.ReactNode;
  /** 追加到 `SheetContent`，如 Analysis 的 `bg-white text-slate-900` */
  contentClassName?: string;
  contentStyle?: React.CSSProperties;

  /**
   * 为 false 时使用固定 `heightClassName`（不可拖拽）。
   * @default true
   */
  resizable?: boolean;
  /** 初始高度（vh），默认 50；与 `defaultHeightPx` 二选一 */
  defaultHeightVh?: number;
  /** 初始高度（px），优先于 `defaultHeightVh`（如 Utilities 320） */
  defaultHeightPx?: number;
  /** @default 120 */
  minHeightPx?: number;
  /** 相对视口高度的上限比例 @default 0.92 */
  maxHeightVh?: number;

  /** 仅 `resizable={false}` 时使用，例如 `h-[55vh]` */
  heightClassName?: string;
  /**
   * 为 true 时关闭抽屉也不卸载 `SheetContent` 子树，保留内部 React 状态（如表单输入）。
   * @default false
   */
  contentForceMount?: boolean;
}

/**
 * 自底部弹出的 Sheet 外壳：统一 `SheetContent` 与无障碍标题。
 * 默认可通过顶部细条拖拽改变高度（逻辑与 `DataFlowModal` 一致）。
 */
export function BottomSheetShell({
  open,
  onOpenChange,
  sheetTitle,
  contentClassName,
  contentStyle,
  children,
  resizable = true,
  defaultHeightVh = 50,
  defaultHeightPx,
  minHeightPx = 120,
  maxHeightVh = 0.92,
  heightClassName,
  contentForceMount = false,
}: BottomSheetShellProps) {
  const fixedMode = resizable === false;

  const [heightPx, setHeightPx] = useState(() =>
    getInitialHeightPx({
      defaultHeightPx,
      defaultHeightVh,
      minHeightPx,
      maxHeightVh,
    }),
  );

  useEffect(() => {
    const onResize = () => {
      const cap = getWindowMaxPx(maxHeightVh);
      setHeightPx((h) => clamp(h, minHeightPx, cap));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [minHeightPx, maxHeightVh]);

  /** 打开时按当前窗口重算一次上限 */
  useEffect(() => {
    if (!open || fixedMode) return;
    const cap = getWindowMaxPx(maxHeightVh);
    setHeightPx((h) => clamp(h, minHeightPx, cap));
  }, [open, fixedMode, minHeightPx, maxHeightVh]);

  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHRef = useRef(0);

  const onDragStart = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (fixedMode) return;
      e.preventDefault();
      draggingRef.current = true;
      startYRef.current = e.clientY;
      startHRef.current = heightPx;

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const maxPx = getWindowMaxPx(maxHeightVh);
        const deltaY = ev.clientY - startYRef.current;
        const next = startHRef.current - deltaY;
        setHeightPx(clamp(next, minHeightPx, maxPx));
      };

      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [fixedMode, heightPx, minHeightPx, maxHeightVh],
  );

  const sheetStyle: React.CSSProperties | undefined = fixedMode
    ? contentStyle
    : {
        height: heightPx,
        maxHeight: `${maxHeightVh * 100}vh`,
        minHeight: minHeightPx,
        ...contentStyle,
      };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        forceMount={contentForceMount}
        className={cn(bottomSheetContentClassName, fixedMode && heightClassName, !fixedMode && "min-h-0", contentClassName)}
        style={sheetStyle}
        aria-describedby={undefined}
      >
        {!fixedMode && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="拖拽调整抽屉高度"
            onMouseDown={onDragStart}
            className="h-1.5 w-full shrink-0 cursor-ns-resize bg-gray-300 transition-colors hover:bg-blue-400"
            title="拖拽改变大小"
          />
        )}
        <SheetTitle className="sr-only">{sheetTitle}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  );
}
