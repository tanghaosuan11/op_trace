import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Fuel, Home, Lock, SlidersHorizontal, Unlock } from "lucide-react";import {
  Application,
  BitmapFontManager,
  BitmapText,
  Container,
  Graphics,
  TextStyle,
  type ApplicationOptions,
} from "pixi.js";
import type { CfgCurrentStepPayload } from "@/lib/cfgBridge";
import {
  emitCrossCfgSeqCommit,
  globalStepToSeqStep,
  listenCrossMainStep,
  makeCfgFrameKey,
  type CrossMainStepPayload,
} from "@/lib/cfgBridge";
import { cfgResultToDot, CFG_DOT_NODE, CFG_SHOW_EDGE_EXEC_SEQ } from "@/lib/cfgDot";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DecompileDialog } from "@/components/DecompileDialog";

interface CfgWindowProps {
  sessionId: string;
  /** 预聚合帧列表：按 (tx,ctx) 去重并附带步数 */
  frames: { key: FrameKey; count: number }[];
}

type FrameKey = string;

const VIRTUAL_START_PC = 0xffff_ffff;
const ONLY_EXECUTED = true;
/** 统一高亮样式（琥珀色） */
const CFG_TRACE_HL = { color: 0xf59e0b as const, strokeW: 1 };

/** URL 带 `?cfgDebug=1` 时输出同步日志 */
function cfgSyncDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return new URLSearchParams(window.location.search).get("cfgDebug") === "1";
  } catch {
    return false;
  }
}
function cfgSyncLog(...args: unknown[]) {
  if (!cfgSyncDebugEnabled()) return;
  console.log("[cfg-sync]", ...args);
}

const WHEEL_PAN_FACTOR = 0.85;
const WHEEL_ZOOM_SENS  = 0.002;
/** 键盘缩放使用的模拟滚轮 delta（l/h） */
const KEY_ZOOM_DELTA = 80;
const MIN_SCALE        = 0.08;
const MAX_SCALE        = 5;
/** LOD 滞回阈值：小于 HIDE 隐藏，大于 SHOW 显示 */
const LOD_TEXT_HIDE = 0.17;
const LOD_TEXT_SHOW = 0.21;
/** 文本栅格分辨率 */
function textRenderResolution(): number {
  if (typeof window === "undefined") return 2;
  return Math.min(3, Math.max(1.5, window.devicePixelRatio * 1.75));
}

/** Graphviz 英寸单位转像素 */
const PX_PER_IN = 96;
/** 节点圆角 */
const NODE_RADIUS = 3;
/** 箭头半宽与长度 */
const ARROW_W = 4;
const ARROW_L = 7;
/** 文本样式（需与 cfgDot.ts 的字号一致） */
const FONT_FAMILY = "Courier New, Courier, monospace";
const FONT_SIZE = CFG_DOT_NODE.fontSize;
/** BitmapFont 图集名 */
const CFG_BITMAP_FONT = "cfg-opcode";
/** Graphviz margin 对应像素值 */
const MARGIN_H_PX = CFG_DOT_NODE.marginXIn * PX_PER_IN;
const MARGIN_V_PX = CFG_DOT_NODE.marginYIn * PX_PER_IN;

interface CfgBlock {
  id: string;
  startPc: number;
  endPc: number;
  opcodeLines: string[];
  executed: boolean;
  hitCount: number;
  firstEnterSeq: number;
  lastEnterSeq: number;
}

interface CfgEdge {
  id: string;
  source: string;
  target: string;
  executed: boolean;
  hitCount: number;
  firstSeq: number;
  transitionSeqs?: number[];
  isBackEdge: boolean;
}

interface CfgMeta {
  onlyExecuted: boolean;
  unmappedPcs: number[];
  exitKind: string;
}

interface CfgResult {
  transactionId: number;
  contextId: number;
  blocks: CfgBlock[];
  edges: CfgEdge[];
  /** trace 进入块顺序（与 edge seq 对齐） */
  blockEntryTrace?: string[];
  /** 每次进入块对应的全局 step 下标 */
  blockEntryGlobalStepIndices?: number[];
  /** 每次进入块对应的 gas 总量 */
  blockVisitGasTotals?: number[];
  meta: CfgMeta;
}

interface PlainNode {
  /** DOT 节点名（即 CfgBlock.id） */
  name: string;
  /** 节点中心 x（像素） */
  cx: number;
  /** 节点中心 y（像素，Y 已翻转） */
  cy: number;
  /** 节点宽（像素） */
  w: number;
  /** 节点高（像素） */
  h: number;
}

interface PlainEdge {
  from: string;
  to: string;
  /** 贝塞尔点序列：[x0,y0, x1,y1, ...] */
  pts: number[];
  isDashed: boolean;
  color: number; // 十六进制颜色值
  /** 边标签（无则空字符串） */
  label: string;
  /** 标签中心 x（无标签时 NaN） */
  labelX: number;
  /** 标签中心 y（无标签时 NaN） */
  labelY: number;
}

interface PlainGraph {
  width: number;
  height: number;
  nodes: PlainNode[];
  edges: PlainEdge[];
}

/** 解析 plain 输出单行（保留双引号内容） */
function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let t = "";
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\" && j + 1 < line.length) { j++; t += line[j]; }
        else t += line[j];
        j++;
      }
      tokens.push(t);
      i = j + 1;
    } else {
      let j = i;
      while (j < line.length && line[j] !== " " && line[j] !== "\t") j++;
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

function parsePlain(plain: string): PlainGraph {
  const result: PlainGraph = { width: 0, height: 0, nodes: [], edges: [] };
  let graphH = 0;

  for (const rawLine of plain.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const t = tokenizeLine(line);
    if (t.length === 0) continue;

    if (t[0] === "graph") {
      // graph: scale width height
      result.width  = parseFloat(t[2]) * PX_PER_IN;
      result.height = parseFloat(t[3]) * PX_PER_IN;
      graphH = parseFloat(t[3]);
      continue;
    }

    if (t[0] === "node") {
      // node: name cx cy width height label style shape color fillcolor
      const name = t[1];
      const cx = parseFloat(t[2]) * PX_PER_IN;
      const cy = (graphH - parseFloat(t[3])) * PX_PER_IN; // Y 轴翻转
      const w  = parseFloat(t[4]) * PX_PER_IN;
      const h  = parseFloat(t[5]) * PX_PER_IN;
      result.nodes.push({ name, cx, cy, w, h });
      continue;
    }

    if (t[0] === "edge") {
      // edge: tail head n x1 y1 ... [label lx ly] style color
      const from = t[1];
      const to   = t[2];
      const n    = parseInt(t[3], 10);
      const pts: number[] = [];
      for (let k = 0; k < n; k++) {
        const px = parseFloat(t[4 + k * 2])     * PX_PER_IN;
        const py = (graphH - parseFloat(t[5 + k * 2])) * PX_PER_IN; // Y 轴翻转
        pts.push(px, py);
      }
      // n*2 坐标后：可选 label/lx/ly，再跟 style/color
      const afterPts = 4 + n * 2;
      // remaining >= 5 视为包含 label
      const remaining = t.length - afterPts;
      const hasLabel = remaining >= 5;
      const label  = hasLabel ? t[afterPts] : "";
      const labelX = hasLabel ? parseFloat(t[afterPts + 1]) * PX_PER_IN : NaN;
      const labelY = hasLabel ? (graphH - parseFloat(t[afterPts + 2])) * PX_PER_IN : NaN;
      // style/color 在末尾两个 token
      const styleStr = t[t.length - 2] ?? "solid";
      const colorStr = t[t.length - 1] ?? "#374151";
      const isDashed = styleStr === "dashed";
      // 解析颜色："#374151" -> 0x374151
      const color = parseInt(colorStr.replace("#", ""), 16) || 0x374151;
      result.edges.push({ from, to, pts, isDashed, color, label, labelX, labelY });
      continue;
    }
    // 其他行（如 stop）忽略
  }

  return result;
}

let _worker: Worker | null = null;
let _reqCounter = 0;
const _pending = new Map<string, { resolve: (plain: string) => void; reject: (e: Error) => void }>();

function getLayoutWorker(): Worker {
  if (!_worker) {
    _worker = new Worker(new URL("../lib/cfgLayoutWorkerPlain.ts", import.meta.url), { type: "module" });
    _worker.onmessage = (e: MessageEvent<{ id: string; plain?: string; error?: string }>) => {
      const { id, plain, error } = e.data;
      const cb = _pending.get(id);
      if (!cb) return;
      _pending.delete(id);
      if (error) cb.reject(new Error(error));
      else cb.resolve(plain ?? "");
    };
    _worker.onerror = (e) => {
      for (const { reject } of _pending.values()) reject(new Error(e.message ?? "worker error"));
      _pending.clear();
      _worker = null;
    };
  }
  return _worker;
}

function layoutInWorker(dot: string): { promise: Promise<string>; id: string } {
  const id = String(++_reqCounter);
  const promise = new Promise<string>((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    getLayoutWorker().postMessage({ id, dot });
  });
  return { promise, id };
}

function cancelLayoutRequest(id: string) {
  _pending.delete(id);
}

function pcToBlockId(blocks: CfgBlock[], pc: number): string | null {
  for (const b of blocks) {
    if (b.startPc === VIRTUAL_START_PC) continue;
    if (pc >= b.startPc && pc <= b.endPc) return b.id;
  }
  return null;
}

/** 从 opcode 行里解析 PC */
function parseOpcodeLinePc(line: string): number | null {
  const m = /^0x([0-9a-f]+)\s/i.exec(line.trim());
  if (!m) return null;
  return parseInt(m[1]!, 16);
}

function lineIndexForPcInBlock(block: CfgBlock, pc: number): number {
  for (let i = 0; i < block.opcodeLines.length; i++) {
    const lp = parseOpcodeLinePc(block.opcodeLines[i]!);
    if (lp === pc) return i;
  }
  return -1;
}

function resetBlockOpcodeTextTints(sprite: NodeSprite | undefined) {
  if (!sprite) return;
  for (const t of sprite.texts) t.tint = 0x0a0a0a;
}

/** 高亮指定 PC 对应的 opcode 行 */
function tintOpcodeLineForPc(sprite: NodeSprite | undefined, block: CfgBlock, pc: number) {
  if (!sprite) return;
  resetBlockOpcodeTextTints(sprite);
  const idx = lineIndexForPcInBlock(block, pc);
  if (idx >= 0 && idx < sprite.texts.length) {
    sprite.texts[idx]!.tint = 0x1d4ed8;
  }
}

function pickTransitionEdge(edges: CfgEdge[], fromId: string, toId: string): CfgEdge | null {
  const cand = edges.filter((e) => e.source === fromId && e.target === toId);
  if (cand.length === 0) return null;
  return cand.find((e) => e.executed) ?? cand[0] ?? null;
}

/** 按 entrySeq 选择 trace 边 */
function pickTraceEdgeByEntrySeq(
  edges: CfgEdge[],
  fromId: string,
  toId: string,
  entrySeq: number,
): CfgEdge | null {
  const cand = edges.filter((e) => e.source === fromId && e.target === toId);
  if (cand.length === 0) return null;
  const hit = cand.find((e) => e.transitionSeqs?.includes(entrySeq));
  if (hit) return hit;
  return cand.find((e) => e.executed) ?? cand[0] ?? null;
}

function parseFrameKey(key: FrameKey): { transactionId: number; contextId: number } {
  const [tx, ctx] = key.split(":");
  return { transactionId: Number(tx), contextId: Number(ctx) };
}

function cssHexToInt(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

interface NodeSprite {
  container: Container;
  box: Graphics;
  texts: BitmapText[];
  blockId: string;
}

interface EdgeSprite {
  gfx: Graphics;
  from: string;
  to: string;
  isDashed: boolean;
  baseColor: number;
  pts: number[];
}

interface RenderedGraph {
  graphContainer: Container;
  textLayer: Container;
  nodes: Map<string, NodeSprite>;
  edges: EdgeSprite[];
}

/** 逗号分隔的 seq 列表 */
function formatEdgeSeqFullLine(seqs: number[]): string {
  if (seqs.length === 0) return "";
  return seqs.map((n) => String(n)).join(",");
}

/** 在贝塞尔曲线上按 t 采样一点 */
function sampleBezierSpline(pts: number[], t: number): [number, number] {
  const nSegs = Math.floor((pts.length / 2 - 1) / 3);
  if (nSegs < 1) return [pts[0] ?? 0, pts[1] ?? 0];
  const segT    = t * nSegs;
  const segIdx  = Math.min(Math.floor(segT), nSegs - 1);
  const lt      = segT - segIdx;
  const base    = segIdx * 6;
  const p0x = pts[base],     p0y = pts[base + 1];
  const p1x = pts[base + 2], p1y = pts[base + 3];
  const p2x = pts[base + 4], p2y = pts[base + 5];
  const p3x = pts[base + 6], p3y = pts[base + 7];
  const mt = 1 - lt;
  return [
    mt*mt*mt*p0x + 3*mt*mt*lt*p1x + 3*mt*lt*lt*p2x + lt*lt*lt*p3x,
    mt*mt*mt*p0y + 3*mt*mt*lt*p1y + 3*mt*lt*lt*p2y + lt*lt*lt*p3y,
  ];
}

/** 找到边标签放置点（尽量靠近中点且避开节点） */
function findEdgeLabelPos(pts: number[], nodes: PlainNode[]): { x: number; y: number } {
  const nSegs = Math.floor((pts.length / 2 - 1) / 3);
  if (nSegs < 1 || pts.length < 4) return { x: pts[0] ?? 0, y: pts[1] ?? 0 };

  const PAD     = 3;  // 节点边框外扩像素
  const SAMPLES = 48;
  const candidates: Array<{ x: number; y: number; t: number }> = [];

  for (let i = 0; i <= SAMPLES; i++) {
    // 跳过端点，通常端点在节点内部
    const t = 0.04 + (i / SAMPLES) * 0.92;
    const [x, y] = sampleBezierSpline(pts, t);
    const blocked = nodes.some(
      (n) =>
        x >= n.cx - n.w / 2 - PAD && x <= n.cx + n.w / 2 + PAD &&
        y >= n.cy - n.h / 2 - PAD && y <= n.cy + n.h / 2 + PAD,
    );
    if (!blocked) candidates.push({ x, y, t });
  }

  if (candidates.length === 0) {
    // 退化情况：极短自环，直接用曲线中点
    const [x, y] = sampleBezierSpline(pts, 0.5);
    return { x, y };
  }

  // 在候选点里取最接近中点的
  return candidates.reduce((best, c) =>
    Math.abs(c.t - 0.5) < Math.abs(best.t - 0.5) ? c : best,
  );
}

/** 绘制节点框 */
function drawNodeBox(g: Graphics, w: number, h: number, fill: number, stroke: number, strokeW: number) {
  g.clear();
  g.roundRect(-w / 2, -h / 2, w, h, NODE_RADIUS);
  g.fill({ color: fill });
  g.stroke({ color: stroke, width: strokeW });
}

/** 绘制边：贝塞尔路径 + 箭头 */
function drawEdge(g: Graphics, pts: number[], color: number, strokeW: number, isDashed: boolean) {
  g.clear();
  if (pts.length < 2) return;

  // 画贝塞尔路径
  const alpha = isDashed ? 0.65 : 1;
  g.moveTo(pts[0], pts[1]);
  for (let k = 2; k + 5 < pts.length; k += 6) {
    g.bezierCurveTo(pts[k], pts[k + 1], pts[k + 2], pts[k + 3], pts[k + 4], pts[k + 5]);
  }
  // 若还有剩余点对，按直线段补画
  const fullSegs = Math.floor((pts.length / 2 - 1) / 3);
  const usedPts = 1 + fullSegs * 3; // 已消费的点数
  if (usedPts * 2 < pts.length) {
    // 剩余部分按线段绘制
    for (let k = usedPts * 2; k + 1 < pts.length; k += 2) {
      g.lineTo(pts[k], pts[k + 1]);
    }
  }
  g.stroke({ color, width: strokeW, alpha });

  // 箭头：末段方向上的三角形
  const n = pts.length;
  const ex = pts[n - 2];
  const ey = pts[n - 1];
  let dx: number, dy: number;
  if (n >= 4) {
    dx = ex - pts[n - 4];
    dy = ey - pts[n - 3];
  } else {
    return;
  }
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return;
  const ux = dx / len;
  const uy = dy / len;
  // 法向量
  const px = -uy;
  const py = ux;
  g.moveTo(ex, ey);
  g.lineTo(ex - ux * ARROW_L + px * ARROW_W, ey - uy * ARROW_L + py * ARROW_W);
  g.lineTo(ex - ux * ARROW_L - px * ARROW_W, ey - uy * ARROW_L - py * ARROW_W);
  g.fill({ color, alpha });
}

/** 为解析后的图构建完整 Pixi 场景 */
function buildScene(app: Application, parsed: PlainGraph, cfgData: CfgResult): RenderedGraph {
  const graphContainer = new Container();
  app.stage.addChild(graphContainer);

  const blockById = new Map<string, CfgBlock>(cfgData.blocks.map((b) => [b.id, b]));
  const nodes = new Map<string, NodeSprite>();
  const edges: EdgeSprite[] = [];

  // 图层顺序：边 -> 节点框 -> 文本
  const edgeLayer = new Container();
  graphContainer.addChild(edgeLayer);

  for (const pe of parsed.edges) {
    const cfgEdge = cfgData.edges.find((e) => e.source === pe.from && e.target === pe.to);
    const isDashed = pe.isDashed || (cfgEdge?.isBackEdge ?? false);
    const color = pe.color;
    const gfx = new Graphics();
    drawEdge(gfx, pe.pts, color, 1, isDashed);
    edgeLayer.addChild(gfx);
    edges.push({ gfx, from: pe.from, to: pe.to, isDashed, baseColor: color, pts: pe.pts });
  }

  // 节点框层（在边之上）
  const nodeLayer = new Container();
  graphContainer.addChild(nodeLayer);

  // 文本层（最上层）
  const textLayer = new Container();
  graphContainer.addChild(textLayer);

  for (const pn of parsed.nodes) {
    const block = blockById.get(pn.name);
    const isVirtual = block ? block.startPc === VIRTUAL_START_PC : false;
    const fillColor  = isVirtual ? cssHexToInt("#fffafa") : cssHexToInt("#ffffff");
    const strokeColor = isVirtual ? cssHexToInt("#dc2626") : cssHexToInt("#262626");

    const nodeContainer = new Container();
    nodeContainer.x = pn.cx;
    nodeContainer.y = pn.cy;

    const box = new Graphics();
    drawNodeBox(box, pn.w, pn.h, fillColor, strokeColor, 0.8);
    nodeContainer.addChild(box);
    nodeLayer.addChild(nodeContainer);

    // 文本行填满 Graphviz 标签区；BitmapText 复用共享图集
    const textItems: BitmapText[] = [];
    if (block && block.opcodeLines.length > 0) {
      const innerW = Math.max(2, pn.w - 2 * MARGIN_H_PX);
      const nLines = block.opcodeLines.length;
      const innerH = Math.max(FONT_SIZE, pn.h - 2 * MARGIN_V_PX);
      const lineStep = innerH / nLines;
      let ty = pn.cy - pn.h / 2 + MARGIN_V_PX;
      for (const line of block.opcodeLines) {
        const txt = new BitmapText({ text: line, style: { fontFamily: CFG_BITMAP_FONT, fontSize: FONT_SIZE } });
        txt.tint = 0x0a0a0a;
        txt.x = pn.cx - innerW / 2;
        txt.y = ty;
        textLayer.addChild(txt);
        textItems.push(txt);
        ty += lineStep;
      }
    }
    nodeContainer.cullable = true;
    nodes.set(pn.name, { container: nodeContainer, box, texts: textItems, blockId: pn.name });
  }

  // 边执行序号标签（仅 CFG_SHOW_EDGE_EXEC_SEQ=true）
  if (CFG_SHOW_EDGE_EXEC_SEQ) {
    for (const pe of parsed.edges) {
      const cfgEdge = cfgData.edges.find((e) => e.source === pe.from && e.target === pe.to);
      if (!cfgEdge) continue;
      const seqs: number[] =
        cfgEdge.transitionSeqs && cfgEdge.transitionSeqs.length > 0
          ? [...cfgEdge.transitionSeqs]
          : cfgEdge.firstSeq > 0
            ? [cfgEdge.firstSeq]
            : [];
      if (seqs.length === 0) continue;
      const labelText = formatEdgeSeqFullLine(seqs);
      const pos = findEdgeLabelPos(pe.pts, parsed.nodes);

      const pad = 1.5;
      const estW = labelText.length * FONT_SIZE * 0.62 + pad * 2;
      const estH = FONT_SIZE + pad * 2;
      const bg = new Graphics();
      bg.roundRect(-estW / 2, -estH / 2, estW, estH, 1.5);
      bg.fill({ color: 0xffffff, alpha: 0.85 });
      bg.x = pos.x;
      bg.y = pos.y;
      textLayer.addChild(bg);

      const lbl = new BitmapText({ text: labelText, style: { fontFamily: CFG_BITMAP_FONT, fontSize: FONT_SIZE } });
      lbl.tint = 0x0a0a0a;
      lbl.anchor.set(0.5, 0.5);
      lbl.x = pos.x;
      lbl.y = pos.y;
      textLayer.addChild(lbl);
    }
  }

  return { graphContainer, textLayer, nodes, edges };
}

/** 应用节点高亮（覆盖描边颜色） */
function highlightNode(sprite: NodeSprite | undefined, pn: PlainNode | undefined, strokeColor: number, strokeW: number) {
  if (!sprite || !pn) return;
  drawNodeBox(sprite.box, pn.w, pn.h, cssHexToInt("#ffffff"), strokeColor, strokeW);
}

function clearNodeHighlight(sprite: NodeSprite | undefined, pn: PlainNode | undefined, isVirtual: boolean) {
  if (!sprite || !pn) return;
  const fill  = isVirtual ? cssHexToInt("#fffafa") : cssHexToInt("#ffffff");
  const stroke = isVirtual ? cssHexToInt("#dc2626") : cssHexToInt("#262626");
  drawNodeBox(sprite.box, pn.w, pn.h, fill, stroke, 0.8);
}

/** CFG 动画控制器（seq / 主窗口同步 / imperative 共用） */
export class CfgAnimController {
  private rg: RenderedGraph;
  private pg: PlainGraph;
  private cfgData: CfgResult;

  constructor(rg: RenderedGraph, pg: PlainGraph, cfgData: CfgResult) {
    this.rg = rg;
    this.pg = pg;
    this.cfgData = cfgData;
  }

  setEdgeColor(from: string, to: string, color: number, strokeW = 2): void {
    const sp = this.rg.edges.find((e) => e.from === from && e.to === to);
    if (sp) drawEdge(sp.gfx, sp.pts, color, strokeW, sp.isDashed);
  }

  resetEdge(from: string, to: string): void {
    const sp = this.rg.edges.find((e) => e.from === from && e.to === to);
    if (sp) drawEdge(sp.gfx, sp.pts, sp.baseColor, 1, sp.isDashed);
  }

  /** 高亮 trace 边，返回 `from→to` 键 */
  highlightTraceEdge(
    fromId: string,
    toId: string,
    entrySeq: number,
    color: number,
    strokeW: number,
  ): string | null {
    const cfgEdge = pickTraceEdgeByEntrySeq(this.cfgData.edges, fromId, toId, entrySeq);
    if (!cfgEdge) return null;
    const sp = this.rg.edges.find((e) => e.from === cfgEdge.source && e.to === cfgEdge.target);
    if (!sp) return null;
    drawEdge(sp.gfx, sp.pts, color, strokeW, sp.isDashed);
    return `${sp.from}→${sp.to}`;
  }

  /** 高亮静态 CFG 转移边 */
  highlightTransitionEdge(fromId: string, toId: string, color: number, strokeW: number): string | null {
    const cfgEdge = pickTransitionEdge(this.cfgData.edges, fromId, toId);
    if (!cfgEdge) return null;
    const sp = this.rg.edges.find((e) => e.from === cfgEdge.source && e.to === cfgEdge.target);
    if (!sp) return null;
    drawEdge(sp.gfx, sp.pts, color, strokeW, sp.isDashed);
    return `${sp.from}→${sp.to}`;
  }

  setBlockStroke(blockId: string, color: number, strokeW = 2): void {
    const sprite = this.rg.nodes.get(blockId);
    const pn = this.pg.nodes.find((n) => n.name === blockId);
    if (sprite && pn) highlightNode(sprite, pn, color, strokeW);
  }

  resetBlock(blockId: string): void {
    const sprite = this.rg.nodes.get(blockId);
    const pn = this.pg.nodes.find((n) => n.name === blockId);
    const isVirtual = this.cfgData.blocks.find((b) => b.id === blockId)?.startPc === VIRTUAL_START_PC;
    clearNodeHighlight(sprite, pn, isVirtual ?? false);
  }

  tintOpcodeLineForBlockPc(blockId: string, pc: number): void {
    const sprite = this.rg.nodes.get(blockId);
    const block = this.cfgData.blocks.find((b) => b.id === blockId);
    if (!sprite || !block) return;
    tintOpcodeLineForPc(sprite, block, pc);
  }

  resetOpcodeLineTints(blockId: string): void {
    resetBlockOpcodeTextTints(this.rg.nodes.get(blockId));
  }

  setTextColor(blockId: string, color: number): void {
    const sprite = this.rg.nodes.get(blockId);
    if (!sprite) return;
    for (const t of sprite.texts) t.tint = color;
  }

  resetTextColor(blockId: string): void {
    this.setTextColor(blockId, 0x0a0a0a);
  }
}

export function createCfgAnimController(
  rg: RenderedGraph | null,
  pg: PlainGraph | null,
  cfgData: CfgResult | null,
): CfgAnimController | null {
  if (!rg || !pg || !cfgData) return null;
  return new CfgAnimController(rg, pg, cfgData);
}

export interface CfgWindowHandle {
  /** 平移到视口中心（保留缩放） */
  centerInView: () => void;
  /** 缩放并居中以适配视口 */
  fitToView: () => void;
  /** 高亮包含该 PC 的块 */
  highlightPc: (pc: number) => string | null;
  /** 高亮指定块（默认琥珀色） */
  highlightBlock: (blockId: string, opts?: { color?: number; strokeW?: number }) => void;
  /** 清除手动高亮 */
  clearHighlight: () => void;
}

export const CfgWindow = forwardRef<CfgWindowHandle, CfgWindowProps>(function CfgWindow(
  { sessionId, frames },
  ref,
) {
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const appRef        = useRef<Application | null>(null);
  const renderedRef   = useRef<RenderedGraph | null>(null);

  const panRef   = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const dragRef  = useRef<{
    active: boolean; pid: number | null; sx: number; sy: number; ox: number; oy: number;
  }>({ active: false, pid: null, sx: 0, sy: 0, ox: 0, oy: 0 });
  const zoomLockedRef = useRef(false);
  const [zoomLocked, setZoomLockedState] = useState(false);

  const [appReady, setAppReady] = useState(false);
  const [selectedFrame, setSelectedFrame] = useState<FrameKey>("");
  const [cfgData, setCfgData]     = useState<CfgResult | null>(null);
  const [parsedGraph, setParsedGraph] = useState<PlainGraph | null>(null);
  const [loading, setLoading]     = useState(false);
  const [renderErr, setRenderErr] = useState<string | null>(null);
  const [decompileOpen, setDecompileOpen] = useState(false);
  const pendingLayoutId = useRef<string | null>(null);
  /** 首次加载做 fit；后续切帧仅重居中 */
  const cfgFirstGraphFitDoneRef = useRef(false);
  /** LOD 滞回状态 */
  const lodTextVisibleRef = useRef(true);
  const wheelRafRef = useRef<number | null>(null);
  const latestWheelRef = useRef<WheelEvent | null>(null);

  const [playCursor, setPlayCursor] = useState<{
    transactionId: number;
    contextId: number;
    pc: number;
    prevPc?: number;
    /** 主窗口全局步下标，用于 trace 入/出边映射 */
    stepIndex: number;
  } | null>(null);

  const [seqPlayerOpen, setSeqPlayerOpen] = useState(false);
  const [gasDrawerOpen, setGasDrawerOpen] = useState(false);
  const [seqCursor, setSeqCursor] = useState(1);
  const [seqAutoCenter, setSeqAutoCenter] = useState(true);
  const seqCursorRef = useRef(1);
  const emitSeqAfterStepRef = useRef<(seqStep: number) => void>(() => {});
  const pendingSliderCommitRef = useRef(false);
  const seqSliderWrapRef = useRef<HTMLDivElement | null>(null);

  const blocks = cfgData?.blocks ?? [];
  const edges  = cfgData?.edges  ?? [];

  const structureKey = useMemo(
    () => `${blocks.map((b) => b.id).join("\0")}|${edges.map((e) => e.id).join("\0")}`,
    [blocks, edges],
  );
  void structureKey;

  /**
   * Seq player steps: true trace order (every block entry), so step N→N+1 always matches a traced edge.
   * Fallback: legacy first-enter-only order (can skip re-entries → “gaps” vs drawn edges).
   */
  const seqSteps = useMemo(() => {
    const traceIds = cfgData?.blockEntryTrace;
    if (traceIds && traceIds.length > 0) {
      const byId = new Map(blocks.map((b) => [b.id, b]));
      const out: CfgBlock[] = [];
      for (const id of traceIds) {
        const b = byId.get(id);
        if (b) out.push(b);
      }
      return out;
    }
    return blocks
      .filter((b) => b.executed && b.startPc !== VIRTUAL_START_PC && b.firstEnterSeq > 0)
      .sort((a, b) => a.firstEnterSeq - b.firstEnterSeq);
  }, [blocks, cfgData?.blockEntryTrace]);

  /** 按首次出现顺序的 block，并附带该块的 seq/gas 访问记录 */
  const blockGasVisitList = useMemo(() => {
    const trace = cfgData?.blockEntryTrace;
    const gases = cfgData?.blockVisitGasTotals;
    if (!trace?.length || !gases?.length || trace.length !== gases.length) return null;
    const order: string[] = [];
    const seen = new Set<string>();
    for (const id of trace) {
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    const byBlock = new Map<string, { seq: number; gas: number }[]>();
    for (let i = 0; i < trace.length; i++) {
      const id = trace[i]!;
      const seq = i + 1;
      const gas = Number(gases[i] ?? 0);
      let arr = byBlock.get(id);
      if (!arr) {
        arr = [];
        byBlock.set(id, arr);
      }
      arr.push({ seq, gas });
    }
    return { order, byBlock };
  }, [cfgData?.blockEntryTrace, cfgData?.blockVisitGasTotals]);

  const jumpSeqToStep = useCallback(
    (seq: number) => {
      setSeqCursor(seq);
      setSeqPlayerOpen(true);
      if (!sessionId) return;
      const frame = selectedFrame ? parseFrameKey(selectedFrame) : null;
      const indices = cfgData?.blockEntryGlobalStepIndices;
      if (!frame || !indices?.length) return;
      const s = Math.max(1, Math.min(seq, indices.length));
      void emitCrossCfgSeqCommit({
        sessionId,
        transactionId: frame.transactionId,
        contextId: frame.contextId,
        seqStep: s,
        globalStepIndex: indices[s - 1]!,
      });
    },
    [sessionId, selectedFrame, cfgData?.blockEntryGlobalStepIndices],
  );

  const seqCursorSafe = useMemo(() => {
    const n = seqSteps.length;
    if (n === 0) return 1;
    return Math.max(1, Math.min(seqCursor, n));
  }, [seqCursor, seqSteps.length]);

  useEffect(() => {
    seqCursorRef.current = seqCursorSafe;
  }, [seqCursorSafe]);

  emitSeqAfterStepRef.current = (seqStep: number) => {
    if (!sessionId) return;
    const p = selectedFrame ? parseFrameKey(selectedFrame) : null;
    if (!p) return;
    const indices = cfgData?.blockEntryGlobalStepIndices;
    if (!indices || indices.length === 0) return;
    const s = Math.max(1, Math.min(seqStep, indices.length));
    void emitCrossCfgSeqCommit({
      sessionId,
      transactionId: p.transactionId,
      contextId: p.contextId,
      seqStep: s,
      globalStepIndex: indices[s - 1]!,
    });
  };

  useEffect(() => {
    if (!sessionId) return;
    let un: (() => void) | undefined;
    listenCrossMainStep((p: CrossMainStepPayload) => {
      cfgSyncLog("main_step 收到", {
        payload: p,
        cfgSessionId: sessionId || "(empty)",
        selectedFrame: selectedFrame || "(none)",
      });
      if (!p) {
        cfgSyncLog("main_step 丢弃: payload 空");
        return;
      }
      if (!sessionId || p.sessionId !== sessionId) {
        cfgSyncLog("main_step 丢弃: session 不一致", { want: sessionId, got: p.sessionId });
        return;
      }
      if (p.stepIndex < 0) {
        cfgSyncLog("main_step 丢弃: stepIndex < 0");
        return;
      }
      const frame = selectedFrame ? parseFrameKey(selectedFrame) : null;
      if (!frame || frame.transactionId !== p.transactionId || frame.contextId !== p.contextId) {
        cfgSyncLog("main_step 丢弃: 下拉未选中当前帧", {
          mainTxCtx: `${p.transactionId}:${p.contextId}`,
          selectedFrame,
          parsed: frame,
        });
        return;
      }
      const indices = cfgData?.blockEntryGlobalStepIndices;
      const next = globalStepToSeqStep(indices, p.stepIndex);
      cfgSyncLog("main_step → setSeqCursor", {
        stepIndex: p.stepIndex,
        blockEntryIndicesLen: indices?.length ?? 0,
        nextSeq: next,
      });
      setSeqCursor(next);
    })
      .then((u) => {
        un = u;
      })
      .catch(() => {});
    return () => {
      un?.();
    };
  }, [sessionId, selectedFrame, cfgData?.blockEntryGlobalStepIndices]);

  useEffect(() => {
    if (!seqPlayerOpen || seqSteps.length === 0) return;
    const el = seqSliderWrapRef.current;
    if (!el) return;
    const commit = () => {
      if (!pendingSliderCommitRef.current) return;
      pendingSliderCommitRef.current = false;
      emitSeqAfterStepRef.current(seqCursorRef.current);
    };
    el.addEventListener("pointerup", commit);
    el.addEventListener("pointercancel", commit);
    return () => {
      el.removeEventListener("pointerup", commit);
      el.removeEventListener("pointercancel", commit);
    };
  }, [seqPlayerOpen, seqSteps.length]);

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;

    let app: Application;
    let destroyed = false;
    /** 监听容器尺寸变化，补齐 Pixi 在 flex/Tauri 下的 resize */
    let disconnectResizeObserver: (() => void) | null = null;

    (async () => {
      app = new Application();
      await app.init({
        resizeTo: wrap,
        backgroundColor: 0xffffff,
        antialias: true,
        // 稍高于 DPR，缩放后图形和文本更清晰
        resolution: Math.min(2.5, (window.devicePixelRatio || 1) * 1.15),
        autoDensity: true,
      } as Partial<ApplicationOptions>);
      if (destroyed) { app.destroy(true); return; }
      app.canvas.style.display = "block";
      app.canvas.style.width   = "100%";
      app.canvas.style.height  = "100%";
      wrap.appendChild(app.canvas);
      appRef.current = app;
      const ro = new ResizeObserver(() => {
        app.queueResize();
      });
      ro.observe(wrap);
      disconnectResizeObserver = () => {
        ro.disconnect();
        disconnectResizeObserver = null;
      };
      // DynamicBitmapFont 只安装一次，所有帧共享图集
      // BitmapText 创建时不需要逐对象 canvas 栅格化
      BitmapFontManager.install({
        name: CFG_BITMAP_FONT,
        style: new TextStyle({
          fontFamily: FONT_FAMILY,
          fontSize: FONT_SIZE,
          fill: 0xffffff,
          wordWrap: false,
        }),
        resolution: textRenderResolution(),
      });
      setAppReady(true);
    })().catch((err) => console.error("[CfgWindow] pixi init error", err));

    return () => {
      destroyed = true;
      disconnectResizeObserver?.();
      setAppReady(false);
      setTimeout(() => {
        appRef.current?.destroy(true);
        appRef.current = null;
        renderedRef.current = null;
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (!selectedFrame && frames.length > 0) {
      setSelectedFrame(frames[frames.length - 1].key);
      return;
    }
    if (selectedFrame && !frames.some((f) => f.key === selectedFrame)) {
      setSelectedFrame(frames.length > 0 ? frames[frames.length - 1].key : "");
    }
  }, [frames, selectedFrame]);

  const applyTransform = useCallback((x: number, y: number, s: number) => {
    panRef.current   = { x, y };
    scaleRef.current = s;
    const rg = renderedRef.current;
    if (!rg) return;
    rg.graphContainer.x = x;
    rg.graphContainer.y = y;
    rg.graphContainer.scale.set(s);
    // LOD 滞回：仅在阈值外切换，减少闪烁
    if (s < LOD_TEXT_HIDE) lodTextVisibleRef.current = false;
    else if (s > LOD_TEXT_SHOW) lodTextVisibleRef.current = true;
    rg.textLayer.visible = lodTextVisibleRef.current;
  }, []);
  /** 适配到视口 */
  const fitToView = useCallback(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap || !parsedGraph || parsedGraph.width <= 0 || parsedGraph.height <= 0) {
      applyTransform(8, 8, 1);
      return;
    }
    const vpW = wrap.clientWidth;
    const vpH = wrap.clientHeight;
    const k = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(
      (vpW - 16) / parsedGraph.width,
      (vpH - 16) / parsedGraph.height,
      1.2,
    )));
    applyTransform((vpW - parsedGraph.width * k) / 2, (vpH - parsedGraph.height * k) / 2, k);
  }, [parsedGraph, applyTransform]);

  /** 仅居中，不改缩放 */
  const centerGraphInView = useCallback(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap || !parsedGraph || parsedGraph.width <= 0 || parsedGraph.height <= 0) return;
    const s = scaleRef.current;
    const vpW = wrap.clientWidth;
    const vpH = wrap.clientHeight;
    const gw = parsedGraph.width;
    const gh = parsedGraph.height;
    applyTransform((vpW - gw * s) / 2, (vpH - gh * s) / 2, s);
  }, [parsedGraph, applyTransform]);

  /** 围绕视口中心缩放 */
  const zoomAtCenter = useCallback(
    (direction: "in" | "out") => {
      const wrap = canvasWrapRef.current;
      if (!wrap) return;
      const s = scaleRef.current;
      const { x, y } = panRef.current;
      const deltaY = direction === "in" ? -KEY_ZOOM_DELTA : KEY_ZOOM_DELTA;
      const factor = Math.exp(-deltaY * WHEEL_ZOOM_SENS);
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor));
      const mx = wrap.clientWidth / 2;
      const my = wrap.clientHeight / 2;
      const wx = (mx - x) / s;
      const wy = (my - y) / s;
      applyTransform(mx - wx * newScale, my - wy * newScale, newScale);
    },
    [applyTransform],
  );

  /** 将指定块平移到视口中间附近 */
  const centerBlock = useCallback((blockId: string) => {
    const pg = parsedGraph;
    const wrap = canvasWrapRef.current;
    if (!pg || !wrap) return;
    const pn = pg.nodes.find((n) => n.name === blockId);
    if (!pn) return;
    const s = scaleRef.current;
    applyTransform(
      wrap.clientWidth  / 2 - pn.cx * s,
      wrap.clientHeight / 2 - pn.cy * s,
      s,
    );
  }, [parsedGraph, applyTransform]);

  const fetchCfg = useCallback(async () => {
    if (!selectedFrame || !sessionId) {
      setCfgData(null);
      setParsedGraph(null);
      cfgFirstGraphFitDoneRef.current = false;
      return;
    }
    const { transactionId, contextId } = parseFrameKey(selectedFrame);
    setLoading(true);
    setRenderErr(null);
    try {
      const result = await invoke<CfgResult>("build_cfg", {
        transactionId, contextId, onlyExecuted: ONLY_EXECUTED, sessionId,
      });
      setCfgData(result);
      const dot = cfgResultToDot(result);

      if (pendingLayoutId.current) {
        cancelLayoutRequest(pendingLayoutId.current);
        pendingLayoutId.current = null;
      }
      const { promise, id } = layoutInWorker(dot);
      pendingLayoutId.current = id;
      const plain = await promise;
      pendingLayoutId.current = null;

      setParsedGraph(parsePlain(plain));
    } catch (err) {
      console.warn("[CfgWindow] build_cfg / graphviz failed:", err);
      setCfgData(null);
      setParsedGraph(null);
      cfgFirstGraphFitDoneRef.current = false;
      setRenderErr(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedFrame, sessionId]);

  useEffect(() => { void fetchCfg(); }, [fetchCfg]);

  useEffect(() => {
    const app = appRef.current;
    if (!appReady || !app || !parsedGraph || !cfgData) {
      if (appReady && app && (!parsedGraph || !cfgData)) {
        app.stage.removeChildren();
        renderedRef.current = null;
      }
      return;
    }

    app.stage.removeChildren();
    renderedRef.current = null;
    lodTextVisibleRef.current = false;
    const rg = buildScene(app, parsedGraph, cfgData);
    renderedRef.current = rg;
    rg.textLayer.visible = false;

    // 首图执行 fit；切帧保留缩放，仅重居中
    // 放在预热前，确保 applyTransform 拿到真实缩放并更新 LOD 状态
    if (!cfgFirstGraphFitDoneRef.current) {
      fitToView();
      cfgFirstGraphFitDoneRef.current = true;
    } else {
      centerGraphInView();
    }

    // 仅在当前缩放会显示文本时做预热
    // 缩小时（scale < LOD_TEXT_HIDE）直接跳过，避免阻塞当前帧
    if (!lodTextVisibleRef.current) return;
    const rafId = requestAnimationFrame(() => {
      if (renderedRef.current !== rg) return; // RAF 前场景已替换
      rg.textLayer.visible = true;
      app.renderer.render(app.stage);
      // 强制渲染后恢复 LOD 状态
      rg.textLayer.visible = lodTextVisibleRef.current;
    });
    return () => cancelAnimationFrame(rafId);
  }, [parsedGraph, cfgData, appReady, applyTransform, fitToView, centerGraphInView]);

  useEffect(() => {
    const w = getCurrentWindow();
    const unlistenP = w.listen<CfgCurrentStepPayload>("optrace:cfg:current_step", (ev) => {
      const p = ev.payload;
      cfgSyncLog("current_step 收到", { payload: p, cfgSessionId: sessionId || "(empty)" });
      if (!p?.sessionId) {
        cfgSyncLog("current_step 丢弃: payload 无 sessionId");
        return;
      }
      if (sessionId && p.sessionId !== sessionId) {
        cfgSyncLog("current_step 丢弃: session 不一致", { payloadSid: p.sessionId, cfgSid: sessionId });
        return;
      }
      if (!sessionId) {
        cfgSyncLog("current_step 警告: CFG 尚未收到 init，sessionId 为空，仍尝试应用");
      }
      if (p.pc === undefined) {
        cfgSyncLog("current_step: 清除 playCursor（无 pc）");
        setPlayCursor(null);
        return;
      }
      cfgSyncLog("current_step → playCursor", { tx: p.transactionId, ctx: p.contextId, pc: p.pc, stepIndex: p.stepIndex });
      setPlayCursor({
        transactionId: p.transactionId,
        contextId: p.contextId,
        pc: p.pc,
        prevPc: p.prevPc,
        stepIndex: p.stepIndex,
      });
    });
    return () => { unlistenP.then((u) => u()).catch(() => {}); };
  }, [sessionId]);

  /** 主窗口步进高亮状态 */
  const mainHlRef = useRef<{ blockIds: string[]; edgeKeys: string[]; textBlockId: string | null }>({
    blockIds: [],
    edgeKeys: [],
    textBlockId: null,
  });

  /** 主窗口切帧时同步下拉选项 */
  useEffect(() => {
    if (!playCursor) return;
    const key = makeCfgFrameKey(playCursor.transactionId, playCursor.contextId);
    if (frames.length === 0 || !frames.some((f) => f.key === key)) return;
    setSelectedFrame((prev) => (prev === key ? prev : key));
  }, [playCursor, frames]);

  // 手动高亮状态（parsedGraph 变更时清空）
  const manualHlRef = useRef<string[]>([]);
  useEffect(() => { manualHlRef.current = []; }, [parsedGraph]);

  // Seq 播放器高亮状态
  const seqHlRef = useRef<{ blockId: string | null; edgeKeys: string[] }>(
    { blockId: null, edgeKeys: [] },
  );
  // 每次 CFG 数据变化都重置游标为 1
  useEffect(() => { setSeqCursor(1); }, [cfgData]);

  useEffect(() => {
    setSeqCursor((c) =>
      seqSteps.length === 0 ? 1 : Math.max(1, Math.min(c, seqSteps.length)),
    );
  }, [seqSteps.length]);

  const imperativeClearHighlight = useCallback(() => {
    const anim = createCfgAnimController(renderedRef.current, parsedGraph, cfgData);
    if (!anim) {
      manualHlRef.current = [];
      return;
    }
    for (const blockId of manualHlRef.current) {
      anim.resetBlock(blockId);
    }
    manualHlRef.current = [];
  }, [parsedGraph, cfgData]);

  const imperativeHighlightBlock = useCallback((
    blockId: string,
    opts?: { color?: number; strokeW?: number },
  ) => {
    const anim = createCfgAnimController(renderedRef.current, parsedGraph, cfgData);
    if (!anim) return;
    anim.setBlockStroke(blockId, opts?.color ?? CFG_TRACE_HL.color, opts?.strokeW ?? CFG_TRACE_HL.strokeW);
    if (!manualHlRef.current.includes(blockId)) manualHlRef.current.push(blockId);
  }, [parsedGraph, cfgData]);

  useImperativeHandle(ref, () => ({
    centerInView: centerGraphInView,
    fitToView,
    highlightPc: (pc: number) => {
      const blockId = pcToBlockId(cfgData?.blocks ?? [], pc);
      if (!blockId) return null;
      imperativeHighlightBlock(blockId, { color: CFG_TRACE_HL.color, strokeW: CFG_TRACE_HL.strokeW });
      return blockId;
    },
    highlightBlock: imperativeHighlightBlock,
    clearHighlight: imperativeClearHighlight,
  }), [centerGraphInView, fitToView, imperativeHighlightBlock, imperativeClearHighlight, cfgData]);

  // Seq 播放器：当前块 + trace 入边 + trace 出边
  useEffect(() => {
    const rg = renderedRef.current;
    const pg = parsedGraph;
    const anim = createCfgAnimController(rg, pg, cfgData);
    const { blockId: prevBlockId, edgeKeys: prevEdgeKeys } = seqHlRef.current;

    const clearSeqHl = () => {
      const a = createCfgAnimController(rg, pg, cfgData);
      if (!a) {
        seqHlRef.current = { blockId: null, edgeKeys: [] };
        return;
      }
      if (prevBlockId) a.resetBlock(prevBlockId);
      for (const key of prevEdgeKeys) {
        const [ef, et] = key.split("→");
        a.resetEdge(ef, et);
      }
      seqHlRef.current = { blockId: null, edgeKeys: [] };
    };

    if (!seqPlayerOpen) {
      clearSeqHl();
      return;
    }
    if (!anim || seqSteps.length === 0) return;

    const n = seqSteps.length;
    const sc = Math.max(1, Math.min(seqCursor, n));
    const block = seqSteps[sc - 1];
    if (!block) return;

    clearSeqHl();

    const newEdgeKeys: string[] = [];

    anim.setBlockStroke(block.id, CFG_TRACE_HL.color, CFG_TRACE_HL.strokeW);

    if (sc > 1) {
      const a = seqSteps[sc - 2];
      const b = seqSteps[sc - 1];
      if (a && b) {
        const k = anim.highlightTraceEdge(a.id, b.id, sc, CFG_TRACE_HL.color, CFG_TRACE_HL.strokeW);
        if (k) newEdgeKeys.push(k);
      }
    }
    if (sc < n) {
      const a = seqSteps[sc - 1];
      const b = seqSteps[sc];
      if (a && b) {
        const k = anim.highlightTraceEdge(a.id, b.id, sc + 1, CFG_TRACE_HL.color, CFG_TRACE_HL.strokeW);
        if (k) newEdgeKeys.push(k);
      }
    }

    seqHlRef.current = { blockId: block.id, edgeKeys: newEdgeKeys };

    if (seqAutoCenter) centerBlock(block.id);
  }, [seqPlayerOpen, seqCursor, seqSteps, parsedGraph, cfgData, seqAutoCenter, centerBlock]);

  /** 主窗口步进高亮：块 + 入/出边 + 当前 PC 行 */
  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      const rg = renderedRef.current;
      const parsed = parsedGraph;
      if (!rg || !parsed) return;

      const anim = createCfgAnimController(rg, parsed, cfgData);
      const prevMain = mainHlRef.current;
      const clearAnim = anim;

      if (clearAnim) {
        for (const bid of prevMain.blockIds) clearAnim.resetBlock(bid);
        for (const ek of prevMain.edgeKeys) {
          const [ef, et] = ek.split("→");
          clearAnim.resetEdge(ef, et);
        }
        if (prevMain.textBlockId) clearAnim.resetOpcodeLineTints(prevMain.textBlockId);
      }

      const parsed2 = selectedFrame ? parseFrameKey(selectedFrame) : null;
      if (!anim || !playCursor || !parsed2 || blocks.length === 0) {
        mainHlRef.current = { blockIds: [], edgeKeys: [], textBlockId: null };
        return;
      }
      if (playCursor.transactionId !== parsed2.transactionId || playCursor.contextId !== parsed2.contextId) {
        mainHlRef.current = { blockIds: [], edgeKeys: [], textBlockId: null };
        return;
      }

      const curId = pcToBlockId(blocks, playCursor.pc);
      if (!curId) {
        mainHlRef.current = { blockIds: [], edgeKeys: [], textBlockId: null };
        return;
      }

      const indices = cfgData?.blockEntryGlobalStepIndices;
      const n = seqSteps.length;
      const sc = indices?.length
        ? globalStepToSeqStep(indices, playCursor.stepIndex)
        : 1;
      const traceAligned =
        Boolean(indices?.length && n > 0 && seqSteps[sc - 1]?.id === curId);

      const newBlockIds: string[] = [];
      const newEdgeKeys: string[] = [];

      if (seqPlayerOpen) {
        anim.tintOpcodeLineForBlockPc(curId, playCursor.pc);
        mainHlRef.current = { blockIds: [], edgeKeys: [], textBlockId: curId };
        centerBlock(curId);
        return;
      }

      anim.setBlockStroke(curId, CFG_TRACE_HL.color, CFG_TRACE_HL.strokeW);
      newBlockIds.push(curId);

      if (traceAligned) {
        if (sc > 1) {
          const a = seqSteps[sc - 2];
          const b = seqSteps[sc - 1];
          if (a && b) {
            const k = anim.highlightTraceEdge(a.id, b.id, sc, CFG_TRACE_HL.color, CFG_TRACE_HL.strokeW);
            if (k) newEdgeKeys.push(k);
          }
        }
        if (sc < n) {
          const a = seqSteps[sc - 1];
          const b = seqSteps[sc];
          if (a && b) {
            const k = anim.highlightTraceEdge(a.id, b.id, sc + 1, CFG_TRACE_HL.color, CFG_TRACE_HL.strokeW);
            if (k) newEdgeKeys.push(k);
          }
        }
      } else {
        const prevId = playCursor.prevPc !== undefined ? pcToBlockId(blocks, playCursor.prevPc) : null;
        if (prevId && prevId !== curId) {
          const k = anim.highlightTransitionEdge(prevId, curId, CFG_TRACE_HL.color, CFG_TRACE_HL.strokeW);
          if (k) newEdgeKeys.push(k);
        }
      }

      anim.tintOpcodeLineForBlockPc(curId, playCursor.pc);

      mainHlRef.current = {
        blockIds: newBlockIds,
        edgeKeys: newEdgeKeys,
        textBlockId: curId,
      };
      centerBlock(curId);
    });
    return () => cancelAnimationFrame(rafId);
  }, [
    playCursor,
    selectedFrame,
    blocks,
    cfgData,
    seqSteps,
    seqPlayerOpen,
    parsedGraph,
    centerBlock,
  ]);

  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;

    const flushWheel = () => {
      wheelRafRef.current = null;
      const e = latestWheelRef.current;
      latestWheelRef.current = null;
      if (!e) return;
      const wrap = canvasWrapRef.current;
      if (!wrap) return;
      const { x, y } = panRef.current;
      const s = scaleRef.current;
      if (zoomLockedRef.current) {
        applyTransform(x - e.deltaX * WHEEL_PAN_FACTOR, y - e.deltaY * WHEEL_PAN_FACTOR, s);
      } else {
        const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENS);
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor));
        const rect = wrap.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const wx = (mx - x) / s;
        const wy = (my - y) / s;
        applyTransform(mx - wx * newScale, my - wy * newScale, newScale);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      latestWheelRef.current = e;
      if (wheelRafRef.current != null) return;
      wheelRafRef.current = requestAnimationFrame(flushWheel);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const { x, y } = panRef.current;
      dragRef.current = { active: true, pid: e.pointerId, sx: e.clientX, sy: e.clientY, ox: x, oy: y };
      el.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d.active || e.pointerId !== d.pid) return;
      applyTransform(d.ox + (e.clientX - d.sx), d.oy + (e.clientY - d.sy), scaleRef.current);
    };
    const onPointerUp = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d.active || e.pointerId !== d.pid) return;
      dragRef.current.active = false;
      dragRef.current.pid = null;
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup",   onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      if (wheelRafRef.current != null) {
        cancelAnimationFrame(wheelRafRef.current);
        wheelRafRef.current = null;
      }
      latestWheelRef.current = null;
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup",   onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  }, [applyTransform]);

  // 快捷键：方向键平移，l/h 缩放，p 锁定，f 适配，s 序列条，j/k 步进
  useEffect(() => {
    const PAN_STEP = 60;
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return;
      if (el.isContentEditable) return;

      if (e.key === "ArrowLeft" || e.key === "ArrowRight" ||
          e.key === "ArrowUp"   || e.key === "ArrowDown") {
        e.preventDefault();
        const { x, y } = panRef.current;
        const dx = e.key === "ArrowLeft" ? PAN_STEP : e.key === "ArrowRight" ? -PAN_STEP : 0;
        const dy = e.key === "ArrowUp"   ? PAN_STEP : e.key === "ArrowDown"  ? -PAN_STEP : 0;
        applyTransform(x + dx, y + dy, scaleRef.current);
        return;
      }

      const ch = e.key;
      if (ch === "l" || ch === "L") {
        e.preventDefault();
        zoomAtCenter("in");
        return;
      }
      if (ch === "h" || ch === "H") {
        e.preventDefault();
        zoomAtCenter("out");
        return;
      }
      if (ch === "p" || ch === "P") {
        e.preventDefault();
        const next = !zoomLockedRef.current;
        zoomLockedRef.current = next;
        setZoomLockedState(next);
        return;
      }
      if (ch === "f" || ch === "F") {
        e.preventDefault();
        centerGraphInView();
        return;
      }
      if (ch === "s" || ch === "S") {
        e.preventDefault();
        if (seqSteps.length > 0) setSeqPlayerOpen(true);
        return;
      }

      if (!seqPlayerOpen) return;
      if (ch === "j" || ch === "J") {
        e.preventDefault();
        setSeqCursor((c) => {
          const n = Math.min(seqSteps.length, c + 1);
          queueMicrotask(() => emitSeqAfterStepRef.current(n));
          return n;
        });
      } else if (ch === "k" || ch === "K") {
        e.preventDefault();
        setSeqCursor((c) => {
          const n = Math.max(1, c - 1);
          queueMicrotask(() => emitSeqAfterStepRef.current(n));
          return n;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [seqPlayerOpen, seqSteps.length, applyTransform, zoomAtCenter, centerGraphInView]);

  const setZoomLocked = (v: boolean) => {
    zoomLockedRef.current = v;
    setZoomLockedState(v);
  };

  const parsed = selectedFrame ? parseFrameKey(selectedFrame) : null;

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <div className="flex flex-nowrap items-center gap-1.5 px-1.5 py-0.5 text-[10px] leading-tight shrink-0 border-b border-border/60 bg-muted/20 min-h-0">
        <span className="text-muted-foreground shrink-0">f:{frames.length}</span>
        {cfgData?.meta && (
          <span className="text-muted-foreground shrink-0 hidden sm:inline">
            ex:{cfgData.meta.exitKind}
            {cfgData.meta.unmappedPcs.length > 0 ? `·u${cfgData.meta.unmappedPcs.length}` : ""}
          </span>
        )}
        <span className="text-muted-foreground shrink-0">b:{blocks.length}·e:{edges.length}</span>
        <Select value={selectedFrame} onValueChange={setSelectedFrame}>
          <SelectTrigger className="h-5 w-[min(200px,28vw)] min-w-[110px] text-[9px] px-1.5 py-0 leading-none gap-0.5 [&>span]:py-0 [&_svg]:h-3 [&_svg]:w-3">
            <SelectValue placeholder="Frame" />
          </SelectTrigger>
          <SelectContent className="max-h-[min(62vh,520px)] p-0 text-[9px] [&>div:nth-child(2)]:p-0.5">
            {frames.length === 0 ? (
              <SelectItem value="__none" disabled className="py-1 pl-1.5 pr-6 text-[9px] min-h-0">
                No frame
              </SelectItem>
            ) : (
              frames.map((f) => {
                const p = parseFrameKey(f.key);
                return (
                  <SelectItem
                    key={f.key}
                    value={f.key}
                    className="py-0.5 pl-1.5 pr-6 text-[9px] leading-tight min-h-0 data-[highlighted]:py-0.5"
                  >
                    tx{p.transactionId}·c{p.contextId} ({f.count})
                  </SelectItem>
                );
              })
            )}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={zoomLocked ? "secondary" : "outline"}
          size="sm"
          className="h-6 px-1.5 gap-0.5 text-[10px]"
          onClick={() => setZoomLocked(!zoomLocked)}
          title={zoomLocked ? "Unlock: wheel zooms (p)" : "Lock: wheel pans (p)"}
        >
          {zoomLocked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
          <span className="hidden sm:inline">{zoomLocked ? "lock" : "pan"}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-1.5 gap-0.5 text-[10px]"
          onClick={centerGraphInView}
          disabled={!parsedGraph}
          title="Center graph in view (f)"
        >
          <Home className="h-3 w-3" />
          <span className="hidden sm:inline">fit</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-1.5 gap-0.5 text-[10px] hidden"
          onClick={() => setDecompileOpen(true)}
          disabled={!selectedFrame}
          title="Decompile current frame to pseudocode"
        >
          <span className="hidden sm:inline">decomp</span>
          <span className="sm:hidden">dc</span>
        </Button>
        <Button
          type="button"
          variant={seqPlayerOpen ? "secondary" : "outline"}
          size="sm"
          className="h-6 px-1.5 gap-0.5 text-[10px]"
          onClick={() => setSeqPlayerOpen((v) => !v)}
          disabled={seqSteps.length === 0}
          title="Seq player (s) · steps j/k · zoom l/h"
        >
          <SlidersHorizontal className="h-3 w-3" />
          <span className="hidden sm:inline">seq</span>
        </Button>
        <Button
          type="button"
          variant={gasDrawerOpen ? "secondary" : "outline"}
          size="sm"
          className="h-6 px-1.5 gap-0.5 text-[10px]"
          onClick={() => setGasDrawerOpen(true)}
          disabled={!blockGasVisitList}
          title="Gas per block visit (trace order)"
        >
          <Fuel className="h-3 w-3" />
          <span className="hidden sm:inline">gas</span>
        </Button>
        {loading && <span className="text-amber-500 shrink-0">…</span>}
        {renderErr && (
          <span className="text-destructive text-[10px] max-w-[40vw] truncate shrink-0" title={renderErr}>
            {renderErr}
          </span>
        )}
        {parsed && (
          <span className="text-muted-foreground shrink-0 hidden md:inline">
            tx{parsed.transactionId}·c{parsed.contextId}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 relative bg-white">
        <div
          ref={canvasWrapRef}
          className="absolute inset-0"
          style={{ touchAction: "none", userSelect: "none", cursor: "grab" }}
        />
        {frames.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground pointer-events-none">
            Waiting for step stream...
          </div>
        )}
      </div>
      {seqPlayerOpen && seqSteps.length > 0 && (
        <div className="shrink-0 border-t border-border/60 bg-muted/30 px-2 py-0.5 -mt-px">
          <div className="flex w-full min-h-7 items-center gap-2">
            <div className="flex min-w-0 max-w-[38%] shrink items-center gap-1.5 overflow-hidden text-[10px] font-mono leading-none sm:max-w-[42%]">
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {seqCursorSafe}/{seqSteps.length}
              </span>
              {(() => {
                const b = seqSteps[seqCursorSafe - 1];
                return b ? (
                  <span
                    className="min-w-0 truncate text-foreground"
                    title={`${b.id} 0x${b.startPc.toString(16)}–0x${b.endPc.toString(16)}`}
                  >
                    {b.id}{" "}
                    <span className="text-muted-foreground">
                      0x{b.startPc.toString(16)}–0x{b.endPc.toString(16)}
                    </span>
                  </span>
                ) : null;
              })()}
            </div>
            {/* flex-1 + inline maxWidth: Tailwind min() arbitrary values are unreliable in some builds */}
            <div className="flex min-h-4 min-w-0 flex-1 justify-center px-1">
              <div
                ref={seqSliderWrapRef}
                className="h-4 w-full min-w-[10rem]"
                style={{ maxWidth: "min(97.5%, 39rem)" }}
              >
                <Slider
                  className="w-full"
                  min={1}
                  max={seqSteps.length}
                  step={1}
                  value={[seqCursorSafe]}
                  onValueChange={(v) => {
                    pendingSliderCommitRef.current = true;
                    setSeqCursor(v[0] ?? 1);
                  }}
                  disabled={seqSteps.length <= 1}
                  aria-label="Execution step"
                />
              </div>
            </div>
            <Label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[10px] font-normal leading-none">
              <Checkbox
                checked={seqAutoCenter}
                onCheckedChange={(c) => setSeqAutoCenter(c === true)}
                className="h-3 w-3"
              />
              auto-center
            </Label>
          </div>
        </div>
      )}
      <Sheet open={gasDrawerOpen} onOpenChange={setGasDrawerOpen}>
        <SheetContent side="right" className="flex h-full w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
          <SheetHeader className="shrink-0 space-y-1 border-b border-border/60 px-4 py-3 text-left">
            <SheetTitle className="text-base">Gas per visit</SheetTitle>
            <SheetDescription className="text-xs">
              Each row is one block entry in trace order. Open a block to see every visit; click to jump the seq
              player and center the block.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {blockGasVisitList &&
              blockGasVisitList.order.map((blockId) => {
                const visits = blockGasVisitList.byBlock.get(blockId) ?? [];
                return (
                  <details
                    key={blockId}
                    className="mb-1.5 overflow-hidden rounded-md border border-border/60 bg-muted/15"
                  >
                    <summary className="cursor-pointer select-none px-2 py-1.5 text-[11px] font-mono text-foreground hover:bg-muted/40">
                      {blockId}
                      <span className="ml-1.5 text-muted-foreground">({visits.length})</span>
                    </summary>
                    <ul className="space-y-0.5 border-t border-border/40 px-2 py-1.5">
                      {visits.map(({ seq, gas }) => (
                        <li key={seq}>
                          <button
                            type="button"
                            className="w-full rounded px-1.5 py-1 text-left text-[10px] font-mono tabular-nums text-foreground hover:bg-muted/50"
                            onClick={() => jumpSeqToStep(seq)}
                          >
                            <span className="text-muted-foreground">seq {seq}</span>
                            <span className="mx-1.5 text-border">·</span>
                            <span>{gas.toLocaleString()} gas</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
          </div>
        </SheetContent>
      </Sheet>
      {selectedFrame && (() => {
        const { transactionId, contextId } = parseFrameKey(selectedFrame);
        return (
          <DecompileDialog
            open={decompileOpen}
            onOpenChange={setDecompileOpen}
            transactionId={transactionId}
            contextId={contextId}
          />
        );
      })()}
    </div>
  );
});
CfgWindow.displayName = "CfgWindow";
