import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { CSSProperties } from "react";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebugStore } from "@/store/debugStore";
import { Circle, Scissors } from "lucide-react";

interface ProgressBarProps {
  onSeekTo: (index: number) => void;
  onSpeedChange: (speed: number) => void;
}

/** 多笔：叠在滑条上的点（absolute，不占额外布局） */
interface TxJumpDot {
  pct: number;
  step: number;
  title: string;
}

const TX_DOT_MIN_GAP_PCT = 1.8;
const TX_DOT_DIAMETER_PX = 8; // h-2 w-2

function enforceMinPctGap(dots: TxJumpDot[], minGapPct: number): TxJumpDot[] {
  if (dots.length <= 1) return dots;
  const gap = Math.max(0, minGapPct);
  const out = dots.map((d) => ({ ...d }));

  // Forward pass: ensure out[i] - out[i-1] >= gap
  for (let i = 1; i < out.length; i++) {
    const minAllowed = out[i - 1].pct + gap;
    if (out[i].pct < minAllowed) {
      out[i].pct = minAllowed;
    }
  }

  // Backward pass: keep right boundary <= 100 and preserve gap
  if (out[out.length - 1].pct > 100) {
    out[out.length - 1].pct = 100;
    for (let i = out.length - 2; i >= 0; i--) {
      const maxAllowed = out[i + 1].pct - gap;
      if (out[i].pct > maxAllowed) {
        out[i].pct = maxAllowed;
      }
    }
  }

  // Final clamp in case data is extremely dense.
  for (let i = 0; i < out.length; i++) {
    out[i].pct = Math.max(0, Math.min(100, out[i].pct));
  }
  return out;
}

/** 滑条下方一行：图标垂直居中于条内 */
function txMarkerRowStyle(pct: number): CSSProperties {
  if (pct <= 0.25) return { left: 0, top: "50%", transform: "translateY(-50%)" };
  if (pct >= 99.75) return { left: "100%", top: "50%", transform: "translate(-100%, -50%)" };
  return { left: `${pct}%`, top: "50%", transform: "translate(-50%, -50%)" };
}

// Speed mapping: slider position 0 → 1x, positions 1-20 → 5,10,...,100x
const sliderToSpeed = (v: number) => v === 0 ? 1 : v * 5;
const speedToSlider = (s: number) => s <= 1 ? 0 : Math.round(s / 5);

const THROTTLE_MS = 150;
const MAX_RANGE_STEPS = 5000;

export function ProgressBar({
  onSeekTo,
  onSpeedChange
}: ProgressBarProps) {
  const currentStepIndex = useDebugStore((s) => s.currentStepIndex);
  const stepCount = useDebugStore((s) => s.stepCount);
  const playbackSpeed = useDebugStore((s) => s.playbackSpeed);
  const isPlaying = useDebugStore((s) => s.isPlaying);
  const rangeEnabled = useDebugStore((s) => s.rangeEnabled);
  const rangeStart = useDebugStore((s) => s.rangeStart);
  const rangeEnd = useDebugStore((s) => s.rangeEnd);
  const txBoundaries = useDebugStore((s) => s.txBoundaries);
  const [jumpFocused, setJumpFocused] = useState(false);
  const [jumpInput, setJumpInput] = useState("");

  // 拖动中的本地值（滑块拇指即时跟随手指，不等 IPC 返回）
  const [draggingValue, setDraggingValue] = useState<number | null>(null);
  const pendingValueRef = useRef<number | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // commit 后等待 store 确认再清除 draggingValue，避免 IPC 期间闪回旧位置
  const awaitingCommitRef = useRef(false);

  // range popover 本地 input 状态
  const [rangeStartInput, setRangeStartInput] = useState("");
  const [rangeEndInput, setRangeEndInput] = useState("");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const sliderWrapRef = useRef<HTMLDivElement | null>(null);
  const [txDotMinGapPct, setTxDotMinGapPct] = useState(TX_DOT_MIN_GAP_PCT);
  const sync = useDebugStore.getState().sync;
  const setRangeStart = useCallback((v: number) => sync({ rangeStart: v }), [sync]);
  const setRangeEnd = useCallback((v: number) => sync({ rangeEnd: v }), [sync]);
  const setRange = useCallback((s: number, e: number) => sync({ rangeStart: s, rangeEnd: e }), [sync]);
  const setRangeEnabled = useCallback((enabled: boolean) => {
    if (enabled) {
      const maxIdx = Math.max(0, stepCount - 1);
      const center = Math.max(0, currentStepIndex);
      const HALF = 50;
      let s = center - HALF;
      let e = center + HALF;
      // 一边不足就向另一边扩展
      if (s < 0) { e = Math.min(maxIdx, e + (-s)); s = 0; }
      if (e > maxIdx) { s = Math.max(0, s - (e - maxIdx)); e = maxIdx; }
      sync({ rangeEnabled: true, rangeStart: s, rangeEnd: e });
    } else {
      sync({ rangeEnabled: false });
    }
  }, [sync, stepCount, currentStepIndex]);
  // 记录当前正在拖动的 thumb index（0=rangeStart, 1=currentStep, 2=rangeEnd）
  const activeThumbRef = useRef<number | null>(null);

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

  // popover 打开时同步 store 值到 input
  useEffect(() => {
    if (popoverOpen) {
      setRangeStartInput(String(rangeStart + 1));
      setRangeEndInput(String(rangeEnd + 1));
    }
  }, [popoverOpen, rangeStart, rangeEnd]);

  // stepCount 变化时重置 range 到全部范围
  useEffect(() => {
    if (stepCount > 0) {
      setRange(0, stepCount - 1);
    }
  }, [stepCount, setRange]);

  // 基于实际宽度计算“刚好相邻”的最小间距（百分比）
  useEffect(() => {
    const el = sliderWrapRef.current;
    if (!el) return;
    const updateGap = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      const pct = (TX_DOT_DIAMETER_PX / w) * 100;
      // 预留一个很小的视觉安全边，避免亚像素时看起来仍重叠
      setTxDotMinGapPct(Math.max(0.01, pct + 0.02));
    };
    updateGap();
    const ro = new ResizeObserver(updateGap);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 滑块值显示：拖动中用本地值，松开后用 store 值
  const displayValue = draggingValue ?? currentStepIndex;

  const multiTxLabel = useMemo(() => {
    if (!txBoundaries?.length) return null;
    const g = Math.max(0, currentStepIndex);
    let txIdx = 0;
    for (let i = 0; i < txBoundaries.length; i++) {
      if (g >= txBoundaries[i]) txIdx = i + 1;
    }
    return `Tx ${txIdx + 1}/${txBoundaries.length + 1}`;
  }, [currentStepIndex, txBoundaries]);

  const txJumpDots = useMemo((): TxJumpDot[] => {
    const hi = Math.max(0, stepCount - 1);
    if (!txBoundaries?.length || hi <= 0) return [];
    type P = { step: number; pct: number; title: string };
    const raw: P[] = [];
    if (!txBoundaries.includes(0)) {
      raw.push({
        step: 0,
        pct: 0,
        title: `Tx 1 · step 1 / ${stepCount}`,
      });
    }
    for (let i = 0; i < txBoundaries.length; i++) {
      const step = txBoundaries[i];
      raw.push({
        step,
        pct: (step / hi) * 100,
        title: `Tx ${i + 2} · step ${step + 1} / ${stepCount}`,
      });
    }
    raw.sort((a, b) => a.pct - b.pct || a.step - b.step);
    const seen = new Set<number>();
    const points = raw.filter((d) => {
      if (seen.has(d.step)) return false;
      seen.add(d.step);
      return true;
    });
    if (points.length === 0) return [];
    const out: TxJumpDot[] = points.map((p) => ({
      pct: p.pct,
      step: p.step,
      title: p.title,
    }));
    return enforceMinPctGap(out, txDotMinGapPct);
  }, [txBoundaries, stepCount, txDotMinGapPct]);

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
    awaitingCommitRef.current = true;
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

  // 范围滑块变化（三值：[rangeStart, currentStep, rangeEnd]）
  // 只响应 activeThumbRef 指定的那个 thumb，避免 Radix 排序推挤导致其他 thumb 误动
  const handleRangeSliderChange = useCallback((values: number[]) => {
    const activeIdx = activeThumbRef.current;
    if (activeIdx === null) return;
    const maxIdx = stepCount - 1;

    if (activeIdx === 0) {
      // 拖动 rangeStart：只更新 rangeStart，不 seek；同时限制与 rangeEnd 的差值
      const newRs = Math.max(Math.max(0, rangeEnd - (MAX_RANGE_STEPS - 1)), Math.min(values[0], maxIdx));
      setRangeStart(newRs);
    } else if (activeIdx === 1) {
      // 拖动 currentStep：只 seek，不改范围
      const cur = values[1];
      setDraggingValue(cur);
      pendingValueRef.current = cur;
      if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(() => {
          throttleTimerRef.current = null;
          if (pendingValueRef.current !== null) onSeekTo(pendingValueRef.current);
        }, THROTTLE_MS);
      }
    } else if (activeIdx === 2) {
      // 拖动 rangeEnd：只更新 rangeEnd，不 seek；同时限制与 rangeStart 的差值
      const newRe = Math.min(Math.min(rangeStart + (MAX_RANGE_STEPS - 1), maxIdx), Math.max(0, values[2]));
      setRangeEnd(newRe);
    }
  }, [stepCount, rangeStart, rangeEnd, onSeekTo, setRangeStart, setRangeEnd]);

  const handleRangeSliderCommit = useCallback((values: number[]) => {
    const activeIdx = activeThumbRef.current;
    activeThumbRef.current = null;
    const maxIdx = stepCount - 1;
    if (activeIdx === 0) {
      const newRs = Math.max(Math.max(0, rangeEnd - (MAX_RANGE_STEPS - 1)), Math.min(values[0], maxIdx));
      setRangeStart(newRs);
    } else if (activeIdx === 1) {
      if (throttleTimerRef.current) { clearTimeout(throttleTimerRef.current); throttleTimerRef.current = null; }
      pendingValueRef.current = null;
      awaitingCommitRef.current = true;
      onSeekTo(values[1]);
    } else if (activeIdx === 2) {
      const newRe = Math.min(Math.min(rangeStart + (MAX_RANGE_STEPS - 1), maxIdx), Math.max(0, values[2]));
      setRangeEnd(newRe);
    }
  }, [stepCount, rangeStart, rangeEnd, onSeekTo, setRangeStart, setRangeEnd]);

  // 提交 popover input
  const commitRangeInput = useCallback(() => {
    const maxIdx = stepCount - 1;
    let s = parseInt(rangeStartInput, 10) - 1;
    let e = parseInt(rangeEndInput, 10) - 1;
    if (isNaN(s)) s = 0;
    if (isNaN(e)) e = maxIdx;
    s = Math.max(0, Math.min(s, maxIdx));
    e = Math.max(0, Math.min(e, maxIdx));
    if (e - s < 1) { e = Math.min(s + 1, maxIdx); s = e - 1; }
    // 限制范围最多 MAX_RANGE_STEPS 步
    if (e - s >= MAX_RANGE_STEPS) { e = s + MAX_RANGE_STEPS - 1; }
    setRange(s, e);
    setRangeStartInput(String(s + 1));
    setRangeEndInput(String(e + 1));
  }, [stepCount, rangeStartInput, rangeEndInput, setRange]);

  const maxIdx = Math.max(0, stepCount - 1);

  return (
    <div className="flex-shrink-0 flex items-center gap-2 px-2 py-1 border-b bg-muted/30">
      {/* Range checkbox + popover icon */}
      <div className="flex items-center gap-0.5 shrink-0">
        <input
          type="checkbox"
          checked={rangeEnabled}
          onChange={(ev) => setRangeEnabled(ev.target.checked)}
          className="h-3 w-3 rounded border cursor-pointer accent-primary"
          title="Enable range playback"
        />
        <Popover open={popoverOpen} onOpenChange={rangeEnabled ? setPopoverOpen : undefined}>
          <PopoverTrigger asChild>
            <Scissors
              className={`h-3 w-3 transition-colors ${rangeEnabled ? "text-primary cursor-pointer hover:text-primary/70" : "text-muted-foreground/30 cursor-not-allowed pointer-events-none"}`}
            />
          </PopoverTrigger>
          <PopoverContent className="w-56 p-3 space-y-2" side="bottom" align="start">
            <p className="text-[11px] font-medium text-muted-foreground">Playback Range (1-based)</p>
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-muted-foreground w-8">Start</label>
              <input
                type="number"
                min={1}
                max={stepCount}
                value={rangeStartInput}
                onChange={(e) => setRangeStartInput(e.target.value)}
                onBlur={commitRangeInput}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className="flex-1 h-6 px-1.5 text-[11px] font-mono rounded border border-input bg-background text-center focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-muted-foreground w-8">End</label>
              <input
                type="number"
                min={1}
                max={stepCount}
                value={rangeEndInput}
                onChange={(e) => setRangeEndInput(e.target.value)}
                onBlur={commitRangeInput}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className="flex-1 h-6 px-1.5 text-[11px] font-mono rounded border border-input bg-background text-center focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Slider；多笔圆点 absolute 叠在滑条下方，不占布局高度 */}
      <div ref={sliderWrapRef} className="relative min-w-[80px] flex-1 overflow-visible">
        {rangeEnabled ? (
          <Slider
            className="relative z-0 w-full [&_[data-index='0']]:h-2.5 [&_[data-index='0']]:w-2.5 [&_[data-index='0']]:border-orange-400 [&_[data-index='2']]:h-2.5 [&_[data-index='2']]:w-2.5 [&_[data-index='2']]:border-orange-400 [&_[data-index='1']]:z-10"
            min={0}
            max={maxIdx}
            step={1}
            minStepsBetweenThumbs={0}
            value={[rangeStart, displayValue, rangeEnd]}
            onValueChange={handleRangeSliderChange}
            onValueCommit={handleRangeSliderCommit}
            onThumbPointerDown={(i) => { activeThumbRef.current = i; }}
          />
        ) : (
          <Slider
            className="relative z-0 w-full"
            min={0}
            max={maxIdx}
            step={1}
            value={[displayValue]}
            onValueChange={handleSliderChange}
            onValueCommit={handleSliderCommit}
            disabled={isPlaying}
          />
        )}
        {txJumpDots.length > 0 && (
          <div
            className="pointer-events-none absolute inset-x-0 top-full z-20 mt-0.5 h-3"
            role="group"
            aria-label="Jump to transaction start"
          >
            {txJumpDots.map((d, idx) => (
              <span
                key={`${d.step}-${idx}`}
                role="button"
                tabIndex={0}
                className="pointer-events-auto absolute inline-flex cursor-pointer items-center justify-center outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-full"
                style={txMarkerRowStyle(d.pct)}
                title={d.title}
                aria-label={d.title}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSeekTo(Math.max(0, Math.min(d.step, maxIdx)));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSeekTo(Math.max(0, Math.min(d.step, maxIdx)));
                  }
                }}
              >
                <Circle
                  strokeWidth={0}
                  fill="currentColor"
                  className="h-2 w-2 text-amber-500 pointer-events-none"
                  aria-hidden
                />
              </span>
            ))}
          </div>
        )}
      </div>

      {multiTxLabel && (
        <span className="text-[10px] text-muted-foreground font-mono shrink-0 tabular-nums" title="Multi-tx run: current / total">
          {multiTxLabel}
        </span>
      )}
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
        title={`${playbackSpeed}x speed`}
      />
      <span className="text-[11px] text-muted-foreground w-6 shrink-0">{playbackSpeed}x</span>
    </div>
  );
}
