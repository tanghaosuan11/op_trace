import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { BottomSheetShell } from "@/components/ui/bottom-sheet-shell";
import { useDebugStore } from "@/store/debugStore";
import { useDrawerActions } from "@/hooks/useDrawerActions";
import { invoke } from "@tauri-apps/api/core";
import { Play, Square, Trash2, Copy, Loader2, Pin, PinOff, Save, Folder, FileText, PanelLeftClose, PanelLeftOpen, RefreshCw, CircleDot, ListVideo } from "lucide-react";
import {
  PanelContextMenu,
  PanelContextMenuTrigger,
  PanelContextMenuContent,
  PanelContextMenuItem,
  PanelContextMenuSeparator,
} from "@/components/ui/panel-context-menu";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  BUILTIN_SCRIPTS,
} from "@/lib/analysisScripts";
import { extractStepIndicesFromAnalysisResult } from "@/lib/analysisResultStepIndices";

const DEFAULT_SCRIPT = BUILTIN_SCRIPTS[0].code;

export type AnalysisDrawerProps = {
  /** Host resolves step indices → PC breakpoints (keeps Analysis UI free of breakpoint store details). */
  onInsertBreakpointsFromResult?: (resultText: string) => void;
  /** Replace step playback queue with indices from result (each run replaces previous). */
  onReplaceStepsToPlaybackFromResult?: (resultText: string) => void;
};

// Script header filters (comments anywhere in file):
//   // @filter opcodes:   SSTORE, SLOAD
//   // @filter contract:  0xA0b86991...
//   // @filter target:    0x1234...
//   // @filter frames:    1, 5, 10
//   // @filter transaction_id: 0   ← 与 frames 同用则必填（单 tx 写 0）

interface ScriptFilters {
  opcodes?:    string[];
  contracts?:  string[];
  targets?:    string[];
  frames?:     number[];
  /** [from, to] 全局步骤下标范围（含两端） */
  step_range?: [number, number];
  /** 仅分析该 transaction_id（多笔调试）；抽屉下拉可覆盖此项 */
  transaction_id?: number;
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
    if (key === "transaction_id") {
      const n = Number(val.trim());
      if (!Number.isNaN(n) && n >= 0) filters.transaction_id = n;
    }
  }

  return found ? filters : null;
}

type ScriptSource = { kind: "builtin"; id: string } | { kind: "fs"; path: string };

interface FsNode {
  kind: "dir" | "file";
  name: string;
  path: string;
  children?: FsNode[];
}

function TreeFileRow({
  name,
  depth,
  active,
  dirty,
  onClick,
  onContextOpen,
  onContextRename,
  onContextDelete,
}: {
  name: string;
  depth: number;
  active: boolean;
  dirty: boolean;
  onClick: () => void;
  onContextOpen?: () => void;
  onContextRename?: () => void;
  onContextDelete?: () => void;
}) {
  const row = (
    <div
      className={`flex items-center gap-1 px-2 py-1 cursor-pointer text-[11px] border-b border-border/40 transition-colors ${
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/50 text-muted-foreground"
      }`}
      onClick={onClick}
      style={{ paddingLeft: 8 + depth * 10 }}
      title={name}
    >
      <FileText className="h-2.5 w-2.5 flex-shrink-0 opacity-50" />
      <span className="min-w-0 truncate">
        {name}
        {dirty && <span className="text-orange-400 ml-0.5">*</span>}
      </span>
    </div>
  );

  if (!onContextDelete) return row;
  return (
    <PanelContextMenu>
      <PanelContextMenuTrigger asChild>{row}</PanelContextMenuTrigger>
      <PanelContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
        {onContextOpen && (
          <PanelContextMenuItem onSelect={() => onContextOpen()}>
            Open
          </PanelContextMenuItem>
        )}
        {onContextRename && (
          <PanelContextMenuItem onSelect={() => onContextRename()}>
            Rename
          </PanelContextMenuItem>
        )}
        <PanelContextMenuSeparator />
        <PanelContextMenuItem
          className="text-red-600 focus:text-red-600"
          onSelect={() => onContextDelete()}
        >
          Delete
        </PanelContextMenuItem>
      </PanelContextMenuContent>
    </PanelContextMenu>
  );
}

function TreeDirRow({
  name,
  depth,
  title,
  onToggle,
  menu,
  renameInput,
}: {
  name: string;
  depth: number;
  title: string;
  onToggle?: () => void;
  menu?: React.ReactNode;
  renameInput?: React.ReactNode;
}) {
  const sum = (
    <summary
      className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 cursor-pointer"
      style={{ paddingLeft: 8 + depth * 10 }}
      title={title}
      onClick={(e) => {
        // prevent native <details> toggling; parent controls open state
        e.preventDefault();
        onToggle?.();
      }}
    >
      <Folder className="h-3 w-3 opacity-60" />
      {renameInput ?? <span className="truncate">{name}</span>}
    </summary>
  );
  if (!menu) return sum;
  return (
    <PanelContextMenu>
      <PanelContextMenuTrigger asChild>{sum}</PanelContextMenuTrigger>
      {menu}
    </PanelContextMenu>
  );
}

function ScriptTreeDir({
  name,
  depth,
  defaultOpen,
  rootKind,
  nodes,
  ctxPath,
  scriptsRootMaxDepth,
  openFsDirs,
  setOpenFsDirs,
  active,
  dirty,
  creating,
  setCreating,
  createInputRef,
  beginCreate,
  commitCreate,
  renaming,
  setRenaming,
  renameInputRef,
  beginRename,
  commitRename,
  selectBuiltin,
  selectFs,
  deletePath,
}: {
  name: string;
  depth: number;
  defaultOpen?: boolean;
  rootKind: "builtin" | "fs";
  nodes: FsNode[];
  ctxPath?: string; // fs only
  scriptsRootMaxDepth: number;
  openFsDirs: Set<string>;
  setOpenFsDirs: React.Dispatch<React.SetStateAction<Set<string>>>;
  active: ScriptSource;
  dirty: boolean;
  creating: null | { parentDir: string; kind: "file" | "dir"; value: string };
  setCreating: React.Dispatch<React.SetStateAction<null | { parentDir: string; kind: "file" | "dir"; value: string }>>;
  createInputRef: React.RefObject<HTMLInputElement | null>;
  beginCreate: (parentDir: string, kind: "file" | "dir") => void;
  commitCreate: () => void;
  renaming: null | { path: string; kind: "file" | "dir"; value: string };
  setRenaming: React.Dispatch<React.SetStateAction<null | { path: string; kind: "file" | "dir"; value: string }>>;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  beginRename: (path: string, currentName: string, kind: "file" | "dir") => void;
  commitRename: () => void;
  selectBuiltin: (id: string) => void;
  selectFs: (path: string) => void;
  deletePath: (path: string) => void;
}) {
  const depthOfPath = (p: string) => (p ? p.split("/").filter(Boolean).length : 0);
  const maxed = rootKind === "fs" && depthOfPath(ctxPath ?? "") >= scriptsRootMaxDepth;
  const open =
    rootKind === "fs"
      ? (ctxPath ?? "") === "" || openFsDirs.has(ctxPath ?? "")
      : Boolean(defaultOpen);

  // Inline rename input rendered inside the dir's <summary> row.
  const isDirBeingRenamed =
    rootKind === "fs" && renaming?.path === ctxPath && (ctxPath ?? "") !== "";
  const renameInputNode = isDirBeingRenamed ? (
    <input
      ref={renameInputRef}
      className="h-5 flex-1 min-w-0 rounded border border-input bg-white px-1 font-mono text-[11px] outline-none"
      value={renaming!.value}
      onChange={(e) => setRenaming((p) => (p ? { ...p, value: e.target.value } : p))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commitRename();
        if (e.key === "Escape") setRenaming(null);
      }}
      onClick={(e) => e.stopPropagation()} // prevent <details> toggle click
    />
  ) : undefined;

  return (
    <details open={open} className="select-none">
      <TreeDirRow
        name={name}
        depth={depth}
        title={rootKind === "fs" ? ctxPath || "scripts" : "Built-in"}
        renameInput={renameInputNode}
        onToggle={
          rootKind === "fs" && (ctxPath ?? "") !== ""
            ? () =>
                setOpenFsDirs((prev) => {
                  const next = new Set(prev);
                  const p = ctxPath ?? "";
                  if (next.has(p)) next.delete(p);
                  else next.add(p);
                  next.add("");
                  return next;
                })
            : undefined
        }
        menu={
          rootKind === "fs" ? (
            <PanelContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
              <PanelContextMenuItem
                disabled={maxed}
                onSelect={() => beginCreate(ctxPath ?? "", "file")}
              >
                New File
              </PanelContextMenuItem>
              <PanelContextMenuItem
                disabled={maxed}
                onSelect={() => beginCreate(ctxPath ?? "", "dir")}
              >
                New Folder
              </PanelContextMenuItem>
              <PanelContextMenuSeparator />
              {(ctxPath ?? "") !== "" && (
                <>
                  <PanelContextMenuItem
                    onSelect={() => beginRename(ctxPath ?? "", name, "dir")}
                  >
                    Rename
                  </PanelContextMenuItem>
                  <PanelContextMenuItem
                    className="text-red-600 focus:text-red-600"
                    onSelect={() => deletePath(ctxPath ?? "")}
                  >
                    Delete
                  </PanelContextMenuItem>
                </>
              )}
            </PanelContextMenuContent>
          ) : undefined
        }
      />
      <div>
        {nodes.map((n) => {
          if (n.kind === "dir") {
            return (
              <ScriptTreeDir
                key={n.path}
                name={n.name}
                depth={depth + 1}
                rootKind={rootKind}
                nodes={n.children ?? []}
                ctxPath={rootKind === "fs" ? n.path : undefined}
                scriptsRootMaxDepth={scriptsRootMaxDepth}
                openFsDirs={openFsDirs}
                setOpenFsDirs={setOpenFsDirs}
                active={active}
                dirty={dirty}
                creating={creating}
                setCreating={setCreating}
                createInputRef={createInputRef}
                beginCreate={beginCreate}
                commitCreate={commitCreate}
                renaming={renaming}
                setRenaming={setRenaming}
                renameInputRef={renameInputRef}
                beginRename={beginRename}
                commitRename={commitRename}
                selectBuiltin={selectBuiltin}
                selectFs={selectFs}
                deletePath={deletePath}
              />
            );
          }
          const isActive =
            rootKind === "builtin"
              ? active.kind === "builtin" && active.id === n.path
              : active.kind === "fs" && active.path === n.path;
          const isDirty =
            dirty &&
            (rootKind === "builtin"
              ? active.kind === "builtin" && active.id === n.path
              : active.kind === "fs" && active.path === n.path);
          // If this file is being renamed, show an inline input instead of the row.
          if (rootKind === "fs" && renaming?.path === n.path) {
            return (
              <div
                key={n.path}
                className="flex items-center gap-1 px-2 py-1 text-[11px] border-b border-border/40 bg-muted/20"
                style={{ paddingLeft: 8 + (depth + 1) * 10 }}
              >
                <FileText className="h-2.5 w-2.5 flex-shrink-0 opacity-50" />
                <input
                  ref={renameInputRef}
                  className="h-5 flex-1 min-w-0 rounded border border-input bg-white px-1 font-mono text-[11px] outline-none"
                  value={renaming!.value}
                  onChange={(e) => setRenaming((p) => (p ? { ...p, value: e.target.value } : p))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              </div>
            );
          }
          return (
            <TreeFileRow
              key={n.path}
              name={n.name}
              depth={depth + 1}
              active={isActive}
              dirty={isDirty}
              onClick={() => {
                if (rootKind === "builtin") selectBuiltin(n.path);
                else selectFs(n.path);
              }}
              onContextOpen={rootKind === "fs" ? () => selectFs(n.path) : undefined}
              onContextRename={rootKind === "fs" ? () => beginRename(n.path, n.name, "file") : undefined}
              onContextDelete={rootKind === "fs" ? () => deletePath(n.path) : undefined}
            />
          );
        })}
        {rootKind === "fs" && creating?.parentDir === (ctxPath ?? "") && (
          <div
            className="flex items-center gap-1 px-2 py-1 text-[11px] border-b border-border/40 bg-muted/20"
            style={{ paddingLeft: 8 + (depth + 1) * 10 }}
          >
            {creating.kind === "dir"
              ? <Folder className="h-3 w-3 flex-shrink-0 opacity-60" />
              : <FileText className="h-2.5 w-2.5 flex-shrink-0 opacity-50" />}
            <input
              ref={createInputRef}
              className="h-5 flex-1 min-w-0 rounded border border-input bg-white px-1 font-mono text-[11px] outline-none"
              value={creating.value}
              onChange={(e) => setCreating((p) => (p ? { ...p, value: e.target.value } : p))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCreate();
                if (e.key === "Escape") setCreating(null);
              }}
              onBlur={() => {
                // Treat losing focus as "confirm".
                // Protected by creatingCommitRef in AnalysisDrawer to avoid double submits.
                commitCreate();
              }}
            />
          </div>
        )}
      </div>
    </details>
  );
}

export function AnalysisDrawer({
  onInsertBreakpointsFromResult,
  onReplaceStepsToPlaybackFromResult,
}: AnalysisDrawerProps) {
  const isOpen = useDebugStore((s) => s.isAnalysisOpen);
  const sessionId = useDebugStore((s) => s.sessionId);
  const stepCount = useDebugStore((s) => s.stepCount);
  const txBoundaries = useDebugStore((s) => s.txBoundaries);

  // 脚本树（文件系统 + 内置）
  const [fsTree, setFsTree] = useState<FsNode[]>([]);
  const [active, setActive] = useState<ScriptSource>({ kind: "builtin", id: BUILTIN_SCRIPTS[0].id });
  const [showList, setShowList] = useState(true);
  const [treeLoading, setTreeLoading] = useState(false);
  const [openFsDirs, setOpenFsDirs] = useState<Set<string>>(() => new Set([""])); // keep scripts root open

  // 编辑器
  const [code, setCode] = useState(DEFAULT_SCRIPT);
  const [result, setResult] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState<string>("");
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  const currentDebugChainId = useDebugStore((s) => s.currentDebugChainId);

  const [pinned, setPinned] = useState(false);
  /** 分析范围：全部步骤，或仅某笔 transaction_id（多笔会话） */
  const [analysisTxScope, setAnalysisTxScope] = useState<"all" | number>("all");
  const isGuide =
    active.kind === "builtin"
      ? (BUILTIN_SCRIPTS.find((s) => s.id === active.id)?.isGuide ?? false)
      : false;

  const multiTxCount = useMemo(() => {
    if (txBoundaries && txBoundaries.length > 0) return txBoundaries.length + 1;
    return 1;
  }, [txBoundaries]);
  const showAnalysisTxScope = stepCount > 0 && multiTxCount > 1;

  useEffect(() => {
    setAnalysisTxScope("all");
  }, [txBoundaries]);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const runningRef = useRef(false);

  const loadScriptTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const t = await invoke<FsNode[]>("list_analysis_scripts");
      setFsTree(Array.isArray(t) ? t : []);
    } catch (e) {
      console.warn("[analysis] list_analysis_scripts failed", e);
      setFsTree([]);
    } finally {
      setTreeLoading(false);
    }
  }, []);

  // 打开抽屉时加载脚本目录
  useEffect(() => {
    if (!isOpen) return;
    void loadScriptTree();
  }, [isOpen, loadScriptTree]);

  const selectBuiltin = useCallback((id: string) => {
    const found = BUILTIN_SCRIPTS.find((s) => s.id === id);
    if (!found) return;
    setActive({ kind: "builtin", id });
    setCode(found.code);
    setDirty(false);
    editorRef.current?.setValue(found.code);
  }, []);

  const selectFs = useCallback(async (path: string) => {
    try {
      const text = await invoke<string>("read_analysis_script", { path });
      setActive({ kind: "fs", path });
      setCode(text ?? "");
      setDirty(false);
      editorRef.current?.setValue(text ?? "");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const builtinList = useMemo(() => BUILTIN_SCRIPTS, []);

  const scriptsRootMaxDepth = 3;
  const splitPath = (p: string) => p.split("/").filter(Boolean);
  const depthOfPath = (p: string) => splitPath(p).length;
  const joinChild = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  const isValidName = (name: string) => {
    const t = name.trim();
    if (!t) return false;
    if (t.includes("/") || t.includes("\\") || t.includes("..")) return false;
    return true;
  };

  const refreshTree = useCallback(async () => {
    console.debug("[analysis.scripts] refreshTree");
    await loadScriptTree();
  }, [loadScriptTree]);

  const [creating, setCreating] = useState<null | { parentDir: string; kind: "file" | "dir"; value: string }>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);
  const creatingCommitRef = useRef(false);
  // 用于区分"初次打开输入框"和"后续每次 value 变化"，避免 select() 在每次输入时重跑
  const createFocusedRef = useRef(false);

  useEffect(() => {
    if (!creating) {
      createFocusedRef.current = false;
      return;
    }
    if (createFocusedRef.current) return; // 已聚焦，value 更新不重复 select
    createFocusedRef.current = true;
    // Focus after menu closes / DOM updates
    const id = window.setTimeout(() => {
      createInputRef.current?.focus();
      createInputRef.current?.select();
    }, 100);
    return () => window.clearTimeout(id);
  }, [creating]);

  const [renaming, setRenaming] = useState<null | { path: string; kind: "file" | "dir"; value: string }>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameFocusedRef = useRef(false);

  useEffect(() => {
    if (!renaming) {
      renameFocusedRef.current = false;
      return;
    }
    if (renameFocusedRef.current) return;
    renameFocusedRef.current = true;
    const id = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 100);
    return () => window.clearTimeout(id);
  }, [renaming]);

  const beginCreate = useCallback(
    (parentDir: string, kind: "file" | "dir") => {
      const parentDepth = depthOfPath(parentDir);
      if (parentDepth >= scriptsRootMaxDepth) {
        toast.error(`Max depth is ${scriptsRootMaxDepth}`);
        return;
      }
      // Ensure parent directory is expanded so the inline input is visible.
      setOpenFsDirs((prev) => {
        const next = new Set(prev);
        next.add("");
        next.add(parentDir);
        return next;
      });
      setCreating({ parentDir, kind, value: kind === "file" ? "new-script.js" : "new-folder" });
    },
    [],
  );

  const commitCreate = useCallback(async () => {
    if (creatingCommitRef.current) return;
    const c = creating;
    if (!c) return;
    const raw = c.value.trim();
    if (!raw) {
      setCreating(null);
      return;
    }
    if (!isValidName(raw)) {
      toast.error("Invalid name");
      return;
    }
    const name =
      c.kind === "file"
        ? (raw.toLowerCase().endsWith(".js") ? raw : `${raw}.js`)
        : raw;
    const child = joinChild(c.parentDir, name);
    if (depthOfPath(child) > scriptsRootMaxDepth) {
      toast.error(`Max depth is ${scriptsRootMaxDepth}`);
      return;
    }
    creatingCommitRef.current = true;
    try {
      if (c.kind === "dir") {
        await invoke("mkdir_analysis_script_dir", { path: child });
        toast.success(`Created folder: ${child}`);
        setCreating(null);
        await refreshTree();
      } else {
        await invoke("write_analysis_script", { path: child, code: "// new script\n" });
        toast.success(`Created file: ${child}`);
        setCreating(null);
        await refreshTree();
        await selectFs(child);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      creatingCommitRef.current = false;
    }
  }, [creating, refreshTree, selectFs]);

  const deletePath = useCallback(
    async (path: string) => {
      try {
        console.debug("[analysis.scripts] deletePath start", { path });
        toast.message("Deleting…");
        await invoke("delete_analysis_script_path", { path });
        toast.success("Deleted");
        // If current open file is deleted, fallback to built-in guide
        if (active.kind === "fs" && (active.path === path || active.path.startsWith(path + "/"))) {
          selectBuiltin(BUILTIN_SCRIPTS[0].id);
        }
        await refreshTree();
      } catch (e) {
        console.debug("[analysis.scripts] deletePath error", e);
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [active, refreshTree, selectBuiltin],
  );

  const beginRename = useCallback((path: string, currentName: string, kind: "file" | "dir") => {
    setRenaming({ path, kind, value: currentName });
  }, []);

  const commitRename = useCallback(async () => {
    const r = renaming;
    if (!r) return;
    const raw = r.value.trim();
    if (!raw) {
      setRenaming(null);
      return;
    }
    if (!isValidName(raw)) {
      toast.error("Invalid name");
      return;
    }
    const parentDir = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
    const finalName =
      r.kind === "file" && !raw.toLowerCase().endsWith(".js") ? `${raw}.js` : raw;
    const newPath = parentDir ? `${parentDir}/${finalName}` : finalName;
    if (newPath === r.path) {
      setRenaming(null);
      return;
    }
    try {
      await invoke("rename_analysis_script_path", { oldPath: r.path, newPath });
      // Update active selection if the renamed item (or its parent) was active.
      if (active.kind === "fs") {
        if (active.path === r.path) {
          if (r.kind === "file") await selectFs(newPath);
          else selectBuiltin(BUILTIN_SCRIPTS[0].id);
        } else if (r.kind === "dir" && active.path.startsWith(r.path + "/")) {
          await selectFs(newPath + active.path.slice(r.path.length));
        }
      }
      setRenaming(null);
      await refreshTree();
      toast.success("Renamed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [renaming, active, selectFs, selectBuiltin, refreshTree]);

  // 保存当前脚本
  const handleSave = useCallback(async () => {
    const currentCode = editorRef.current?.getValue() ?? code;
    if (active.kind !== "fs") return;
    await invoke("write_analysis_script", { path: active.path, code: currentCode });
    setDirty(false);
    toast.success("Saved");
  }, [active, code]);

  const { closeAnalysis: close } = useDrawerActions();

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
    setIsStopping(false);
    setIsRunning(true);
    setError("");
    setElapsedMs(null);
    const t0 = performance.now();

    try {
      const filters = parseScriptFilters(script);
      const hasFrames =
        filters?.frames != null && filters.frames.length > 0;
      const tidFromScript =
        filters?.transaction_id !== undefined && filters.transaction_id >= 0;
      const tidFromDrawer = analysisTxScope !== "all";
      if (hasFrames && !tidFromScript && !tidFromDrawer) {
        toast.error(
          "使用 @filter frames 时必须限定 transaction_id：在脚本中加入 // @filter transaction_id: N（单 tx 用 0），或在上方选择「仅 Tx k」。",
        );
        return;
      }
      const payload: Record<string, unknown> = {
        script,
        sessionId,
        chainId: currentDebugChainId?.toString(),
      };
      if (filters) payload.filters = filters;
      if (analysisTxScope !== "all") {
        payload.transactionId = analysisTxScope;
      }
      const res = await invoke<unknown>("run_analysis", payload);
      const ms = performance.now() - t0;
      setElapsedMs(Math.round(ms));
      setResult(JSON.stringify(res, null, 2));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setResult("");
    } finally {
      runningRef.current = false;
      setIsStopping(false);
      setIsRunning(false);
    }
  }, [code, stepCount, sessionId, currentDebugChainId, analysisTxScope]);

  const handleStop = useCallback(async () => {
    if (!isRunning) return;
    setIsStopping(true);
    try {
      await invoke("cancel_analysis", { sessionId });
    } catch { /* ignore */ }
  }, [sessionId, isRunning]);

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

  const handleBreakpointsFromResult = useCallback(() => {
    if (!result.trim() || !onInsertBreakpointsFromResult) return;
    onInsertBreakpointsFromResult(result);
  }, [result, onInsertBreakpointsFromResult]);

  const handleReplacePlaybackFromResult = useCallback(() => {
    if (!result.trim() || !onReplaceStepsToPlaybackFromResult) return;
    onReplaceStepsToPlaybackFromResult(result);
  }, [result, onReplaceStepsToPlaybackFromResult]);

  /** 与断点 / 队列逻辑一致：结果里至少有一个 stepIndex 类字段才可点 */
  const hasStepIndicesInResult = useMemo(() => {
    if (!result.trim() || error) return false;
    return extractStepIndicesFromAnalysisResult(result).length > 0;
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
    <BottomSheetShell
      open={isOpen}
      onOpenChange={(o) => { if (!o && !pinned) close(); }}
      sheetTitle="Analysis"
      defaultHeightVh={60}
      contentClassName="bg-white text-slate-900"
    >
        {/* Main content: script list | editor | result */}
        <div className="flex-1 flex min-h-0">
          {/* Left sidebar: Script list (collapsible) */}
          {showList && (
            <div className="w-44 flex-shrink-0 border-r border-border flex flex-col min-h-0 bg-white">
              <div className="flex shrink-0 items-center justify-between border-b border-border bg-slate-50 px-2 py-0.5">
                <span className="text-[10px] font-medium text-muted-foreground">Scripts</span>
                <div className="flex items-center gap-0.5">
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="Refresh script list"
                    className={`inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${treeLoading ? "opacity-60" : ""}`}
                    title="Refresh"
                    onClick={() => void refreshTree()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void refreshTree();
                      }
                    }}
                  >
                    <RefreshCw className={`h-2.5 w-2.5 ${treeLoading ? "animate-spin" : ""}`} />
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="Collapse script list"
                    className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    title="Collapse script list"
                    onClick={() => setShowList(false)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setShowList(false);
                      }
                    }}
                  >
                    <PanelLeftClose className="h-2.5 w-2.5" />
                  </span>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                <ScriptTreeDir
                  name="Built-in"
                  depth={0}
                  defaultOpen
                  rootKind="builtin"
                  nodes={builtinList.map((s) => ({ kind: "file" as const, name: s.name, path: s.id }))}
                  scriptsRootMaxDepth={scriptsRootMaxDepth}
                  openFsDirs={openFsDirs}
                  setOpenFsDirs={setOpenFsDirs}
                  active={active}
                  dirty={dirty}
                  creating={creating}
                  setCreating={setCreating}
                  createInputRef={createInputRef}
                  beginCreate={beginCreate}
                  commitCreate={commitCreate}
                  renaming={renaming}
                  setRenaming={setRenaming}
                  renameInputRef={renameInputRef}
                  beginRename={beginRename}
                  commitRename={commitRename}
                  selectBuiltin={selectBuiltin}
                  selectFs={(p) => void selectFs(p)}
                  deletePath={(p) => void deletePath(p)}
                />
                <div className="my-1 h-px bg-border/60" />
                <PanelContextMenu>
                  <PanelContextMenuTrigger asChild>
                    <div className="min-h-[6rem]">
                      <ScriptTreeDir
                        name="scripts"
                        depth={0}
                        defaultOpen
                        rootKind="fs"
                        nodes={fsTree}
                        ctxPath=""
                        scriptsRootMaxDepth={scriptsRootMaxDepth}
                        openFsDirs={openFsDirs}
                        setOpenFsDirs={setOpenFsDirs}
                        active={active}
                        dirty={dirty}
                        creating={creating}
                        setCreating={setCreating}
                        createInputRef={createInputRef}
                        beginCreate={beginCreate}
                        commitCreate={commitCreate}
                        renaming={renaming}
                        setRenaming={setRenaming}
                        renameInputRef={renameInputRef}
                        beginRename={beginRename}
                        commitRename={commitRename}
                        selectBuiltin={selectBuiltin}
                        selectFs={(p) => void selectFs(p)}
                        deletePath={(p) => void deletePath(p)}
                      />
                    </div>
                  </PanelContextMenuTrigger>
                  <PanelContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
                    <PanelContextMenuItem
                      onSelect={() => {
                        console.debug("[analysis.scripts] ctxmenu blank New File");
                        beginCreate("", "file");
                      }}
                    >
                      New File
                    </PanelContextMenuItem>
                    <PanelContextMenuItem
                      onSelect={() => {
                        console.debug("[analysis.scripts] ctxmenu blank New Folder");
                        beginCreate("", "dir");
                      }}
                    >
                      New Folder
                    </PanelContextMenuItem>
                    <PanelContextMenuSeparator />
                    <PanelContextMenuItem
                      onSelect={() => {
                        console.debug("[analysis.scripts] ctxmenu blank Refresh");
                        void refreshTree();
                      }}
                    >
                      Refresh
                    </PanelContextMenuItem>
                  </PanelContextMenuContent>
                </PanelContextMenu>
              </div>
            </div>
          )}

          {/* Middle: Monaco editor */}
          <div className="flex flex-col flex-1 border-r border-border min-h-0">
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-slate-50 px-2 py-0.5">
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
              {showAnalysisTxScope && (
                <label className="flex items-center gap-1 text-[10px] text-muted-foreground ml-1">
                  <span className="whitespace-nowrap">分析</span>
                  <select
                    className="h-5 max-w-[11rem] rounded border border-input bg-background px-1 text-[10px] font-mono"
                    value={analysisTxScope === "all" ? "all" : String(analysisTxScope)}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAnalysisTxScope(v === "all" ? "all" : Number(v));
                    }}
                    title="仅注入该笔交易的步到 trace（与 @filter 合并时，以下拉为准）"
                  >
                    <option value="all">全部（跨笔）</option>
                    {Array.from({ length: multiTxCount }, (_, i) => (
                      <option key={i} value={i}>
                        仅 Tx {i + 1} (id={i})
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="ml-auto flex items-center gap-1">
                {/* Save */}
                <button
                  onClick={handleSave}
                  disabled={!dirty || active.kind !== "fs"}
                  className="flex items-center gap-1 h-5 px-1.5 text-[10px] font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Save (Ctrl+S)"
                >
                  <Save className="h-2.5 w-2.5" />
                  Save
                </button>
                {/* Run */}
                <button
                  onClick={handleRun}
                  disabled={isRunning || isStopping || !stepCount || isGuide}
                  className="flex items-center gap-1 h-5 px-1.5 text-[10px] font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={isGuide ? "Guide — not executable" : "Run (Ctrl+Enter)"}
                >
                  {isRunning ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
                  Run
                </button>
                {/* Stop */}
                <button
                  onClick={handleStop}
                  disabled={!isRunning || isStopping}
                  className="flex items-center gap-1 h-5 px-1.5 text-[10px] font-medium rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Stop"
                >
                  {isStopping ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Square className="h-2.5 w-2.5" />}
                  {isStopping ? "Stopping..." : "Stop"}
                </button>
                <div className="w-px h-3 bg-border mx-0.5" aria-hidden />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleClearCode}
                  title="Clear script"
                  className="h-5 shrink-0 gap-0.5 px-1.5 py-0 text-[10px] font-medium leading-none text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-2.5"
                >
                  <Trash2 />
                  Clear
                </Button>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <Editor
                defaultLanguage="javascript"
                defaultValue={code}
                onChange={(v) => { setCode(v ?? ""); setDirty(true); }}
                onMount={handleEditorMount}
                theme="vs"
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
            <div className="flex shrink-0 items-center justify-between border-b border-border bg-slate-50 px-2 py-0.5">
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
                <div className="w-px h-3 bg-border mx-0.5" aria-hidden />
                {onInsertBreakpointsFromResult ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleBreakpointsFromResult}
                    disabled={!result.trim() || !!error || !hasStepIndicesInResult}
                    title={
                      hasStepIndicesInResult
                        ? "Add breakpoints at PCs for each stepIndex / global_step in result"
                        : "No stepIndex / global_step in result"
                    }
                    className="h-5 shrink-0 gap-0.5 border-border/80 bg-background/80 px-1.5 py-0 text-[10px] font-medium leading-none shadow-none hover:bg-accent [&_svg]:size-2.5"
                  >
                    <CircleDot className="text-red-500" />
                    Breakpoints
                  </Button>
                ) : null}
                {onReplaceStepsToPlaybackFromResult ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleReplacePlaybackFromResult}
                    disabled={!result.trim() || !!error || !hasStepIndicesInResult}
                    title={
                      hasStepIndicesInResult
                        ? "Replace playback queue with stepIndex / global_step from result (opens bar)"
                        : "No stepIndex / global_step in result"
                    }
                    className="h-5 shrink-0 gap-0.5 border-border/80 bg-background/80 px-1.5 py-0 text-[10px] font-medium leading-none shadow-none hover:bg-accent [&_svg]:size-2.5"
                  >
                    <ListVideo className="text-emerald-600" />
                    Play
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCopyResult}
                  disabled={!result && !error}
                  title="Copy result"
                  className="h-5 shrink-0 gap-0.5 border-border/80 bg-background/80 px-1.5 py-0 text-[10px] font-medium leading-none shadow-none hover:bg-accent [&_svg]:size-2.5"
                >
                  <Copy />
                  Copy
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleClearResult}
                  title="Clear result"
                  className="h-5 shrink-0 gap-0.5 px-1.5 py-0 text-[10px] font-medium leading-none text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-2.5"
                >
                  <Trash2 />
                  Clear
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-white p-2 text-[11px] font-mono min-h-0">
              {isRunning && !result && !error && (
                <div className="flex items-center gap-2 text-muted-foreground p-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{isStopping ? "Stopping analysis..." : "Running analysis..."}</span>
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
    </BottomSheetShell>
  );
}

function AnalysisResultView({ result }: { result: string }) {
  const seekToStep = useDebugStore((s) => s.seekToStep);
  const parsed = useMemo(() => {
    try {
      return JSON.parse(result) as unknown;
    } catch {
      return null;
    }
  }, [result]);

  type Finding = {
    id?: string;
    title?: string;
    severity?: string;
    stepIndex?: number;
    description?: string;
    transactionId?: number;
    contextId?: number;
    guardConfidence?: string;
  };

  const findings = useMemo(() => {
    if (!parsed || typeof parsed !== "object") return [] as Finding[];
    const obj = parsed as Record<string, unknown>;
    if (obj.kind !== "ctf-findings" || !Array.isArray(obj.findings)) return [] as Finding[];
    return obj.findings.filter((x): x is Finding => !!x && typeof x === "object");
  }, [parsed]);

  const severityCls = (sev?: string) => {
    const s = (sev || "").toLowerCase();
    if (s === "critical") return "text-red-600 bg-red-50 border-red-200";
    if (s === "high") return "text-orange-600 bg-orange-50 border-orange-200";
    if (s === "medium") return "text-yellow-700 bg-yellow-50 border-yellow-200";
    return "text-slate-600 bg-slate-50 border-slate-200";
  };
  const guardCls = (v?: string) => {
    const s = (v || "").toLowerCase();
    if (s === "confirmed") return "text-emerald-700 bg-emerald-50 border-emerald-200";
    if (s === "oz-like") return "text-teal-700 bg-teal-50 border-teal-200";
    if (s === "possible") return "text-sky-700 bg-sky-50 border-sky-200";
    return "text-slate-600 bg-slate-50 border-slate-200";
  };

  // 把 "stepIndex": NUMBER 中的数字渲染为可点击 span，其余保持原始文本
  const parts = result.split(/("stepIndex"\s*:\s*)(\d+)/g);
  // split with 2 capture groups → [text, key, num, text, key, num, ...]
  // i%3===0: plain text, i%3===1: key part, i%3===2: the number

  return (
    <div className="space-y-2">
      {findings.length > 0 && (
        <div className="rounded border border-border/70 bg-slate-50 p-2">
          <div className="mb-1 text-[11px] font-semibold text-slate-700">
            CTF Findings ({findings.length})
          </div>
          <div className="space-y-1.5">
            {findings.map((f, i) => (
              <div key={f.id ?? i} className="rounded border border-border/60 bg-white px-2 py-1">
                <div className="flex items-center gap-1.5">
                  <span className={`rounded border px-1 py-0 text-[10px] font-semibold uppercase ${severityCls(f.severity)}`}>
                    {f.severity ?? "info"}
                  </span>
                  {f.guardConfidence && (
                    <span className={`rounded border px-1 py-0 text-[10px] font-semibold ${guardCls(f.guardConfidence)}`}>
                      guard:{f.guardConfidence}
                    </span>
                  )}
                  <span className="text-[11px] font-medium text-slate-800">{f.title ?? "Finding"}</span>
                  {typeof f.stepIndex === "number" && seekToStep && (
                    <button
                      className="ml-auto text-[10px] text-blue-600 underline underline-offset-2 hover:text-blue-500"
                      onClick={() => seekToStep(f.stepIndex as number)}
                      title={`Jump to step ${f.stepIndex}`}
                    >
                      step {f.stepIndex}
                    </button>
                  )}
                </div>
                {f.description && (
                  <div className="mt-0.5 text-[10px] text-slate-600">{f.description}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
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
    </div>
  );
}
