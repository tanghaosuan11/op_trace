/**
 * CFG → Graphviz DOT for `@hpcc-js/wasm/graphviz` (`layout(dot, "svg", "dot")`).
 * Styling lives here for instant Vite HMR.
 *
 * **Node size (adaptive width):** Graphviz recommends `shape=plain` for HTML labels:
 * it enforces `width=0 height=0 margin=0` so the node bounding box is **entirely
 * determined by the label** (otherwise margin/width can inflate the box). See:
 * https://graphviz.org/doc/info/shapes.html#html
 *
 * Block body: only `opcodeLines` from backend (each line already `0x{pc} …`). No extra
 * header lines in the node — PC range / hit stats removed from the label.
 */

const VIRTUAL_START_PC = 0xffff_ffff;

/** Node label metrics — keep CfgWindow.tsx Pixi margins/font in sync. */
export const CFG_DOT_NODE = {
  fontSize: 6,
  /** Graphviz `margin` x,y in inches (horizontal, vertical padding inside box). */
  marginXIn: 0.032,
  marginYIn: 0.018,
} as const;

/**
 * When false (default): edges have no exec-seq labels in DOT, so layout does not
 * reserve space for them; Pixi/SVG UIs also hide edge seq text. Set true to show.
 */
export const CFG_SHOW_EDGE_EXEC_SEQ = false;

export interface CfgBlockForDot {
  id: string;
  startPc: number;
  endPc: number;
  opcodeLines: string[];
  hitCount: number;
  firstEnterSeq: number;
  lastEnterSeq: number;
}

export interface CfgEdgeForDot {
  source: string;
  target: string;
  firstSeq: number;
  /** All step seqs when this edge was taken (loops); drives multi-label like `#37 #44`. */
  transitionSeqs?: number[];
  isBackEdge: boolean;
}

export interface CfgResultForDot {
  blocks: CfgBlockForDot[];
  edges: CfgEdgeForDot[];
}

/**
 * Escape a string for use inside a Graphviz double-quoted label.
 * `\l` = left-align line break (Graphviz native).
 */
function dotEscapeLabel(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\l";
    else if (ch === "\r") out += "";
    else if (ch === "{") out += "\\{";
    else if (ch === "}") out += "\\}";
    else if (ch === "|") out += "\\|";
    else if (ch === "<") out += "\\<";
    else if (ch === ">") out += "\\>";
    else out += ch;
  }
  return out;
}

function dotQuoteId(id: string): string {
  let out = "";
  for (const ch of id) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else out += ch;
  }
  return `"${out}"`;
}

/**
 * Build a native DOT `label="…\l"` string for a block.
 *
 * Uses `shape=box` + `fontname="Courier"` at graph level so Graphviz uses its
 * built-in Courier glyph metrics — identical to what it measures for sizing.
 * This is why edotor uses plain text labels instead of HTML tables.
 */
function blockLabel(b: CfgBlockForDot): string {
  // Join with \l only between lines — a trailing \l makes Graphviz add an extra empty row (taller box).
  const body = b.opcodeLines.map((l) => dotEscapeLabel(l)).join("\\l");
  return `"${body}"`;
}

export function cfgResultToDot(r: CfgResultForDot): string {
  const { fontSize, marginXIn, marginYIn } = CFG_DOT_NODE;
  const marginStr = `${marginXIn},${marginYIn}`;
  const lines: string[] = [
    "digraph CFG {",
    "  rankdir=TB;",
    '  graph [bgcolor="transparent", ranksep=0.24, nodesep=0.14];',
    // Courier: Graphviz ships built-in metrics for it → accurate width measurement
    // height=0.001: override Graphviz default min-height (0.5in) so small blocks shrink to their content
    `  node [shape=box, fontname="Courier", fontsize=${fontSize}, margin="${marginStr}", height=0.001, style=filled, fillcolor="#ffffff", color="#262626", penwidth=0.65];`,
    `  edge [fontname="Courier", fontsize=${fontSize}, color="#374151", fontcolor="#374151", penwidth=0.4, arrowsize=0.32];`,
  ];

  for (const b of r.blocks) {
    const id = dotQuoteId(b.id);
    const label = blockLabel(b);
    if (b.startPc === VIRTUAL_START_PC) {
      lines.push(`  ${id} [label=${label}, fillcolor="#fffafa", color="#dc2626"];`);
    } else {
      lines.push(`  ${id} [label=${label}];`);
    }
  }

  for (const e of r.edges) {
    const src = dotQuoteId(e.source);
    const tgt = dotQuoteId(e.target);
    if (!CFG_SHOW_EDGE_EXEC_SEQ) {
      if (e.isBackEdge) {
        lines.push(
          `  ${src} -> ${tgt} [color="#374151", fontcolor="#374151", penwidth=0.6, style=dashed];`,
        );
      } else {
        lines.push(`  ${src} -> ${tgt};`);
      }
      continue;
    }
    const seqs =
      e.transitionSeqs && e.transitionSeqs.length > 0
        ? [...e.transitionSeqs].sort((a, b) => a - b)
        : e.firstSeq > 0
          ? [e.firstSeq]
          : [];
    const el = dotEscapeLabel(seqs.map((n) => `#${n}`).join(" "));
    if (e.isBackEdge) {
      lines.push(`  ${src} -> ${tgt} [label="${el}", color="#374151", fontcolor="#374151", penwidth=0.6, style=dashed];`);
    } else {
      lines.push(`  ${src} -> ${tgt} [label="${el}"];`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}
