import { useEffect, useState } from "react";
import { ResizableSideDrawer } from "@/components/ui/resizable-side-drawer";
import { Input } from "@/components/ui/input";
import { Eraser, FolderX, Trash2, X } from "lucide-react";
import { useDebugStore } from "@/store/debugStore";
import { useDrawerActions } from "@/hooks/useDrawerActions";

interface BookmarksDrawerProps {
  /** Called when user clicks a bookmark row. App resolves stepIndex and calls navigateTo. */
  onNavigate?: (frameId: string, pc: number) => void;
  /** Remove this PC breakpoint for the frame (syncs ref + store). */
  onRemoveBreakpoint?: (frameId: string, pc: number) => void;
  /** Remove all PC breakpoints for this frame (and their labels). */
  onClearFrameBreakpoints?: (frameId: string) => void;
  /** Remove every PC breakpoint and all labels. */
  onClearAllBreakpoints?: () => void;
}

export function BookmarksDrawer({
  onNavigate,
  onRemoveBreakpoint,
  onClearFrameBreakpoints,
  onClearAllBreakpoints,
}: BookmarksDrawerProps) {
  const isOpen = useDebugStore((s) => s.isBookmarksOpen);
  const breakpointPcsMap = useDebugStore((s) => s.breakpointPcsMap);
  const breakpointLabels = useDebugStore((s) => s.breakpointLabels);
  const setBreakpointLabel = useDebugStore((s) => s.setBreakpointLabel);
  const removeBreakpointLabel = useDebugStore((s) => s.removeBreakpointLabel);
  const { closeBookmarks } = useDrawerActions();

  // Group by frameId, sorted frames by frameId string, pcs sorted numerically
  const groups: { frameId: string; pcs: number[] }[] = [];
  for (const [frameId, pcsSet] of breakpointPcsMap.entries()) {
    if (pcsSet.size === 0) continue;
    groups.push({ frameId, pcs: Array.from(pcsSet).sort((a, b) => a - b) });
  }
  groups.sort((a, b) => (a.frameId < b.frameId ? -1 : a.frameId > b.frameId ? 1 : 0));
  const totalCount = groups.reduce((n, g) => n + g.pcs.length, 0);

  return (
    <ResizableSideDrawer open={isOpen} onClose={closeBookmarks} side="left" defaultWidth={280}>
        {/* Header */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 flex-shrink-0 border-b bg-muted/60">
          <span className="text-[11px] font-medium min-w-0">Bookmarks ({totalCount})</span>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {totalCount > 0 && onClearAllBreakpoints ? (
              <span
                data-clear-all-bp
                className="cursor-pointer select-none text-muted-foreground opacity-50 hover:opacity-100 hover:text-destructive transition-opacity"
                title="Clear all breakpoints"
                onClick={(e) => {
                  e.stopPropagation();
                  onClearAllBreakpoints();
                }}
              >
                <Eraser className="h-3 w-3" aria-hidden />
              </span>
            ) : null}
            <button
              type="button"
              onClick={closeBookmarks}
              className="flex items-center justify-center opacity-50 hover:opacity-100 transition-opacity"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
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
                  <div className="flex items-center gap-1 px-1 py-0.5 mb-0.5 min-w-0">
                    <span className="font-mono text-[10px] font-semibold text-muted-foreground tracking-wide uppercase truncate min-w-0">
                      {frameId}
                    </span>
                    <span className="text-[9px] text-muted-foreground/60 shrink-0">({pcs.length})</span>
                    {onClearFrameBreakpoints ? (
                      <span
                        data-frame-clear-bp
                        className="ml-auto shrink-0 cursor-pointer select-none text-muted-foreground opacity-50 hover:opacity-100 hover:text-destructive transition-opacity"
                        title="Clear all breakpoints in this frame"
                        onClick={(e) => {
                          e.stopPropagation();
                          onClearFrameBreakpoints(frameId);
                        }}
                      >
                        <FolderX className="h-3 w-3" aria-hidden />
                      </span>
                    ) : null}
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
                        onRemoveBreakpoint={
                          onRemoveBreakpoint
                            ? () => {
                                onRemoveBreakpoint(frameId, pc);
                                removeBreakpointLabel(pc);
                              }
                            : undefined
                        }
                        onJump={onNavigate ? () => { closeBookmarks(); onNavigate(frameId, pc); } : undefined}
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
  onRemoveBreakpoint,
  onJump,
}: {
  pc: number;
  label: string;
  onLabelChange: (l: string) => void;
  onRemoveLabel: () => void;
  onRemoveBreakpoint?: () => void;
  onJump?: () => void;
}) {
  const [draft, setDraft] = useState(label);
  useEffect(() => { setDraft(label); }, [label]);
  const commit = () => { onLabelChange(draft); };
  const showLabelClear = !!(label || draft.trim());

  return (
    <div
      className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-muted/40 group cursor-pointer"
      onClick={(e) => {
        const el = e.target as HTMLElement;
        if (
          el.tagName === "INPUT" ||
          el.closest("button") ||
          el.closest("[data-label-clear]") ||
          el.closest("[data-bp-remove]")
        ) {
          return;
        }
        onJump?.();
      }}
    >
      {/* Red dot */}
      <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
      {/* PC */}
      <span className="w-14 font-mono text-[11px] text-muted-foreground shrink-0">
        0x{pc.toString(16).padStart(4, '0')}
      </span>
      {/* Label input — clear label 在 input 内右侧 */}
      <div className="relative min-w-0 flex-1">
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
          className={`h-5 w-full text-[11px] font-mono pl-1.5 bg-transparent border-transparent hover:border-input focus:border-input focus:bg-background transition-colors ${showLabelClear ? "pr-7" : "pr-1.5"}`}
        />
        {showLabelClear ? (
          <span
            data-label-clear
            className="absolute right-1 top-1/2 z-[1] -translate-y-1/2 cursor-pointer select-none opacity-0 group-hover:opacity-50 hover:opacity-100 transition-opacity"
            title="Clear label"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              setDraft("");
              onRemoveLabel();
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <X className="h-3 w-3 text-muted-foreground" strokeWidth={2} aria-hidden />
          </span>
        ) : null}
      </div>
      {/* 删除断点 — 图标，无按钮包围 */}
      {onRemoveBreakpoint ? (
        <span
          data-bp-remove
          className="shrink-0 cursor-pointer select-none text-muted-foreground opacity-50 group-hover:opacity-70 hover:!opacity-100 hover:text-destructive transition-opacity"
          title="Remove breakpoint"
          onClick={(e) => {
            e.stopPropagation();
            onRemoveBreakpoint();
          }}
        >
          <Trash2 className="h-3 w-3" aria-hidden />
        </span>
      ) : null}
    </div>
  );
}
