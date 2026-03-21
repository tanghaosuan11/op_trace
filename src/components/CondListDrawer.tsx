import { useState } from "react";
import { useDebugStore } from "@/store/debugStore";
import { PAUSE_CONDITION_LABELS, type CondNode } from "@/lib/pauseConditions";
import { Button } from "@/components/ui/button";
import { ResizableSideDrawer } from "@/components/ui/resizable-side-drawer";

interface CondListDrawerProps {
  onRunConditionScan?: () => void;
  disabled?: boolean;
}

// ── 递归渲染一棵 CondNode ────────────────────────────────────────
function CondNodeItem({
  node,
  onRemove,
  onToggleEnabled,
  selected,
  onSelect,
  canSelect,
}: {
  node: CondNode;
  onRemove: (id: string) => void;
  onToggleEnabled: (id: string) => void;
  selected: Set<string>;
  onSelect: (id: string) => void;
  canSelect: boolean;
}) {
  if (node.kind === "leaf") {
    const { cond } = node;
    return (
      <div className={`flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded-sm ${
        cond.enabled ? "bg-muted" : "bg-muted/30 opacity-50"
      } ${selected.has(node.id) ? "ring-1 ring-primary" : ""}`}>
        {/* 启用复选框 */}
        <input
          type="checkbox"
          checked={cond.enabled}
          onChange={() => onToggleEnabled(node.id)}
          className="h-3 w-3 accent-primary shrink-0 cursor-pointer"
          title={cond.enabled ? "禁用" : "启用"}
        />
        {/* 合并用复选框（仅顶层节点）*/}
        {canSelect && (
          <input
            type="checkbox"
            checked={selected.has(node.id)}
            onChange={() => onSelect(node.id)}
            className="h-3 w-3 accent-sky-500 shrink-0 cursor-pointer"
            title="选中以合并"
          />
        )}
        <span className="text-muted-foreground shrink-0">{PAUSE_CONDITION_LABELS[cond.type]}</span>
        <span className="flex-1 break-all text-foreground min-w-0">{cond.value}</span>
        <button
          onClick={() => onRemove(node.id)}
          className="text-muted-foreground hover:text-destructive shrink-0 leading-none px-0.5"
          title="删除"
        >×</button>
      </div>
    );
  }

  // compound
  return (
    <div className={`rounded-sm border px-2 py-1.5 space-y-1 ${
      selected.has(node.id) ? "border-primary" : "border-border"
    }`}>
      {/* compound 头 */}
      <div className="flex items-center gap-1.5">
        {canSelect && (
          <input
            type="checkbox"
            checked={selected.has(node.id)}
            onChange={() => onSelect(node.id)}
            className="h-3 w-3 accent-sky-500 shrink-0 cursor-pointer"
            title="选中以合并"
          />
        )}
        <span className={`text-[10px] font-mono font-bold px-1 py-0.5 rounded-sm ${
          node.op === "AND"
            ? "bg-blue-500/20 text-blue-400"
            : "bg-orange-500/20 text-orange-400"
        }`}>{node.op}</span>
        <span className="text-[10px] text-muted-foreground">复合条件</span>
        <button
          onClick={() => onRemove(node.id)}
          className="ml-auto text-muted-foreground hover:text-destructive leading-none px-0.5"
          title="删除整个复合条件"
        >×</button>
      </div>
      {/* 子节点 */}
      <div className="pl-2 space-y-1 border-l-2 border-muted-foreground/20">
        <CondNodeItem node={node.left} onRemove={onRemove} onToggleEnabled={onToggleEnabled}
          selected={selected} onSelect={onSelect} canSelect={false} />
        <CondNodeItem node={node.right} onRemove={onRemove} onToggleEnabled={onToggleEnabled}
          selected={selected} onSelect={onSelect} canSelect={false} />
      </div>
    </div>
  );
}

// ── 在树中按 id 删除节点，返回新树或 null ──────────────────────
function removeFromTree(node: CondNode, id: string): CondNode | null {
  if (node.id === id) return null;
  if (node.kind === "leaf") return node;
  const left = removeFromTree(node.left, id);
  const right = removeFromTree(node.right, id);
  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;
  return { ...node, left, right };
}

// ── 在树中按叶子 id 翻转 enabled ─────────────────────────────
function toggleEnabledInTree(node: CondNode, leafId: string): CondNode {
  if (node.kind === "leaf") {
    if (node.id !== leafId) return node;
    return { ...node, cond: { ...node.cond, enabled: !node.cond.enabled } };
  }
  return {
    ...node,
    left: toggleEnabledInTree(node.left, leafId),
    right: toggleEnabledInTree(node.right, leafId),
  };
}

export function CondListDrawer({ onRunConditionScan, disabled = false }: CondListDrawerProps) {
  const isOpen = useDebugStore((s) => s.isCondListOpen);
  const condNodes = useDebugStore((s) => s.condNodes);
  const close = () => useDebugStore.getState().sync({ isCondListOpen: false });

  // 用于合并的两个选中 id
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mergeOp, setMergeOp] = useState<"AND" | "OR">("AND");

  // 叶子总数（限制最多 3 个）
  const totalLeaves = condNodes.reduce((sum, n) => {
    const count = (nd: CondNode): number => nd.kind === "leaf" ? 1 : count(nd.left) + count(nd.right);
    return sum + count(n);
  }, 0);

  function handleRemove(id: string) {
    const next = condNodes
      .map(n => removeFromTree(n, id))
      .filter((n): n is CondNode => n !== null);
    const update: Record<string, unknown> = { condNodes: next };
    if (next.length === 0) {
      update.conditionHitSet = new Set<number>();
      update.scanHits = [];
    }
    useDebugStore.getState().sync(update);
    setSelected(prev => { const s = new Set(prev); s.delete(id); return s; });
  }

  function handleToggleEnabled(leafId: string) {
    const next = condNodes.map(n => toggleEnabledInTree(n, leafId));
    useDebugStore.getState().sync({ condNodes: next });
  }

  function handleSelect(id: string) {
    setSelected(prev => {
      const s = new Set(prev);
      if (s.has(id)) { s.delete(id); return s; }
      if (s.size >= 2) return prev; // 最多选 2 个
      s.add(id);
      return s;
    });
  }

  function handleMerge() {
    if (selected.size !== 2) return;
    const [idA, idB] = [...selected];
    const nodeA = condNodes.find(n => n.id === idA);
    const nodeB = condNodes.find(n => n.id === idB);
    if (!nodeA || !nodeB) return;
    const compound: CondNode = {
      kind: "compound",
      id: crypto.randomUUID(),
      op: mergeOp,
      left: nodeA,
      right: nodeB,
    };
    // 移除 A 和 B，插入 compound
    const next = condNodes
      .filter(n => n.id !== idA && n.id !== idB)
      .concat(compound);
    useDebugStore.getState().sync({ condNodes: next });
    setSelected(new Set());
  }

  const canMerge = selected.size === 2 && condNodes.length >= 2;
  // 只有顶层节点可被选中合并
  const topLevelIds = new Set(condNodes.map(n => n.id));

  return (
    <ResizableSideDrawer open={isOpen} onClose={close} side="right" defaultWidth={480}>
      {/* Header */}
      <div className="flex items-center px-3 py-1.5 flex-shrink-0 border-b bg-muted/60 gap-2">
        <span className="text-[11px] font-medium">Conditions ({totalLeaves} 叶子 / {condNodes.length} 节点)</span>
        <button
          className="ml-auto text-muted-foreground hover:text-foreground text-sm leading-none"
          onClick={close}
        >×</button>
      </div>

      {/* 合并工具栏 */}
      {condNodes.length >= 2 && (
        <div className="px-3 py-1 border-b bg-muted/30 flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground shrink-0">勾选 2 个合并：</span>
          <button
            onClick={() => setMergeOp(v => v === "AND" ? "OR" : "AND")}
            className={`inline-flex items-center justify-center h-5 w-9 text-[11px] font-mono font-bold rounded-sm border shrink-0 ${
              mergeOp === "AND"
                ? "bg-blue-500/20 text-blue-400 border-blue-500/40"
                : "bg-orange-500/20 text-orange-400 border-orange-500/40"
            }`}
          >{mergeOp}</button>
          <button
            className="inline-flex items-center justify-center h-5 px-2 text-[11px] rounded-sm border border-border bg-background hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            disabled={!canMerge}
            onClick={handleMerge}
          >合并</button>
          {selected.size > 0 && (
            <button
              className="inline-flex items-center justify-center h-5 px-2 text-[11px] rounded-sm border border-border bg-background hover:bg-muted shrink-0"
              onClick={() => setSelected(new Set())}
            >取消</button>
          )}
        </div>
      )}

      {/* Node List */}
      <div className="flex-1 overflow-auto space-y-1.5 px-3 py-2">
        {condNodes.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无条件，在 PauseCond 栏添加。</p>
        ) : (
          condNodes.map(node => (
            <CondNodeItem
              key={node.id}
              node={node}
              onRemove={handleRemove}
              onToggleEnabled={handleToggleEnabled}
              selected={selected}
              onSelect={handleSelect}
              canSelect={topLevelIds.has(node.id) && condNodes.length >= 2}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 px-3 pt-2 pb-3 border-t flex gap-2">
        <Button
          variant="default"
          size="sm"
          className="flex-1 h-7 text-xs"
          disabled={condNodes.length === 0 || disabled}
          onClick={() => onRunConditionScan?.()}
        >
          Scan
        </Button>
        {condNodes.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-7 text-xs"
            onClick={() => useDebugStore.getState().sync({ condNodes: [], conditionHitSet: new Set<number>(), scanHits: [] })}
          >
            Clear All
          </Button>
        )}
      </div>
    </ResizableSideDrawer>
  );
}
