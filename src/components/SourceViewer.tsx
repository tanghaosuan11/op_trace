import "@/lib/monacoSetup"; 
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import * as monacoNS from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, FileCode } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDebugStore } from "@/store/debugStore";
import {
  parseSourceMap,
  buildPcMap,
  byteOffsetToCharOffset,
  extractRuntimeSourceMap,
  extractSourceList,
  type SourceLocation,
} from "@/lib/sourcemap";

interface SourcifyFile {
  content?: string;
}

function extractSources(root: unknown): Record<string, SourcifyFile> | null {
  if (!root || typeof root !== "object") return null;
  const o = root as Record<string, unknown>;
  if (o.sources && typeof o.sources === "object" && !Array.isArray(o.sources)) {
    return o.sources as Record<string, SourcifyFile>;
  }
  for (const key of ["runtimeMatch", "creationMatch", "match"] as const) {
    const m = o[key];
    if (m && typeof m === "object") {
      const r = m as Record<string, unknown>;
      if (
        r.sources &&
        typeof r.sources === "object" &&
        !Array.isArray(r.sources)
      ) {
        return r.sources as Record<string, SourcifyFile>;
      }
    }
  }
  return null;
}

function extractCompilation(root: unknown): unknown {
  if (!root || typeof root !== "object") return null;
  const o = root as Record<string, unknown>;
  if (o.compilation != null) return o.compilation;
  for (const key of ["runtimeMatch", "creationMatch", "match"] as const) {
    const m = o[key];
    if (m && typeof m === "object") {
      const r = m as Record<string, unknown>;
      if (r.compilation != null) return r.compilation;
    }
  }
  return null;
}

function basenameLabel(path: string): string {
  return path.split("/").pop() || path;
}

function inferLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "sol") return "solidity";
  if (ext === "json") return "json";
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx") return "javascript";
  if (ext === "yaml" || ext === "yml") return "yaml";
  return "plaintext";
}

const SOURCIFY_BASE = "https://sourcify.dev/server/v2/contract";

// ── Virtual model URI helpers ────────────────────────────────────────────────
const MODEL_SCHEME = "inmemory";
const MODEL_AUTH = "sourcify";

function fileUri(path: string): monacoNS.Uri {
  // path might already start with /, avoid double-slash
  return monacoNS.Uri.from({
    scheme: MODEL_SCHEME,
    authority: MODEL_AUTH,
    path: "/" + path.replace(/^\//, ""),
  });
}

function uriToPath(uri: monacoNS.Uri): string | null {
  if (uri.scheme !== MODEL_SCHEME || uri.authority !== MODEL_AUTH) return null;
  return uri.path.replace(/^\//, "");
}

// ── Go-to-Definition: regex over all virtual models ──────────────────────────
// Matches: contract Foo / interface Foo / function foo / event Foo / struct Foo / ...
const DECL_RE =
  /\b(?:contract|interface|library|struct|enum|event|error|modifier|function|type)\s+(\w+)/g;

function findDeclarations(word: string): monacoNS.languages.Location[] {
  const results: monacoNS.languages.Location[] = [];
  for (const model of monacoNS.editor.getModels()) {
    if (model.uri.scheme !== MODEL_SCHEME || model.uri.authority !== MODEL_AUTH)
      continue;
    const text = model.getValue();
    DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DECL_RE.exec(text)) !== null) {
      if (m[1] !== word) continue;
      // offset of the identifier itself (after keyword + whitespace)
      const identOffset = m.index + m[0].length - m[1].length;
      const pos = model.getPositionAt(identOffset);
      results.push({
        uri: model.uri,
        range: {
          startLineNumber: pos.lineNumber,
          startColumn: pos.column,
          endLineNumber: pos.lineNumber,
          endColumn: pos.column + word.length,
        },
      });
    }
  }
  return results;
}

export function SourceViewer() {
  const chainId = useDebugStore((s) => s.currentDebugChainId);
  const activeStoreTab = useDebugStore((s) => s.activeTab);
  const callFrames = useDebugStore((s) => s.callFrames);
  const currentPc = useDebugStore((s) => s.currentPc);

  const frame = useMemo(() => {
    if (!activeStoreTab.startsWith("frame-")) return undefined;
    return callFrames.find((f) => `frame-${f.contextId}` === activeStoreTab);
  }, [activeStoreTab, callFrames]);

  const codeAddress = frame?.contract ?? frame?.address;

  const [rawJson, setRawJson] = useState<string | null>(null);
  const [loadingCache, setLoadingCache] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [editorMounted, setEditorMounted] = useState(false);

  const editorRef = useRef<monacoNS.editor.IStandaloneCodeEditor | null>(null);
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const pendingReveal = useRef<{ line: number; col: number } | null>(null);
  const pendingDecoration = useRef<monacoNS.IRange | null>(null);
  const decorationsRef =
    useRef<monacoNS.editor.IEditorDecorationsCollection | null>(null);

  const parsed = useMemo(() => {
    if (!rawJson) return null;
    try {
      return JSON.parse(rawJson) as unknown;
    } catch {
      return null;
    }
  }, [rawJson]);

  const sources = useMemo(
    () => (parsed ? extractSources(parsed) : null),
    [parsed],
  );
  const compilation = useMemo(
    () => (parsed ? extractCompilation(parsed) : null),
    [parsed],
  );

  const fileNames = useMemo(() => {
    if (!sources) return [] as string[];
    return Object.keys(sources).sort((a, b) => {
      const ba = basenameLabel(a).toLowerCase();
      const bb = basenameLabel(b).toLowerCase();
      if (ba !== bb) return ba.localeCompare(bb);
      return a.localeCompare(b);
    });
  }, [sources]);

  useEffect(() => {
    if (!fileNames.length) {
      setActiveFile(null);
      return;
    }
    setActiveFile((prev) =>
      prev && fileNames.includes(prev) ? prev : fileNames[0],
    );
  }, [fileNames]);

  const pcMap = useMemo(
    () =>
      frame?.opcodes?.length
        ? buildPcMap(frame.opcodes)
        : new Map<number, number>(),
    [frame?.opcodes],
  );

  const runtimeLocations = useMemo<SourceLocation[] | null>(() => {
    if (!parsed) return null;
    const raw = extractRuntimeSourceMap(parsed);
    return raw ? parseSourceMap(raw) : null;
  }, [parsed]);

  const sourceList = useMemo<string[]>(() => {
    if (!parsed || !sources) return [];
    return extractSourceList(parsed, sources as Record<string, unknown>);
  }, [parsed, sources]);

  useEffect(() => {
    if (!sources) return;
    for (const [path, file] of Object.entries(sources)) {
      const uri = fileUri(path);
      const content = file.content ?? "";
      const existing = monacoNS.editor.getModel(uri);
      if (existing) {
        if (existing.getValue() !== content) existing.setValue(content);
      } else {
        monacoNS.editor.createModel(content, inferLanguage(path), uri);
      }
    }
    return () => {
      for (const model of monacoNS.editor.getModels()) {
        if (
          model.uri.scheme === MODEL_SCHEME &&
          model.uri.authority === MODEL_AUTH
        ) {
          model.dispose();
        }
      }
    };
  }, [sources]);

  useEffect(() => {
    const disposable = monacoNS.languages.registerDefinitionProvider(
      "solidity",
      {
        provideDefinition(model, position) {
          const word = model.getWordAtPosition(position);
          if (!word?.word) return null;
          return findDeclarations(word.word);
        },
      },
    );
    return () => disposable.dispose();
  }, []);

  useEffect(() => {
    const bar = tabBarRef.current;
    const tab = activeTabRef.current;
    if (!bar || !tab) return;
    const barCenter = bar.scrollLeft + bar.clientWidth / 2;
    const tabCenter = tab.offsetLeft + tab.offsetWidth / 2;
    bar.scrollLeft += tabCenter - barCenter;
  }, [activeFile]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorMounted || !activeFile) return;
    const model = monacoNS.editor.getModel(fileUri(activeFile));
    if (!model) return;
    editor.setModel(model);
    if (pendingReveal.current) {
      const { line, col } = pendingReveal.current;
      pendingReveal.current = null;
      editor.setPosition({ lineNumber: line, column: col });
      editor.revealLineInCenter(line);
    }
    // Apply pending PC decoration that was queued during a cross-file switch
    if (pendingDecoration.current) {
      const range = pendingDecoration.current;
      pendingDecoration.current = null;
      if (!decorationsRef.current) {
        decorationsRef.current = editor.createDecorationsCollection([]);
      }
      decorationsRef.current.set([
        {
          range,
          options: {
            className: "sol-pc-highlight",
            overviewRuler: {
              color: "rgba(255,200,50,0.8)",
              position: monacoNS.editor.OverviewRulerLane.Full,
            },
          },
        },
      ]);
      editor.revealLineInCenterIfOutsideViewport(range.startLineNumber);
    }
  }, [activeFile, editorMounted]);

  // ── PC → source highlight ─────────────────────────────────────────────────
  useEffect(() => {
    if (!editorMounted || currentPc < 0 || !runtimeLocations || !pcMap.size) {
      decorationsRef.current?.set([]);
      return;
    }

    const instrIdx = pcMap.get(currentPc);
    if (instrIdx === undefined) {
      decorationsRef.current?.set([]);
      return;
    }

    const loc = runtimeLocations[instrIdx];
    if (!loc || loc.fileIndex < 0 || loc.length === 0) {
      decorationsRef.current?.set([]);
      return;
    }

    const fileName = sourceList[loc.fileIndex];
    if (!fileName) {
      decorationsRef.current?.set([]);
      return;
    }

    const targetModel = monacoNS.editor.getModel(fileUri(fileName));
    if (!targetModel) {
      decorationsRef.current?.set([]);
      return;
    }

    const content = targetModel.getValue();
    const startChar = byteOffsetToCharOffset(content, loc.start);
    const endChar = byteOffsetToCharOffset(content, loc.start + loc.length);
    const startPos = targetModel.getPositionAt(startChar);
    const endPos = targetModel.getPositionAt(endChar);

    console.log("[SourceMap Debug]", {
      currentPc,
      instrIdx,
      loc,
      fileName,
      contentLength: content.length,
      startPos: { line: startPos.lineNumber, col: startPos.column },
      highlightedText: content.slice(startChar, endChar).slice(0, 120),
    });
    try {
      const p = JSON.parse(rawJson!) as Record<string, unknown>;
      const rm = p.runtimeMatch as Record<string, unknown> | undefined;
      const src = extractSources(p) ?? {};
      const first5Sources = Object.entries(src)
        .slice(0, 5)
        .map(
          ([k, v]) =>
            `${k} => keys:[${Object.keys(v as object).join(",")}] id=${(v as Record<string, unknown>).id}`,
        )
        .join(" | ");
      console.log("[SourceMap rootKeys]", Object.keys(p).join(", "));
      console.log(
        "[SourceMap runtimeMatchKeys]",
        rm ? Object.keys(rm).join(", ") : "none",
      );
      console.log("[SourceMap first5Sources]", first5Sources);
      console.log(
        "[SourceMap sourceIds]",
        JSON.stringify(p.sourceIds).slice(0, 500),
      );
      console.log(
        "[SourceMap sourceList]",
        sourceList
          .map((f, i) => `${i}:${f}`)
          .join(" | ")
          .slice(0, 500),
      );
      // 展开单个 source entry
      const firstEntry = Object.entries(src)[0];
      if (firstEntry)
        console.log(
          "[SourceMap firstSourceEntry full]",
          JSON.stringify(firstEntry[1]).slice(0, 300),
        );
    } catch (e) {
      console.log("[SourceMap structErr]", e);
    }
    // ── END DEBUG ──

    const monacoRange: monacoNS.IRange = {
      startLineNumber: startPos.lineNumber,
      startColumn: startPos.column,
      endLineNumber: endPos.lineNumber,
      endColumn: endPos.column,
    };

    if (activeFile !== fileName) {
      // Queue decoration for after the model switch completes
      pendingDecoration.current = monacoRange;
      pendingReveal.current = {
        line: startPos.lineNumber,
        col: startPos.column,
      };
      setActiveFile(fileName);
      return;
    }

    const editor = editorRef.current;
    if (!editor) return;
    if (!decorationsRef.current) {
      decorationsRef.current = editor.createDecorationsCollection([]);
    }
    decorationsRef.current.set([
      {
        range: monacoRange,
        options: {
          className: "sol-pc-highlight",
          overviewRuler: {
            color: "rgba(255,200,50,0.8)",
            position: monacoNS.editor.OverviewRulerLane.Full,
          },
        },
      },
    ]);
    editor.revealLineInCenterIfOutsideViewport(startPos.lineNumber);
  }, [
    currentPc,
    editorMounted,
    runtimeLocations,
    pcMap,
    sourceList,
    activeFile,
  ]);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;

    const svc = (editor as any)._codeEditorService;
    if (svc?.openCodeEditor) {
      const orig: (...a: unknown[]) => unknown = svc.openCodeEditor.bind(svc);
      svc.openCodeEditor = async (input: any, source: any) => {
        const uri = input?.resource as monacoNS.Uri | undefined;
        if (uri) {
          const path = uriToPath(uri);
          if (path) {
            const sel = input?.options?.selection;
            if (sel) {
              pendingReveal.current = {
                line: sel.startLineNumber,
                col: sel.startColumn,
              };
            }
            setActiveFile(path);
            return editor;
          }
        }
        return orig(input, source);
      };
    }

    setEditorMounted(true);
  }, []);

  // ── 读本地缓存 ────────────────────────────────────────────────────────────
  const loadCache = useCallback(async () => {
    if (chainId == null || !codeAddress) {
      setRawJson(null);
      return;
    }
    setRawJson(null);
    setLoadingCache(true);
    try {
      const cached = await invoke<string | null>("sourcify_read_cache", {
        chainId,
        address: codeAddress,
      });
      setRawJson(cached ?? null);
    } catch (e) {
      console.error(e);
      setRawJson(null);
    } finally {
      setLoadingCache(false);
    }
  }, [chainId, codeAddress]);

  useEffect(() => {
    void loadCache();
  }, [loadCache]);

  // ── 前端 fetch → 后端写缓存 ───────────────────────────────────────────────
  const handleFetch = async () => {
    if (chainId == null || !codeAddress) return;
    setFetching(true);
    try {
      const addr = codeAddress.toLowerCase().startsWith("0x")
        ? codeAddress
        : `0x${codeAddress}`;
      const resp = await fetch(
        `${SOURCIFY_BASE}/${chainId}/${addr}?fields=all`,
      );
      const body = await resp.text();
      if (!resp.ok)
        throw new Error(`Sourcify HTTP ${resp.status}: ${body.slice(0, 300)}`);
      await invoke("sourcify_write_cache", {
        chainId,
        address: codeAddress,
        json: body,
      });
      setRawJson(body);
      const src = extractSources(JSON.parse(body) as unknown);
      if (!src || Object.keys(src).length === 0) {
        toast.message("Sourcify returned no sources for this contract");
      } else {
        toast.success("Verified source loaded");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  const monacoTheme = document.documentElement.classList.contains("dark")
    ? "vs-dark"
    : "vs";

  let overlay: React.ReactNode = null;
  if (!chainId) {
    overlay = (
      <p className="text-[11px] text-muted-foreground">
        Start a debug session to load chain context.
      </p>
    );
  } else if (!codeAddress) {
    overlay = (
      <p className="text-[11px] text-muted-foreground">
        No contract address on the current frame.
      </p>
    );
  } else if (loadingCache) {
    overlay = (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking local cache…
      </div>
    );
  } else if (!rawJson) {
    overlay = (
      <>
        <p className="text-[11px] text-muted-foreground">
          No verified source cached for{" "}
          <span className="font-mono text-foreground/90">{codeAddress}</span>
          <span className="block mt-1 text-[10px]">chain {chainId}</span>
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="text-xs"
          disabled={fetching}
          onClick={() => void handleFetch()}
        >
          {fetching ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
              Fetching from Sourcify…
            </>
          ) : (
            "Try search from Sourcify"
          )}
        </Button>
      </>
    );
  } else if (!sources || fileNames.length === 0) {
    overlay = (
      <>
        <p className="text-[11px] text-muted-foreground">
          Response has no <code className="text-foreground/80">sources</code>{" "}
          field for{" "}
          <span className="font-mono text-foreground/90">{codeAddress}</span>
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="text-xs"
          disabled={fetching}
          onClick={() => void handleFetch()}
        >
          {fetching ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            "Re-fetch from Sourcify"
          )}
        </Button>
      </>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden relative">
      {/* 空状态 overlay */}
      {overlay && (
        <div className="absolute inset-0 z-10 bg-background flex flex-col items-center justify-center gap-3 px-4 text-center">
          {overlay}
        </div>
      )}

      {/* 文件 tab 列表（无 sources 时为空） */}
      <div
        ref={tabBarRef}
        className="flex-shrink-0 flex items-center gap-0.5 px-1 py-0.5 border-b border-border/80 overflow-x-auto scrollbar-hidden"
      >
        {fileNames.map((name) => (
          <Button
            key={name}
            ref={activeFile === name ? activeTabRef : undefined}
            type="button"
            variant={activeFile === name ? "default" : "ghost"}
            size="tabs"
            title={name}
            onClick={() => setActiveFile(name)}
            className="flex-shrink-0 max-w-[160px] font-mono shadow-none"
          >
            <FileCode className="h-2.5 w-2.5 opacity-70 shrink-0" />
            <span className="truncate">{basenameLabel(name)}</span>
          </Button>
        ))}
      </div>

      {/* Monaco Editor — 始终挂载 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Editor
          height="100%"
          theme={monacoTheme}
          defaultValue=""
          onMount={handleEditorMount}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: "off",
            fontSize: 11,
            lineNumbersMinChars: 3,
            folding: true,
            renderLineHighlight: "none",
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            contextmenu: true,
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            parameterHints: { enabled: false },
            hover: { enabled: false },
            links: false,
          }}
        />
      </div>

      {/* 编译信息折叠区（仅有源码时显示） */}
      {!overlay && compilation != null && (
        <details className="flex-shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">
            Compilation
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto text-[9px] font-mono whitespace-pre-wrap break-all">
            {JSON.stringify(compilation, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
