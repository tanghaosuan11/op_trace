import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CfgLayoutSvgWorkerInline from "../lib/cfgLayoutWorker.ts?worker&inline";
import { invoke, isRunningInVSCode } from "@/lib/ipc-bridge";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Lock, Unlock } from "lucide-react";
import type { CfgCurrentStepPayload } from "@/lib/cfgBridge";
import { cfgResultToDot } from "@/lib/cfgDot";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface CfgWindowProps {
  sessionId: string;
  /** Pre-aggregated frames: unique (tx,ctx) pairs + step counts. */
  frames: { key: FrameKey; count: number }[];
}

type FrameKey = string;

const VIRTUAL_START_PC = 0xffff_ffff;

const ONLY_EXECUTED = true;

const WHEEL_PAN_FACTOR = 0.85;
const WHEEL_ZOOM_SENS = 0.002;
const MIN_SCALE = 0.15;
const MAX_SCALE = 4;
/** Below this scale factor, text nodes are hidden (LOD) — only boxes + edges shown. */
const LOD_TEXT_THRESHOLD = 0.45;
/** Padding in transform-div CSS px added around the visible area for culling. */
const CULL_PAD = 50;

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
  blockEntryTrace?: string[];
  blockEntryGlobalStepIndices?: number[];
  blockVisitGasTotals?: number[];
  meta: CfgMeta;
}

let _worker: Worker | null = null;
let _reqCounter = 0;
const _pending = new Map<string, { resolve: (svg: string) => void; reject: (e: Error) => void }>();

function getLayoutWorker(): Worker {
  if (!_worker) {
    _worker = new CfgLayoutSvgWorkerInline();
    _worker.onmessage = (e: MessageEvent<{ id: string; svg?: string; error?: string }>) => {
      const { id, svg, error } = e.data;
      const cb = _pending.get(id);
      if (!cb) return;
      _pending.delete(id);
      if (error) cb.reject(new Error(error));
      else cb.resolve(svg ?? "");
    };
    _worker.onerror = (e) => {
      // Reject all pending on unexpected worker crash
      for (const { reject } of _pending.values()) reject(new Error(e.message ?? "worker error"));
      _pending.clear();
      _worker = null;
    };
  }
  return _worker;
}

/** Post a layout request to the worker. Returns a promise resolving to SVG string. */
function layoutInWorker(dot: string): { promise: Promise<string>; id: string } {
  const id = String(++_reqCounter);
  const promise = new Promise<string>((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    getLayoutWorker().postMessage({ id, dot });
  });
  return { promise, id };
}

/** Cancel a pending layout request (worker still runs, but result is ignored). */
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

function pickTransitionEdge(edges: CfgEdge[], fromId: string, toId: string): CfgEdge | null {
  const cand = edges.filter((e) => e.source === fromId && e.target === toId);
  if (cand.length === 0) return null;
  return cand.find((e) => e.executed) ?? cand[0] ?? null;
}

/** Graphviz SVG: node name is in `<g class="node"><title>…</title>` */
function findNodeGroup(svg: SVGSVGElement, blockId: string): SVGGElement | null {
  for (const g of svg.querySelectorAll("g.node")) {
    const t = g.querySelector("title");
    if (t?.textContent === blockId) return g as SVGGElement;
  }
  return null;
}

function findEdgeGroup(svg: SVGSVGElement, fromId: string, toId: string): SVGGElement | null {
  const exact = `${fromId}->${toId}`;
  for (const g of svg.querySelectorAll("g.edge")) {
    const text = g.querySelector("title")?.textContent?.trim() ?? "";
    if (text === exact) return g as SVGGElement;
  }
  return null;
}

const CLS = {
  nodeCur: "cfg-svg-node--current",
  nodePrev: "cfg-svg-node--prev",
  edgeHl: "cfg-svg-edge--play",
};

/** Coalesce rapid optrace:cfg:current_step updates to one paint (no Graphviz re-layout). */
const HL_RAF = true;

function parseFrameKey(key: FrameKey): { transactionId: number; contextId: number } {
  const [tx, ctx] = key.split(":");
  return { transactionId: Number(tx), contextId: Number(ctx) };
}

export function CfgWindow({ sessionId, frames }: CfgWindowProps) {
  const svgHostRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const structureKeyRef = useRef<string | null>(null);
  const lastHlRef = useRef<{ nodes: SVGGElement[]; edges: SVGGElement[] }>({ nodes: [], edges: [] });

  const [selectedFrame, setSelectedFrame] = useState<FrameKey>("");
  const [cfgData, setCfgData] = useState<CfgResult | null>(null);
  const [svgMarkup, setSvgMarkup] = useState<string>("");
  const [renderErr, setRenderErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pendingLayoutId = useRef<string | null>(null);
  const [zoomLocked, setZoomLocked] = useState(false);
  // pan/scale as refs — no React re-render on every pointer/wheel event
  const transformDivRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const dragRef = useRef<{
    active: boolean;
    pid: number | null;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
  }>({ active: false, pid: null, sx: 0, sy: 0, ox: 0, oy: 0 });
  // Spatial index for viewport culling — built once per SVG load via getBBox()
  const svgBoundsRef = useRef<{ el: SVGGElement; x: number; y: number; w: number; h: number }[]>([]);

  const applyTransform = useCallback((x: number, y: number, s: number) => {
    panRef.current = { x, y };
    scaleRef.current = s;
    if (transformDivRef.current) {
      transformDivRef.current.style.transform = `translate(${x}px,${y}px) scale(${s})`;
    }
    const vp = viewportRef.current;
    if (!vp) return;
    // LOD: hide text content when zoomed far out to avoid expensive text rasterization
    vp.classList.toggle("cfg-lod-low", s < LOD_TEXT_THRESHOLD);
    // Viewport culling: hide SVG groups outside the visible area.
    // This keeps the GPU texture size within limits (avoids CPU fallback in WKWebView).
    const bounds = svgBoundsRef.current;
    if (bounds.length === 0) return;
    const vpW = vp.clientWidth;
    const vpH = vp.clientHeight;
    // Convert viewport corners to SVG coordinate space
    const vx0 = -x / s;
    const vy0 = -y / s;
    const vx1 = vx0 + vpW / s;
    const vy1 = vy0 + vpH / s;
    for (const nb of bounds) {
      nb.el.style.display =
        nb.x + nb.w > vx0 - CULL_PAD &&
        nb.x        < vx1 + CULL_PAD &&
        nb.y + nb.h > vy0 - CULL_PAD &&
        nb.y        < vy1 + CULL_PAD
          ? ""
          : "none";
    }
  }, []);

  const [playCursor, setPlayCursor] = useState<{
    transactionId: number;
    contextId: number;
    pc: number;
    prevPc?: number;
  } | null>(null);

  // frames prop is already aggregated upstream — no need to iterate 700k steps here
  useEffect(() => {
    if (!selectedFrame && frames.length > 0) {
      setSelectedFrame(frames[frames.length - 1].key);
      return;
    }
    if (selectedFrame && !frames.some((f) => f.key === selectedFrame)) {
      setSelectedFrame(frames.length > 0 ? frames[frames.length - 1].key : "");
    }
  }, [frames, selectedFrame]);

  const fetchCfg = useCallback(async () => {
    if (!selectedFrame || !sessionId) {
      setCfgData(null);
      setSvgMarkup("");
      return;
    }
    const { transactionId, contextId } = parseFrameKey(selectedFrame);
    setLoading(true);
    setRenderErr(null);
    try {
      const result = await invoke<CfgResult>("build_cfg", {
        transactionId,
        contextId,
        onlyExecuted: ONLY_EXECUTED,
        sessionId,
      });
      setCfgData(result);
      const dot = cfgResultToDot(result);
      // Cancel any previous pending layout to avoid stale results overwriting
      if (pendingLayoutId.current) {
        cancelLayoutRequest(pendingLayoutId.current);
        pendingLayoutId.current = null;
      }
      const { promise, id } = layoutInWorker(dot);
      pendingLayoutId.current = id;
      const svg = await promise;
      pendingLayoutId.current = null;
      setSvgMarkup(svg);
      structureKeyRef.current = null;
    } catch (err) {
      console.warn("[CfgWindow] build_cfg / graphviz failed:", err);
      setCfgData(null);
      setSvgMarkup("");
      setRenderErr(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedFrame, sessionId]);

  useEffect(() => {
    void fetchCfg();
  }, [fetchCfg]);

  useEffect(() => {
    const handleStep = (p: CfgCurrentStepPayload) => {
      if (!p?.sessionId || p.sessionId !== sessionId) return;
      if (p.pc === undefined) { setPlayCursor(null); return; }
      setPlayCursor({ transactionId: p.transactionId, contextId: p.contextId, pc: p.pc, prevPc: p.prevPc });
    };
    if (isRunningInVSCode()) {
      const bridge = (window as unknown as Record<string, unknown>).__optrace_on_event__ as ((e: string, h: (d: unknown) => void) => void) | undefined;
      bridge?.("optrace:cfg:current_step", (d) => handleStep(d as CfgCurrentStepPayload));
      return;
    }
    const w = getCurrentWindow();
    const unlistenP = w.listen<CfgCurrentStepPayload>("optrace:cfg:current_step", (ev) => handleStep(ev.payload));
    return () => { unlistenP.then((u) => u()).catch(() => {}); };
  }, [sessionId]);

  const blocks = cfgData?.blocks ?? [];
  const edges = cfgData?.edges ?? [];

  const structureKey = useMemo(
    () => `${blocks.map((b) => b.id).join("\0")}|${edges.map((e) => e.id).join("\0")}`,
    [blocks, edges],
  );

  /** Fit SVG in view once per new graph */
  useEffect(() => {
    const host = svgHostRef.current;
    const vp = viewportRef.current;
    if (!host || !vp || !svgMarkup) return;
    const svg = host.querySelector("svg");
    if (!svg) return;
    if (structureKeyRef.current === structureKey) return;
    structureKeyRef.current = structureKey;

    const vb = svg.viewBox.baseVal;
    const gw = vb.width || Number(svg.getAttribute("width")) || 400;
    const gh = vb.height || Number(svg.getAttribute("height")) || 300;
    const rw = vp.clientWidth;
    const rh = vp.clientHeight;
    if (rw > 0 && rh > 0 && gw > 0 && gh > 0) {
      const k = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min((rw - 16) / gw, (rh - 16) / gh, 1.2)));
      applyTransform((rw - gw * k) / 2, (rh - gh * k) / 2, k);
    } else {
      applyTransform(8, 8, 1);
    }
  }, [svgMarkup, structureKey, applyTransform]);

  const clearHighlightDom = useCallback(() => {
    for (const g of lastHlRef.current.nodes) {
      if (g.isConnected) g.classList.remove(CLS.nodeCur, CLS.nodePrev);
    }
    for (const g of lastHlRef.current.edges) {
      if (g.isConnected) g.classList.remove(CLS.edgeHl);
    }
    lastHlRef.current = { nodes: [], edges: [] };
  }, []);

  /** New SVG string → old &lt;g&gt; refs are stale; drop only (no layout). */
  useEffect(() => {
    lastHlRef.current = { nodes: [], edges: [] };
  }, [svgMarkup]);

  /**
   * Build spatial index for viewport culling after each new SVG is inserted into DOM.
   *
   * WHY getBoundingClientRect instead of getBBox:
   *   getBBox() returns coordinates in the SVG's internal coordinate system (viewBox units,
   *   which Graphviz outputs in points with negative Y values). applyTransform works in
   *   transform-div CSS pixel space. These are different units/origins → culling was wrong.
   *
   *   getBoundingClientRect() returns screen coordinates (affected by CSS transforms), so
   *   we divide by the current CSS scale to convert back to "transform-div natural CSS px"
   *   — the same space that applyTransform uses for vx0/vx1/vy0/vy1. This is stable:
   *   stored coords don't change when user pans/zooms because we've normalized out the scale.
   */
  useEffect(() => {
    svgBoundsRef.current = [];
    if (!svgMarkup) return;
    const svg = svgHostRef.current?.querySelector("svg");
    if (!svg) return;
    // scaleRef is already updated by the fit-to-view effect which runs before this one
    const s = scaleRef.current || 1;
    const svgRect = svg.getBoundingClientRect();
    const bounds: typeof svgBoundsRef.current = [];
    for (const g of svg.querySelectorAll<SVGGElement>("g.node, g.edge")) {
      const r = g.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // Convert screen px → transform-div natural CSS px by undoing the CSS scale.
      // Origin is the SVG element's top-left (= transform-div origin, no padding on host div).
      bounds.push({
        el: g,
        x: (r.left - svgRect.left) / s,
        y: (r.top - svgRect.top) / s,
        w: r.width / s,
        h: r.height / s,
      });
    }
    svgBoundsRef.current = bounds;
  }, [svgMarkup]);

  /**
   * Play-step highlight: **classList only** — never calls Graphviz `layout`.
   * Optional rAF to coalesce bursty step events.
   */
  useEffect(() => {
    const apply = () => {
      const host = svgHostRef.current;
      if (!host || !svgMarkup) return;
      const svg = host.querySelector("svg");
      if (!svg) return;

      clearHighlightDom();

      const parsed = selectedFrame ? parseFrameKey(selectedFrame) : null;
      if (!playCursor || !parsed || blocks.length === 0) return;
      if (playCursor.transactionId !== parsed.transactionId || playCursor.contextId !== parsed.contextId) {
        return;
      }

      const curId = pcToBlockId(blocks, playCursor.pc);
      if (!curId) return;
      const prevId =
        playCursor.prevPc !== undefined ? pcToBlockId(blocks, playCursor.prevPc) : null;

      const nodes: SVGGElement[] = [];
      const gCur = findNodeGroup(svg, curId);
      if (gCur) {
        gCur.classList.add(CLS.nodeCur);
        nodes.push(gCur);
      }
      if (prevId && prevId !== curId) {
        const gPrev = findNodeGroup(svg, prevId);
        if (gPrev) {
          gPrev.classList.add(CLS.nodePrev);
          nodes.push(gPrev);
        }
      }

      const edgesOut: SVGGElement[] = [];
      if (prevId && prevId !== curId) {
        const e = pickTransitionEdge(edges, prevId, curId);
        if (e) {
          const ge = findEdgeGroup(svg, e.source, e.target);
          if (ge) {
            ge.classList.add(CLS.edgeHl);
            edgesOut.push(ge);
          }
        }
      }

      lastHlRef.current = { nodes, edges: edgesOut };
    };

    if (!HL_RAF) {
      apply();
      return;
    }

    const rafId = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(rafId);
  }, [playCursor, selectedFrame, blocks, edges, svgMarkup, clearHighlightDom]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = panRef.current;
      const s = scaleRef.current;
      if (zoomLocked) {
        applyTransform(x - e.deltaX * WHEEL_PAN_FACTOR, y - e.deltaY * WHEEL_PAN_FACTOR, s);
      } else {
        const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENS);
        applyTransform(x, y, Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor)));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomLocked, svgMarkup, applyTransform]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const { x, y } = panRef.current;
      dragRef.current = { active: true, pid: e.pointerId, sx: e.clientX, sy: e.clientY, ox: x, oy: y };
      el.setPointerCapture(e.pointerId);
      el.classList.add("cfg-dragging");
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
      el.classList.remove("cfg-dragging");
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  }, [applyTransform, svgMarkup]);

  const parsed = selectedFrame ? parseFrameKey(selectedFrame) : null;

  return (
    <div className="h-screen p-3 bg-background">
      <style>{`
        .cfg-svg-viewport { touch-action: none; user-select: none; }
        /* SVG itself never needs pointer events — drag handled by outer viewport */
        /* font-family matches Graphviz Courier metrics so rendering aligns with layout */
        .cfg-svg-viewport svg { display: block; max-width: none; pointer-events: none; font-family: "Courier New", Courier, monospace; }
        /* LOD: hide all text labels when zoomed far out — boxes + edges only.
           Reduces GPU rasterization cost by ~70% at overview zoom levels. */
        .cfg-svg-viewport.cfg-lod-low svg text { display: none; }
        /* During active drag: drop expensive text/shape rendering for raw speed */
        .cfg-svg-viewport.cfg-dragging svg text { text-rendering: optimizeSpeed; }
        .cfg-svg-viewport.cfg-dragging svg path,
        .cfg-svg-viewport.cfg-dragging svg polygon { shape-rendering: crispEdges; }
        /* Edge paths are orthogonal — crispEdges always looks fine and is faster */
        .cfg-svg-viewport .edge path,
        .cfg-svg-viewport .edge polygon { shape-rendering: crispEdges; }
        .cfg-svg-node--current path,
        .cfg-svg-node--current polygon,
        .cfg-svg-node--current ellipse,
        .cfg-svg-node--current polyline {
          stroke: #2563eb !important;
          stroke-width: 2.5px !important;
        }
        .cfg-svg-node--prev path,
        .cfg-svg-node--prev polygon,
        .cfg-svg-node--prev ellipse,
        .cfg-svg-node--prev polyline {
          stroke: #7c3aed !important;
          stroke-width: 2px !important;
        }
        .cfg-svg-edge--play path,
        .cfg-svg-edge--play polygon {
          stroke: #2563eb !important;
          stroke-width: 2.5px !important;
        }
      `}</style>
      <Card className="h-full p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">CFG / CTF Flow</h3>
          <div className="text-[11px] text-muted-foreground font-mono">
            {sessionId ? sessionId : "no-session"}
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          Lightweight frames: {frames.length.toLocaleString()}
          {cfgData?.meta && (
            <span className="ml-2">
              exit={cfgData.meta.exitKind}
              {cfgData.meta.unmappedPcs.length > 0 && ` unmapped=${cfgData.meta.unmappedPcs.length}`}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Frame</span>
            <Select value={selectedFrame} onValueChange={setSelectedFrame}>
              <SelectTrigger className="h-7 w-[260px] text-xs">
                <SelectValue placeholder="Select frame" />
              </SelectTrigger>
              <SelectContent>
                {frames.length === 0 ? (
                  <SelectItem value="__none" disabled>
                    No frame
                  </SelectItem>
                ) : (
                  frames.map((f) => {
                    const p = parseFrameKey(f.key);
                    return (
                      <SelectItem key={f.key} value={f.key}>
                        tx={p.transactionId} ctx={p.contextId} ({f.count} steps)
                      </SelectItem>
                    );
                  })
                )}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant={zoomLocked ? "secondary" : "outline"}
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setZoomLocked((v) => !v)}
            title={zoomLocked ? "Unlock zoom (wheel zooms)" : "Lock zoom (wheel pans)"}
          >
            {zoomLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
            {zoomLocked ? "Zoom locked" : "Zoom unlocked"}
          </Button>
          <span className="text-muted-foreground">
            blocks={blocks.length} edges={edges.length}
          </span>
          {loading && <span className="text-yellow-400">loading...</span>}
          {renderErr && <span className="text-destructive text-[11px] max-w-[280px] truncate" title={renderErr}>{renderErr}</span>}
          {parsed ? (
            <span className="text-muted-foreground">
              selected: tx={parsed.transactionId} ctx={parsed.contextId}
            </span>
          ) : null}
        </div>
        <div className="flex-1 border border-neutral-300 rounded-md overflow-hidden bg-white min-h-[200px]">
          {frames.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              Waiting for step stream...
            </div>
          ) : (
            <div
              ref={viewportRef}
              className="cfg-svg-viewport h-full w-full bg-white cursor-grab active:cursor-grabbing"
            >
              <div
                ref={transformDivRef}
                style={{
                  transform: `translate(${panRef.current.x}px,${panRef.current.y}px) scale(${scaleRef.current})`,
                  transformOrigin: "0 0",
                  width: "max-content",
                  height: "max-content",
                  willChange: "transform",
                }}
              >
                <div ref={svgHostRef} dangerouslySetInnerHTML={{ __html: svgMarkup }} />
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
