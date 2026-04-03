/**
 * Web Worker: runs Graphviz DOT layout off the main thread.
 *
 * Message in:  { id: string; dot: string }
 * Message out: { id: string; svg: string } | { id: string; error: string }
 *
 * Uses `@hpcc-js/wasm/graphviz` synchronous API (worker-safe).
 */
import { Graphviz } from "@hpcc-js/wasm/graphviz";

interface LayoutRequest {
  id: string;
  dot: string;
}

interface LayoutResponse {
  id: string;
  svg?: string;
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
    const svg = gv.layout(dot, "svg", "dot");
    const resp: LayoutResponse = { id, svg };
    self.postMessage(resp);
  } catch (err) {
    const resp: LayoutResponse = { id, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(resp);
  }
};
