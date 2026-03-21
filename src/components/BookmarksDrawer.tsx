import { useState } from "react";
import { ResizableSideDrawer } from "@/components/ui/resizable-side-drawer";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";
import { useDebugStore } from "@/store/debugStore";

interface BookmarksDrawerProps {
  /** Called when user clicks a bookmark row. App resolves stepIndex and calls navigateTo. */
  onNavigate?: (frameId: string, pc: number) => void;
}

export function BookmarksDrawer({ onNavigate }: BookmarksDrawerProps) {
  const isOpen = useDebugStore((s) => s.isBookmarksOpen);
  const breakpointPcsMap = useDebugStore((s) => s.breakpointPcsMap);
  const breakpointLabels = useDebugStore((s) => s.breakpointLabels);
  const setBreakpointLabel = useDebugStore((s) => s.setBreakpointLabel);
  const removeBreakpointLabel = useDebugStore((s) => s.removeBreakpointLabel);
  const close = () => useDebugStore.getState().sync({ isBookmarksOpen: false });

  // Group by frameId, sorted frames by frameId string, pcs sorted numerically
  const groups: { frameId: string; pcs: number[] }[] = [];
  for (const [frameId, pcsSet] of breakpointPcsMap.entries()) {
    if (pcsSet.size === 0) continue;
    groups.push({ frameId, pcs: Array.from(pcsSet).sort((a, b) => a - b) });
  }
  groups.sort((a, b) => (a.frameId < b.frameId ? -1 : a.frameId > b.frameId ? 1 : 0));
  const totalCount = groups.reduce((n, g) => n + g.pcs.length, 0);

  return (
    <ResizableSideDrawer open={isOpen} onClose={close} side="left" defaultWidth={280}>
        {/* Header */}
        <div className="flex items-center px-3 py-1.5 flex-shrink-0 border-b bg-muted/60">
          <span className="text-[11px] font-medium">Bookmarks ({totalCount})</span>
          <button
            onClick={close}
            className="ml-auto flex items-center justify-center opacity-50 hover:opacity-100 transition-opacity"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        {/* List */}
        <div className="flex-1 overflow-auto px-2 py-1">
          {totalCount === 0 ? (
            <div className="h-full flex items-center justify-center text-center text-muted-foreground text-xs px-4">
              No breakpoints — click an opcode row to add one
            </div>
          ) : (
            <div className="space-y-2 py-0.5">
              {groups.map(({ frameId, pcs }) => (
                <div key={frameId}>
                  {/* Group header */}
                  <div className="flex items-center gap-1.5 px-1 py-0.5 mb-0.5">
                    <span className="font-mono text-[10px] font-semibold text-muted-foreground tracking-wide uppercase">
                      {frameId}
                    </span>
                    <span className="text-[9px] text-muted-foreground/60">({pcs.length})</span>
                  </div>
                  {/* Rows */}
                  <div className="space-y-0.5 pl-2">
                    {pcs.map((pc) => (
                      <BreakpointRow
                        key={`${frameId}-${pc}`}
                        pc={pc}
                        label={breakpointLabels.get(pc) ?? ""}
                        onLabelChange={(l) => setBreakpointLabel(pc, l)}
                        onRemoveLabel={() => removeBreakpointLabel(pc)}
                        onJump={onNavigate ? () => { close(); onNavigate(frameId, pc); } : undefined}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
    </ResizableSideDrawer>
  );
}

function BreakpointRow({
  pc,
  label,
  onLabelChange,
  onRemoveLabel,
  onJump,
}: {
  pc: number;
  label: string;
  onLabelChange: (l: string) => void;
  onRemoveLabel: () => void;
  onJump?: () => void;
}) {
  const [draft, setDraft] = useState(label);
  const commit = () => { onLabelChange(draft); };

  return (
    <div
      className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-muted/40 group cursor-pointer"
      onClick={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "BUTTON" || (e.target as HTMLElement).closest("button")) return;
        onJump?.();
      }}
    >
      {/* Red dot */}
      <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
      {/* PC */}
      <span className="w-14 font-mono text-[11px] text-muted-foreground shrink-0">
        {pc}
      </span>
      {/* Label input */}
      <Input
        data-pc={pc}
        value={draft}
        placeholder="label..."
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); }
          if (e.key === "Escape") { setDraft(label); (e.target as HTMLInputElement).blur(); }
        }}
        className="flex-1 h-5 text-[11px] font-mono px-1.5 bg-transparent border-transparent hover:border-input focus:border-input focus:bg-background transition-colors"
      />
      {/* Clear label */}
      {label && (
        <button
          onClick={(e) => { e.stopPropagation(); setDraft(""); onRemoveLabel(); }}
          className="opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity shrink-0"
          title="Clear label"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
