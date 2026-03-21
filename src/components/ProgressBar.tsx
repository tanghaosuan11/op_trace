import { useState, useRef, useEffect } from "react";
import { Slider } from "@/components/ui/slider";
import { useDebugStore } from "@/store/debugStore";

interface ProgressBarProps {
  onSeekTo: (index: number) => void;
  onSpeedChange: (speed: number) => void;
}

// Speed mapping: slider position 0 → 1x, positions 1-20 → 5,10,...,100x
const sliderToSpeed = (v: number) => v === 0 ? 1 : v * 5;
const speedToSlider = (s: number) => s <= 1 ? 0 : Math.round(s / 5);

const THROTTLE_MS = 150;

export function ProgressBar({
  onSeekTo,
  onSpeedChange
}: ProgressBarProps) {
  const currentStepIndex = useDebugStore((s) => s.currentStepIndex);
  const stepCount = useDebugStore((s) => s.stepCount);
  const playbackSpeed = useDebugStore((s) => s.playbackSpeed);
  const isPlaying = useDebugStore((s) => s.isPlaying);
  const [jumpFocused, setJumpFocused] = useState(false);
  const [jumpInput, setJumpInput] = useState("");

  // 拖动中的本地值（滑块拇指即时跟随手指，不等 IPC 返回）
  const [draggingValue, setDraggingValue] = useState<number | null>(null);
  const pendingValueRef = useRef<number | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // commit 后等待 store 确认再清除 draggingValue，避免 IPC 期间闪回旧位置
  const awaitingCommitRef = useRef(false);

  // 组件卸载时清理 timer
  useEffect(() => {
    return () => {
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
    };
  }, []);

  // store 的 currentStepIndex 更新后（IPC 返回），清除 draggingValue
  useEffect(() => {
    if (awaitingCommitRef.current) {
      awaitingCommitRef.current = false;
      setDraggingValue(null);
    }
  }, [currentStepIndex]);

  // 滑块值显示：拖动中用本地值，松开后用 store 值
  const displayValue = draggingValue ?? currentStepIndex;

  const handleSliderChange = ([v]: number[]) => {
    setDraggingValue(v);
    pendingValueRef.current = v;
    if (!throttleTimerRef.current) {
      throttleTimerRef.current = setTimeout(() => {
        throttleTimerRef.current = null;
        if (pendingValueRef.current !== null) {
          onSeekTo(pendingValueRef.current);
        }
      }, THROTTLE_MS);
    }
  };

  const handleSliderCommit = ([v]: number[]) => {
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
    pendingValueRef.current = null;
    awaitingCommitRef.current = true; // 不立即清除 draggingValue，等 store 确认
    onSeekTo(v);
  };

  const handleJump = () => {
    const val = parseInt(jumpInput, 10);
    if (!isNaN(val) && val >= 1 && val <= stepCount) {
      onSeekTo(val - 1);
    }
    setJumpFocused(false);
    setJumpInput("");
  };

  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-2 py-1 border-b bg-muted/30">
      <Slider
        className="flex-1 min-w-[80px]"
        min={0}
        max={Math.max(0, stepCount - 1)}
        step={1}
        value={[displayValue]}
        onValueChange={handleSliderChange}
        onValueCommit={handleSliderCommit}
        disabled={isPlaying}
      />
      <span className="text-[11px] text-muted-foreground font-mono shrink-0">{stepCount}</span>
      <input
        type="number"
        min="1"
        max={stepCount}
        value={jumpFocused ? jumpInput : displayValue + 1}
        onChange={(e) => setJumpInput(e.target.value)}
        onFocus={() => { setJumpFocused(true); setJumpInput(String(currentStepIndex + 1)); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        onBlur={() => handleJump()}
        disabled={isPlaying}
        className="w-20 h-5 py-0 px-1 leading-none text-[10px] font-mono rounded border border-input bg-background text-center focus:outline-none focus:ring-0 focus:shadow-none shadow-none disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <div className="w-px h-4 bg-border mx-1" />
      <span className="text-[11px] text-muted-foreground shrink-0">Speed:</span>
      <Slider
        className="w-20"
        min={0}
        max={20}
        step={1}
        value={[speedToSlider(playbackSpeed)]}
        onValueChange={([v]) => onSpeedChange(sliderToSpeed(v))}
        disabled={isPlaying}
        title={`${playbackSpeed}x speed`}
      />
      <span className="text-[11px] text-muted-foreground w-6 shrink-0">{playbackSpeed}x</span>
    </div>
  );
}
