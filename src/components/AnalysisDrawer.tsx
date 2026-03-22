import { useRef, useState, useCallback, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useDebugStore } from "@/store/debugStore";
import { invoke } from "@tauri-apps/api/core";
import { Play, Square, Trash2, Copy, Loader2, Pin, PinOff, Save, Plus, FileText, Lock, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { toast } from "sonner";
import {
  BUILTIN_SCRIPTS,
  listUserScripts,
  saveUserScript,
  deleteUserScript,
  mergeScripts,
  type ScriptEntry,
  type UserScript,
} from "@/lib/analysisScripts";

const DEFAULT_SCRIPT = BUILTIN_SCRIPTS[0].code;

// ── 脚本头部过滤器解析 ────────────────────────────────────────────────────────
// 支持格式（写在脚本任意行注释里）：
//   // @filter opcodes:   SSTORE, SLOAD
//   // @filter contract:  0xA0b86991...
//   // @filter target:    0x1234...
//   // @filter frames:    1, 5, 10

interface ScriptFilters {
  opcodes?:    string[];
  contracts?:  string[];
  targets?:    string[];
  frames?:     number[];
  /** [from, to] 全局步骤下标范围（含两端） */
  step_range?: [number, number];
  /** 懒加载：跳过 inject_trace，trace/steps 为空，靠 query API 按需取数据 */
  lazy?:       boolean;
}

function parseScriptFilters(script: string): ScriptFilters | null {
  const filters: ScriptFilters = {};
  let found = false;

  for (const raw of script.split("\n")) {
    // @lazy 指令（独立一行）
    if (/^\/\/\s*@lazy\b/.test(raw.trim())) {
      filters.lazy = true;
      found = true;
      continue;
    }

    const m = raw.match(/^\/\/\s*@filter\s+(\w+)\s*:\s*(.+)/);
    if (!m) continue;
    found = true;
    const key = m[1].toLowerCase();
    const val = m[2].trim();

    if (key === "opcodes")  { filters.opcodes    = val.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean); }
    if (key === "contract") { filters.contracts   = val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean); }
    if (key === "target")   { filters.targets     = val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean); }
    if (key === "frames")   { filters.frames      = val.split(",").map((s) => Number(s.trim())).filter((n) => !isNaN(n)); }
    if (key === "steps") {
      // 格式：1000-5000  或  1000, 5000
      const rangeM = val.match(/^(\d+)\s*[-,]\s*(\d+)$/);
      if (rangeM) filters.step_range = [Number(rangeM[1]), Number(rangeM[2])];
    }
  }

  return found ? filters : null;
}

export function AnalysisDrawer() {
  const isOpen = useDebugStore((s) => s.isAnalysisOpen);
  const stepCount = useDebugStore((s) => s.stepCount);

  // 脚本列表
  const [scripts, setScripts] = useState<ScriptEntry[]>(BUILTIN_SCRIPTS);
  const [activeId, setActiveId] = useState<string>(BUILTIN_SCRIPTS[0].id);
  const [listLoaded, setListLoaded] = useState(false);
  const [showList, setShowList] = useState(true);
  const [hiddenBuiltins, setHiddenBuiltins] = useState<Set<string>>(new Set());

  // 编辑器
  const [code, setCode] = useState(DEFAULT_SCRIPT);
  const [result, setResult] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string>("");
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  const [pinned, setPinned] = useState(false);
  const isGuide = scripts.find((s) => s.id === activeId)?.isGuide ?? false;
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const runningRef = useRef(false);

  // 加载用户脚本
  useEffect(() => {
    if (!isOpen || listLoaded) return;
    listUserScripts().then((userScripts) => {
      setScripts(mergeScripts(userScripts));
      setListLoaded(true);
    });
  }, [isOpen, listLoaded]);

  // 切换脚本
  const selectScript = useCallback((id: string) => {
    const found = scripts.find((s) => s.id === id);
    if (!found) return;
    setActiveId(id);
    setCode(found.code);
    setDirty(false);
    editorRef.current?.setValue(found.code);
  }, [scripts]);

  // 新建用户脚本
  const handleNew = useCallback(() => {
    const id = crypto.randomUUID();
    const entry: ScriptEntry = {
      id,
      name: "untitled",
      code: "// new script\n",
      readonly: false,
      updatedAt: Date.now(),
    };
    setScripts((prev) => [...prev, entry]);
    setActiveId(id);
    setCode(entry.code);
    setDirty(false);
    editorRef.current?.setValue(entry.code);
    // 立即持久化（空脚本也保存，避免丢失）
    saveUserScript({ id, name: entry.name, code: entry.code, updatedAt: entry.updatedAt });
  }, []);

  // 保存当前脚本
  const handleSave = useCallback(async () => {
    const active = scripts.find((s) => s.id === activeId);
    if (!active || active.readonly) return;
    const currentCode = editorRef.current?.getValue() ?? code;
    const updated: UserScript = {
      id: active.id,
      name: active.name,
      code: currentCode,
      updatedAt: Date.now(),
    };
    await saveUserScript(updated);
    setScripts((prev) =>
      prev.map((s) => (s.id === activeId ? { ...s, code: currentCode, updatedAt: updated.updatedAt } : s))
    );
    setDirty(false);
    toast.success("Saved");
  }, [scripts, activeId, code]);

  // 删除脚本
  const handleDelete = useCallback(async (id: string) => {
    const target = scripts.find((s) => s.id === id);
    if (!target) return;
    if (target.readonly) {
      // 内置脚本：从列表隐藏
      setHiddenBuiltins((prev) => new Set(prev).add(id));
    } else {
      await deleteUserScript(id);
      setScripts((prev) => prev.filter((s) => s.id !== id));
    }
    if (activeId === id) {
      const remaining = scripts.filter((s) => s.id !== id && !hiddenBuiltins.has(s.id));
      const fallback = remaining[0] ?? BUILTIN_SCRIPTS[0];
      setActiveId(fallback.id);
      setCode(fallback.code);
      setDirty(false);
      editorRef.current?.setValue(fallback.code);
    }
  }, [scripts, activeId, hiddenBuiltins]);

  // 重命名
  const handleRename = useCallback((id: string, name: string) => {
    setScripts((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name } : s))
    );
    // 异步持久化
    const target = scripts.find((s) => s.id === id);
    if (target && !target.readonly) {
      saveUserScript({ id, name, code: target.code, updatedAt: Date.now() });
    }
  }, [scripts]);

  const close = useCallback(() => {
    useDebugStore.getState().sync({ isAnalysisOpen: false });
  }, []);

  const handleRun = useCallback(async () => {
    if (runningRef.current) return;
    if (isGuide) return;
    if (!stepCount) {
      toast.error("No debug session active");
      return;
    }

    const script = editorRef.current?.getValue() ?? code;
    if (!script.trim()) {
      toast.error("Script is empty");
      return;
    }

    runningRef.current = true;
    setIsRunning(true);
    setError("");
    setElapsedMs(null);
    const t0 = performance.now();

    try {
      const filters = parseScriptFilters(script);
      const res = await invoke<unknown>("run_analysis", { script, filters });
      const ms = performance.now() - t0;
      setElapsedMs(Math.round(ms));
      setResult(JSON.stringify(res, null, 2));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setResult("");
    } finally {
      runningRef.current = false;
      setIsRunning(false);
    }
  }, [code, stepCount]);

  const handleStop = useCallback(async () => {
    try {
      await invoke("cancel_analysis");
    } catch { /* ignore */ }
  }, []);

  const handleClearCode = useCallback(() => {
    editorRef.current?.setValue("");
    setCode("");
    setDirty(true);
  }, []);

  const handleClearResult = useCallback(() => {
    setResult("");
    setError("");
    setElapsedMs(null);
  }, []);

  const handleCopyResult = useCallback(() => {
    const text = error || result;
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => toast.success("Copied"),
      () => toast.error("Copy failed"),
    );
  }, [result, error]);

  const handleEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    // Ctrl+Enter / Cmd+Enter to run
    editor.addCommand(
      // Monaco KeyMod.CtrlCmd | KeyCode.Enter
      2048 | 3, // CtrlCmd = 2048, Enter = 3
      () => handleRun(),
    );
    // Ctrl+S / Cmd+S to save
    editor.addCommand(
      2048 | 49, // CtrlCmd = 2048, KeyS = 49
      () => handleSave(),
    );
  };

  return (
    <Sheet open={isOpen} onOpenChange={(o) => { if (!o && !pinned) close(); }}>
      <SheetContent
        side="bottom"
        className="flex flex-col p-0 gap-0 [&>button:first-child]:hidden border-t border-border shadow-[0_-4px_12px_rgba(0,0,0,0.18)]"
        style={{ height: "60vh" }}
      >
        <SheetTitle className="sr-only">Analysis</SheetTitle>

        {/* Main content: script list | editor | result */}
        <div className="flex-1 flex min-h-0">
          {/* Left sidebar: Script list (collapsible) */}
          {showList && (
            <div className="w-44 flex-shrink-0 border-r border-border flex flex-col min-h-0 bg-muted/20">
              <div className="flex items-center justify-between px-2 py-1 border-b border-border bg-muted/30">
                <span className="text-[10px] text-muted-foreground font-medium">Scripts</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleNew}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="New script"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => setShowList(false)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Collapse script list"
                  >
                    <PanelLeftClose className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {scripts.filter((s) => !hiddenBuiltins.has(s.id)).map((s) => (
                  <ScriptListItem
                    key={s.id}
                    script={s}
                    isActive={s.id === activeId}
                    isDirty={s.id === activeId && dirty}
                    onSelect={() => selectScript(s.id)}
                    onDelete={() => handleDelete(s.id)}
                    onRename={(name) => handleRename(s.id, name)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Middle: Monaco editor */}
          <div className="flex flex-col flex-1 border-r border-border min-h-0">
            <div className="flex items-center gap-1 px-2 py-0.5 bg-muted/30 border-b flex-shrink-0">
              {!showList && (
                <button
                  onClick={() => setShowList(true)}
                  className="text-muted-foreground hover:text-foreground transition-colors mr-1"
                  title="Show script list"
                >
                  <PanelLeftOpen className="h-3 w-3" />
                </button>
              )}
              <span className="text-[10px] text-muted-foreground mr-1">Script</span>
              <span className="text-[10px] text-muted-foreground/60">
                {stepCount > 0 ? `${stepCount.toLocaleString()} steps` : "no session"}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {/* Save */}
                <button
                  onClick={handleSave}
                  disabled={!dirty || scripts.find((s) => s.id === activeId)?.readonly}
                  className="flex items-center gap-1 h-5 px-1.5 text-[10px] font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Save (Ctrl+S)"
                >
                  <Save className="h-2.5 w-2.5" />
                  Save
                </button>
                {/* Run */}
                <button
                  onClick={handleRun}
                  disabled={isRunning || !stepCount || isGuide}
                  className="flex items-center gap-1 h-5 px-1.5 text-[10px] font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={isGuide ? "Guide — not executable" : "Run (Ctrl+Enter)"}
                >
                  {isRunning ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
                  Run
                </button>
                {/* Stop */}
                <button
                  onClick={handleStop}
                  disabled={!isRunning}
                  className="flex items-center gap-1 h-5 px-1.5 text-[10px] font-medium rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Stop"
                >
                  <Square className="h-2.5 w-2.5" />
                  Stop
                </button>
                <div className="w-px h-3 bg-border mx-0.5" />
                <button
                  onClick={handleClearCode}
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                  title="Clear script"
                >
                  <Trash2 className="h-2.5 w-2.5" />
                  Clear
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <Editor
                defaultLanguage="javascript"
                defaultValue={code}
                onChange={(v) => { setCode(v ?? ""); setDirty(true); }}
                onMount={handleEditorMount}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  tabSize: 2,
                  automaticLayout: true,
                  padding: { top: 4, bottom: 4 },
                  overviewRulerLanes: 0,
                  hideCursorInOverviewRuler: true,
                  overviewRulerBorder: false,
                  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                }}
              />
            </div>
          </div>

          {/* Right: Result panel */}
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center justify-between px-2 py-0.5 bg-muted/30 border-b flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground">Result</span>
                {elapsedMs !== null && (
                  <span className="text-[10px] text-muted-foreground/70">{elapsedMs}ms</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPinned((p) => !p)}
                  className={`flex items-center justify-center transition-opacity ${
                    pinned ? "opacity-100 text-primary" : "opacity-50 hover:opacity-100 text-muted-foreground"
                  }`}
                  title={pinned ? "Pinned — click outside won't close" : "Pin drawer"}
                >
                  {pinned ? <Pin className="h-2.5 w-2.5" /> : <PinOff className="h-2.5 w-2.5" />}
                </button>
                <div className="w-px h-3 bg-border mx-0.5" />
                <button
                  onClick={handleCopyResult}
                  disabled={!result && !error}
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5 disabled:opacity-30"
                  title="Copy result"
                >
                  <Copy className="h-2.5 w-2.5" />
                  Copy
                </button>
                <button
                  onClick={handleClearResult}
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                  title="Clear result"
                >
                  <Trash2 className="h-2.5 w-2.5" />
                  Clear
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-2 text-[11px] font-mono min-h-0">
              {isRunning && !result && !error && (
                <div className="flex items-center gap-2 text-muted-foreground p-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Running analysis...</span>
                </div>
              )}
              {error && (
                <pre className="text-red-400 whitespace-pre-wrap break-all">{error}</pre>
              )}
              {result && !error && (
                <AnalysisResultView result={result} />
              )}
              {!isRunning && !result && !error && (
                <div className="text-muted-foreground/50 p-2">
                  Press Run or Ctrl+Enter to execute the script
                </div>
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── 分析结果渲染 ─────────────────────────────── */

function AnalysisResultView({ result }: { result: string }) {
  const seekToStep = useDebugStore((s) => s.seekToStep);

  // 把 "stepIndex": NUMBER 中的数字渲染为可点击 span，其余保持原始文本
  const parts = result.split(/("stepIndex"\s*:\s*)(\d+)/g);
  // split with 2 capture groups → [text, key, num, text, key, num, ...]
  // i%3===0: plain text, i%3===1: key part, i%3===2: the number

  return (
    <pre className="text-foreground whitespace-pre-wrap break-all">
      {parts.map((part, i) => {
        if (i % 3 === 2 && seekToStep) {
          const idx = parseInt(part, 10);
          return (
            <span
              key={i}
              className="text-blue-400 underline underline-offset-2 cursor-pointer hover:text-blue-300"
              onClick={() => seekToStep(idx)}
              title={`Jump to step ${idx}`}
            >
              {part}
            </span>
          );
        }
        return part;
      })}
    </pre>
  );
}

/* ── 脚本列表子组件 ─────────────────────────────── */

function ScriptListItem({
  script,
  isActive,
  isDirty,
  onSelect,
  onDelete,
  onRename,
}: {
  script: ScriptEntry;
  isActive: boolean;
  isDirty: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(script.name);

  const commitRename = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== script.name) {
      onRename(trimmed);
    }
    setEditing(false);
  };

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1 cursor-pointer text-[11px] border-b border-border/40 transition-colors ${
        isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted/50 text-muted-foreground"
      }`}
      onClick={onSelect}
      onDoubleClick={() => {
        if (!script.readonly) {
          setEditName(script.name);
          setEditing(true);
        }
      }}
      title={script.readonly ? `${script.name} (built-in)` : script.name}
    >
      {script.readonly ? (
        <Lock className="h-2.5 w-2.5 flex-shrink-0 opacity-40" />
      ) : (
        <FileText className="h-2.5 w-2.5 flex-shrink-0 opacity-50" />
      )}
      {editing ? (
        <input
          autoFocus
          className="flex-1 min-w-0 bg-transparent border-b border-primary text-[11px] outline-none px-0"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 min-w-0 truncate">
          {script.name}
          {isDirty && <span className="text-orange-400 ml-0.5">*</span>}
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity flex-shrink-0"
        title={script.readonly ? "Hide" : "Delete"}
      >
        <Trash2 className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}
