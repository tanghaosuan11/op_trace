export interface SourceLocation {
  start: number; // byte offset in source file
  length: number; // byte length (0 = position only, no span)
  fileIndex: number; // -1 = no source mapping
  jump: string;
}


export function parseSourceMap(raw: string): SourceLocation[] {
  const entries: SourceLocation[] = [];
  let prevS = 0,
    prevL = 0,
    prevF = -1,
    prevJ = "-";

  for (const part of raw.split(";")) {
    if (part === "") {
      entries.push({
        start: prevS,
        length: prevL,
        fileIndex: prevF,
        jump: prevJ,
      });
      continue;
    }
    const fields = part.split(":");
    const sRaw = fields[0] !== "" ? parseInt(fields[0], 10) : NaN;
    const lRaw = fields[1] !== "" ? parseInt(fields[1], 10) : NaN;
    const fRaw = fields[2] !== "" ? parseInt(fields[2], 10) : NaN;
    const jRaw = fields.length > 3 && fields[3] !== "" ? fields[3] : "";

    const s = Number.isFinite(sRaw) ? sRaw : prevS;
    const l = Number.isFinite(lRaw) ? lRaw : prevL;
    const f = Number.isFinite(fRaw) ? fRaw : prevF;
    const j = jRaw !== "" ? jRaw : prevJ;

    entries.push({ start: s, length: l, fileIndex: f, jump: j });
    prevS = s;
    prevL = l;
    prevF = f;
    prevJ = j;
  }

  return entries;
}

export function buildPcMap(
  opcodes: readonly { pc: number }[],
): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < opcodes.length; i++) {
    map.set(opcodes[i].pc, i);
  }
  return map;
}


export function byteOffsetToCharOffset(
  content: string,
  byteOffset: number,
): number {
  let bytePos = 0;
  let charPos = 0;
  while (bytePos < byteOffset && charPos < content.length) {
    const cp = content.codePointAt(charPos)!;
    if (cp < 0x80) {
      bytePos += 1;
      charPos += 1;
    } else if (cp < 0x800) {
      bytePos += 2;
      charPos += 1;
    } else if (cp < 0x10000) {
      bytePos += 3;
      charPos += 1;
    } else {
      bytePos += 4;
      charPos += 2;
    } // surrogate pair
  }
  return charPos;
}

export function extractRuntimeSourceMap(root: unknown): string | null {
  if (!root || typeof root !== "object") return null;
  const o = root as Record<string, unknown>;

  const tryExtract = (r: Record<string, unknown>): string | null => {
    const rb = r.runtimeBytecode as Record<string, unknown> | undefined;
    if (typeof rb?.sourceMap === "string") return rb.sourceMap as string;
    return null;
  };

  const direct = tryExtract(o);
  if (direct) return direct;

  for (const key of ["runtimeMatch", "creationMatch", "match"] as const) {
    const m = o[key];
    if (m && typeof m === "object") {
      const r = tryExtract(m as Record<string, unknown>);
      if (r) return r;
    }
  }
  return null;
}


export function extractSourceList(
  root: unknown,
  sources: Record<string, unknown>,
): string[] {
  if (!root || typeof root !== "object") return Object.keys(sources);
  const o = root as Record<string, unknown>;

  // ── Priority 1: root.sourceIds (Sourcify v2: { "path/file.sol": { id: N }, ... }) ──
  const sourceIds = o.sourceIds;
  if (sourceIds && typeof sourceIds === "object" && !Array.isArray(sourceIds)) {
    const entries: [string, number][] = [];
    for (const [path, val] of Object.entries(
      sourceIds as Record<string, unknown>,
    )) {
      if (typeof val === "number") {
        entries.push([path, val]);
      } else if (
        val &&
        typeof val === "object" &&
        typeof (val as Record<string, unknown>).id === "number"
      ) {
        entries.push([path, (val as Record<string, unknown>).id as number]);
      }
    }
    if (entries.length > 0) {
      const arr: string[] = [];
      for (const [path, id] of entries) {
        arr[id] = path;
      }
      return arr;
    }
  }

  const tryGetCS = (
    r: Record<string, unknown>,
  ): Record<string, { id?: number }> | null => {
    const c = r.compilation as Record<string, unknown> | undefined;
    if (
      c &&
      typeof c.sources === "object" &&
      c.sources !== null &&
      !Array.isArray(c.sources)
    ) {
      return c.sources as Record<string, { id?: number }>;
    }
    return null;
  };

  let cs = tryGetCS(o);
  if (!cs) {
    for (const key of ["runtimeMatch", "creationMatch", "match"] as const) {
      const m = o[key];
      if (m && typeof m === "object" && !Array.isArray(m)) {
        cs = tryGetCS(m as Record<string, unknown>);
        if (cs) break;
      }
    }
  }

  if (cs) {
    const entries = Object.entries(cs).filter(
      ([, v]) => typeof v?.id === "number",
    );
    if (entries.length > 0) {
      return entries
        .sort((a, b) => (a[1].id as number) - (b[1].id as number))
        .map(([k]) => k);
    }
  }

  return Object.keys(sources);
}
