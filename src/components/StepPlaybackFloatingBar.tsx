import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, GripVertical, Pause, Play, X } from "lucide-react";
import { useDebugStore } from "@/store/debugStore";
import {
  clampStepPlaybackBarPos,
  defaultStepPlaybackBarPos,
  loadStepPlaybackBarPos,
  saveStepPlaybackBarPos,
  type StepPlaybackBarPos,
} from "@/lib/stepPlaybackBarPosition";

type Props = {
  onLast: () => void;
  onToggleAutoPlay: () => void;
  onNext: () => void;
  onClose: () => void;
};

/** 与 clamp / 默认位置一致（原 520×32 各减半） */
const BAR_W = 260;
const BAR_H = 16;

/**
 * 类视频控制条：可拖拽；左/右信息，中间仅控制图标。
 */
export function StepPlaybackFloatingBar({ onLast, onToggleAutoPlay, onNext, onClose }: Props) {
  const visible = useDebugStore((s) => s.isStepPlaybackBarVisible);
  const queue = useDebugStore((s) => s.stepPlaybackQueue);
  const cursor = useDebugStore((s) => s.stepPlaybackCursor);
  const autoPlaying = useDebugStore((s) => s.isStepPlaybackAutoPlaying);

  const [pos, setPos] = useState<StepPlaybackBarPos>(() => {
    const saved = loadStepPlaybackBarPos();
    if (saved) {
      return clampStepPlaybackBarPos(saved.left, saved.top, BAR_W, BAR_H);
    }
    return defaultStepPlaybackBarPos(BAR_W, BAR_H);
  });
  const posRef = useRef(pos);
  posRef.current = pos;

  const dragRef = useRef<{
    originX: number;
    originY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);

  useEffect(() => {
    const onResize = () => {
      setPos((p) => clampStepPlaybackBarPos(p.left, p.top, BAR_W, BAR_H));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onGripMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = posRef.current;
    dragRef.current = {
      originX: e.clientX,
      originY: e.clientY,
      startLeft: start.left,
      startTop: start.top,
    };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const left = d.startLeft + (ev.clientX - d.originX);
      const top = d.startTop + (ev.clientY - d.originY);
      setPos(clampStepPlaybackBarPos(left, top, BAR_W, BAR_H));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPos((p) => {
        saveStepPlaybackBarPos(p);
        return p;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  if (!visible || queue.length === 0) return null;

  const disabledLast = cursor <= 0;
  const disabledNext = cursor >= queue.length - 1;
  const curStep = queue[cursor] ?? "—";

  const iconCls =
    "flex shrink-0 cursor-pointer select-none items-center justify-center rounded px-0.5 text-zinc-800 transition-opacity hover:opacity-90 dark:text-zinc-200";
  const disabledCls = "opacity-30 pointer-events-none cursor-default";

  return (
    <div
      className="pointer-events-auto fixed z-[200] flex h-4 w-[min(92vw,260px)] min-w-[140px] max-w-[92vw] items-center rounded-2xl border border-zinc-200 bg-white px-1 shadow-xl dark:border-zinc-600 dark:bg-zinc-950"
      style={{ left: pos.left, top: pos.top }}
      role="toolbar"
      aria-label="Step queue playback"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 左：拖柄 + 序号进度 */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 pl-0.5">
        <span
          className="flex shrink-0 cursor-grab select-none items-center text-zinc-400 hover:text-zinc-600 active:cursor-grabbing dark:text-zinc-500 dark:hover:text-zinc-300"
          title="Drag"
          onMouseDown={onGripMouseDown}
        >
          <GripVertical className="h-3 w-3" aria-hidden />
        </span>
        <span className="truncate font-mono text-[9px] leading-none tabular-nums text-zinc-500 dark:text-zinc-400">
          {cursor + 1}/{queue.length}
        </span>
      </div>

      {/* 中：控制图标 */}
      <div className="flex shrink-0 items-center gap-px">
        <span
          role="button"
          tabIndex={disabledLast ? -1 : 0}
          className={`${iconCls} ${disabledLast ? disabledCls : ""}`}
          title="Previous in queue"
          onClick={(e) => {
            e.stopPropagation();
            if (!disabledLast) onLast();
          }}
          onKeyDown={(e) => {
            if (!disabledLast && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              onLast();
            }
          }}
        >
          <ChevronLeft className="h-3 w-3" aria-hidden />
        </span>
        <span
          role="button"
          tabIndex={0}
          className={iconCls}
          title={autoPlaying ? "Pause auto-advance" : "Auto-advance queue"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleAutoPlay();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleAutoPlay();
            }
          }}
        >
          {autoPlaying ? (
            <Pause className="h-3 w-3" aria-hidden />
          ) : (
            <Play className="h-3 w-3" aria-hidden />
          )}
        </span>
        <span
          role="button"
          tabIndex={disabledNext ? -1 : 0}
          className={`${iconCls} ${disabledNext ? disabledCls : ""}`}
          title="Next in queue"
          onClick={(e) => {
            e.stopPropagation();
            if (!disabledNext) onNext();
          }}
          onKeyDown={(e) => {
            if (!disabledNext && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              onNext();
            }
          }}
        >
          <ChevronRight className="h-3 w-3" aria-hidden />
        </span>
      </div>

      {/* 右：step 号 + 关闭 */}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5 pr-0.5">
        <span className="truncate font-mono text-[9px] leading-none tabular-nums text-zinc-500 dark:text-zinc-400">
          step {curStep}
        </span>
        <span
          className="flex shrink-0 cursor-pointer select-none text-zinc-500 hover:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-200"
          title="Hide playback bar"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X className="h-3 w-3" aria-hidden />
        </span>
      </div>
    </div>
  );
}
