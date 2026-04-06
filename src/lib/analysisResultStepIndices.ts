/** Keys that denote a global trace step index in analysis JSON output */
const STEP_INDEX_KEYS = new Set([
  "stepIndex",
  "step_index",
  "globalStep",
  "global_step",
]);

function walkForStepIndices(obj: unknown, out: Set<number>): void {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (const x of obj) walkForStepIndices(x, out);
    return;
  }
  if (typeof obj !== "object") return;
  const record = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(record)) {
    if (STEP_INDEX_KEYS.has(k) && typeof v === "number" && Number.isFinite(v)) {
      out.add(Math.trunc(v));
    }
    walkForStepIndices(v, out);
  }
}

/**
 * Collect unique global step indices from an analysis result string (JSON or text containing JSON-like keys).
 */
export function extractStepIndicesFromAnalysisResult(result: string): number[] {
  const out = new Set<number>();
  const s = result.trim();
  if (!s) return [];

  try {
    walkForStepIndices(JSON.parse(s), out);
  } catch {
    /* non-JSON: use regex below */
  }

  if (out.size === 0) {
    const re =
      /"(?:stepIndex|step_index|globalStep|global_step)"\s*:\s*(-?\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(result)) !== null) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) out.add(n);
    }
  }

  return [...out].sort((a, b) => a - b);
}
