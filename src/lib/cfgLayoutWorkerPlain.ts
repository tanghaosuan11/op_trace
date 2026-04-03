/**
 * Web Worker: runs Graphviz DOT layout off the main thread — outputs "plain" format.
 *
 * "plain" format gives numeric positions (in inches) for nodes and edge spline control
 * points, which we then render with PixiJS instead of the SVG renderer.
 *
 * Message in:  { id: string; dot: string }
 * Message out: { id: string; plain: string } | { id: string; error: string }
 */
import { Graphviz } from "@hpcc-js/wasm/graphviz";

interface LayoutRequest {
  id: string;
  dot: string;
}

interface LayoutResponse {
  id: string;
  plain?: string;
  error?: string;
}

let gvP: ReturnType<typeof Graphviz.load> | null = null;

function getGv() {
  if (!gvP) gvP = Graphviz.load();
  return gvP;
}

self.onmessage = async (e: MessageEvent<LayoutRequest>) => {
  const { id, dot } = e.data;
  try {
    const gv = await getGv();
    const plain = gv.layout(dot, "plain", "dot");
    const resp: LayoutResponse = { id, plain };
    self.postMessage(resp);
  } catch (err) {
    const resp: LayoutResponse = { id, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(resp);
  }
};
