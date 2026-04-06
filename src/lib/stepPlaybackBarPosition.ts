const STORAGE_KEY = "optrace-step-playback-bar-pos";

export type StepPlaybackBarPos = { left: number; top: number };

export function loadStepPlaybackBarPos(): StepPlaybackBarPos | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as StepPlaybackBarPos;
    if (typeof p.left !== "number" || typeof p.top !== "number") return null;
    return p;
  } catch {
    return null;
  }
}

export function saveStepPlaybackBarPos(p: StepPlaybackBarPos): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** 默认：底部居中，贴近视频控制条习惯位置 */
export function defaultStepPlaybackBarPos(
  barWidth: number,
  barHeight: number,
): StepPlaybackBarPos {
  const w = typeof window !== "undefined" ? window.innerWidth : 1200;
  const h = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.max(8, (w - barWidth) / 2);
  const top = Math.max(8, h - barHeight - 20);
  return { left, top };
}

export function clampStepPlaybackBarPos(
  left: number,
  top: number,
  barWidth: number,
  barHeight: number,
  margin = 8,
): StepPlaybackBarPos {
  const w = typeof window !== "undefined" ? window.innerWidth : 1200;
  const h = typeof window !== "undefined" ? window.innerHeight : 800;
  return {
    left: Math.min(Math.max(margin, left), Math.max(margin, w - barWidth - margin)),
    top: Math.min(Math.max(margin, top), Math.max(margin, h - barHeight - margin)),
  };
}
