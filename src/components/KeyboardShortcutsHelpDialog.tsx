import { useMemo } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useDebugStore } from "@/store/debugStore";
import {
  GROUP_LABEL,
  getShortcutHelpRows,
  type ShortcutHelpGroup,
  type ShortcutHelpRow,
} from "@/lib/shortcuts";

function groupRows(rows: ShortcutHelpRow[]): Map<ShortcutHelpGroup, ShortcutHelpRow[]> {
  const m = new Map<ShortcutHelpGroup, ShortcutHelpRow[]>();
  for (const r of rows) {
    const list = m.get(r.group) ?? [];
    list.push(r);
    m.set(r.group, list);
  }
  return m;
}

function ShortcutBlock({
  title,
  list,
}: {
  title: string;
  list: ShortcutHelpRow[];
}) {
  if (list.length === 0) return null;
  return (
    <div className="min-w-0">
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-0">
        {list.map((row) => (
          <li
            key={row.commandId}
            className="grid grid-cols-[minmax(0,6.75rem)_1fr] gap-x-2 py-0.5 text-[11px] leading-snug"
          >
            <span className="break-words font-mono text-foreground select-all">
              {row.keysDisplay}
            </span>
            <span className="min-w-0 text-muted-foreground">
              {row.description}
              {row.conditional ? (
                <span
                  className="ml-0.5 text-[9px] text-amber-600 dark:text-amber-400"
                  title="Only when condition matches"
                >
                  *
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function KeyboardShortcutsHelpDialog() {
  const open = useDebugStore((s) => s.isKeyboardShortcutsHelpOpen);
  const sync = useDebugStore((s) => s.sync);

  const rows = useMemo(() => getShortcutHelpRows(), []);
  const byGroup = useMemo(() => groupRows(rows), [rows]);

  const debugList = byGroup.get("debug") ?? [];
  const navList = byGroup.get("nav") ?? [];
  const uiList = byGroup.get("ui") ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => sync({ isKeyboardShortcutsHelpOpen: o })}>
      <DialogContent aria-describedby={undefined}
        showClose={false}
        className="flex h-[min(86vh,640px)] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:h-[min(86vh,640px)] sm:w-full"
      >
        <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2">
          <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
            <div className="flex min-h-0 min-w-0 flex-col gap-2.5">
              <ShortcutBlock title={GROUP_LABEL.debug} list={debugList} />
              <ShortcutBlock title={GROUP_LABEL.nav} list={navList} />
            </div>
            <div className="min-h-0 min-w-0">
              <ShortcutBlock title={GROUP_LABEL.ui} list={uiList} />
            </div>
          </div>
          <p className="mt-1.5 text-[10px] leading-tight text-muted-foreground">
            * Only when the shortcut&apos;s condition is met (e.g. trace loaded).
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
