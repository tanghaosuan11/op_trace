import { useState, useRef, useEffect } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useDebugStore, type ValueRecord, type StepMark } from "@/store/debugStore";
import { OP_MAP } from "@/lib/opcodes";
import { X, Trash2, StickyNote } from "lucide-react";
import { toast } from "sonner";

interface NotesDrawerProps {
  onSeekTo?: (index: number) => void;
}

/* ── 类型图标 + 颜色 ─────────────────────────────────── */
const SOURCE_STYLE: Record<string, { icon: string; color: string }> = {
  stack:   { icon: "S", color: "bg-blue-500/80" },
  memory:  { icon: "M", color: "bg-orange-500/80" },
  storage: { icon: "K", color: "bg-emerald-500/80" },
};

/* ── 来源描述 ─────────────────────────────────────── */
function sourceLabel(src: ValueRecord["source"]): string {
  switch (src.type) {
    case "stack":   return `Stack[${src.depth}]`;
    case "memory":  return `Mem[0x${src.offset.toString(16)}..+${src.length}]`;
    case "storage": return `Slot ${src.key.slice(0, 10)}…`;
  }
}

/* ── 可行编辑备注 ─────────────────────────────────── */
function InlineNote({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (!editing) {
    return (
      <span
        className="text-[10px] text-muted-foreground italic cursor-pointer hover:text-foreground truncate max-w-[200px] inline-block"
        onClick={() => { setDraft(value); setEditing(true); }}
        title="Click to edit note"
      >
        {value || "add note…"}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      className="text-[10px] bg-transparent border-b border-muted-foreground/40 outline-none w-full max-w-[200px] px-0.5"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { onChange(draft); setEditing(false); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { onChange(draft); setEditing(false); }
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

/* ── 值记录卡片 ─────────────────────────────────── */
function ValueCard({ record, onSeekTo }: { record: ValueRecord; onSeekTo?: (i: number) => void }) {
  const { removeValueRecord, updateValueRecordNote } = useDebugStore.getState();
  const s = SOURCE_STYLE[record.source.type];
  const val = record.source.value;

  return (
    <div className="group flex flex-col gap-0.5 px-2 py-1.5 rounded-md bg-muted/40 hover:bg-muted/70 transition-colors">
      {/* row 1: source badge + step + delete */}
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className={`${s.color} text-white font-bold w-4 h-4 rounded-sm flex items-center justify-center text-[9px] shrink-0`}>
          {s.icon}
        </span>
        <span className="font-mono text-muted-foreground">{sourceLabel(record.source)}</span>
        <span className="text-muted-foreground/60">@</span>
        <button
          className="text-blue-400 hover:underline cursor-pointer font-mono"
          onClick={() => onSeekTo?.(record.stepIndex)}
        >
          step {record.stepIndex}
        </button>
        <button
          className="ml-auto opacity-0 group-hover:opacity-60 hover:!opacity-100 text-destructive transition-opacity"
          onClick={() => removeValueRecord(record.id)}
          title="Delete"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {/* row 2: value (truncated) */}
      <div className="font-mono text-[10px] text-foreground/80 truncate pl-5" title={val}>
        {val}
      </div>
      {/* row 3: note */}
      <div className="pl-5">
        <InlineNote value={record.note} onChange={(n) => updateValueRecordNote(record.id, n)} />
      </div>
    </div>
  );
}

/* ── 步数标记卡片 ─────────────────────────────────── */
function StepCard({ mark, onSeekTo }: { mark: StepMark; onSeekTo?: (i: number) => void }) {
  const { removeStepMark, updateStepMarkNote } = useDebugStore.getState();

  return (
    <div className="group flex flex-col gap-0.5 px-2 py-1.5 rounded-md bg-muted/40 hover:bg-muted/70 transition-colors">
      {/* row 1: step + opcode + delete */}
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="bg-violet-500/80 text-white font-bold w-4 h-4 rounded-sm flex items-center justify-center text-[9px] shrink-0">
          ▸
        </span>
        <button
          className="text-blue-400 hover:underline cursor-pointer font-mono"
          onClick={() => onSeekTo?.(mark.stepIndex)}
        >
          step {mark.stepIndex}
        </button>
        <span className="text-muted-foreground font-mono">{mark.opcodeName}</span>
        <button
          className="ml-auto opacity-0 group-hover:opacity-60 hover:!opacity-100 text-destructive transition-opacity"
          onClick={() => removeStepMark(mark.id)}
          title="Delete"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {/* row 2: note */}
      <div className="pl-5">
        <InlineNote value={mark.note} onChange={(n) => updateStepMarkNote(mark.id, n)} />
      </div>
    </div>
  );
}

/* ── 主组件 ─────────────────────────────────────── */
export function NotesDrawer({ onSeekTo }: NotesDrawerProps) {
  const isOpen = useDebugStore((s) => s.isNotesDrawerOpen);
  const valueRecords = useDebugStore((s) => s.valueRecords);
  const stepMarks = useDebugStore((s) => s.stepMarks);

  const close = () => useDebugStore.getState().sync({ isNotesDrawerOpen: false });

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(o) => { if (!o) close(); }}
    >
      <SheetContent
        side="bottom"
        className="h-[45vh] flex flex-col p-0 [&>button]:hidden border-t border-border shadow-[0_-4px_16px_rgba(0,0,0,0.22)]"
        aria-describedby={undefined}
      >
        <SheetTitle className="sr-only">Notes</SheetTitle>

        {/* Header */}
        <div className="flex items-center px-4 py-1.5 border-b bg-muted/60 flex-shrink-0">
          <StickyNote size={13} className="mr-1.5 text-muted-foreground" />
          <span className="text-[11px] font-semibold">Notes</span>
          <span className="ml-2 text-[10px] text-muted-foreground">
            {valueRecords.length} values · {stepMarks.length} marks
          </span>
          <button
            className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
            onClick={close}
          >
            <X size={14} />
          </button>
        </div>

        {/* Body: 左右两栏 */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* 左栏: Value Records */}
          <div className="flex-1 flex flex-col min-w-0 border-r">
            <div className="px-3 py-1 text-[10px] font-medium text-muted-foreground bg-muted/30 border-b flex-shrink-0">
              Value Records ({valueRecords.length})
            </div>
            <div className="flex-1 overflow-auto px-2 py-1 space-y-1">
              {valueRecords.length === 0 ? (
                <div className="h-full flex items-center justify-center text-muted-foreground text-[11px]">
                  Right-click a stack/memory/storage value → Record Value
                </div>
              ) : (
                valueRecords.map((r) => <ValueCard key={r.id} record={r} onSeekTo={onSeekTo} />)
              )}
            </div>
          </div>

          {/* 右栏: Step Marks */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-3 py-1 text-[10px] font-medium text-muted-foreground bg-muted/30 border-b flex-shrink-0">
              Step Marks ({stepMarks.length})
            </div>
            <div className="flex-1 overflow-auto px-2 py-1 space-y-1">
              {stepMarks.length === 0 ? (
                <div className="h-full flex items-center justify-center text-muted-foreground text-[11px]">
                  Right-click an opcode row → Mark This Step
                </div>
              ) : (
                stepMarks.map((m) => <StepCard key={m.id} mark={m} onSeekTo={onSeekTo} />)
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── Helper: 在其他组件中快速添加记录 ─────────────────── */
export function addValueRecordFromStack(stepIndex: number, depth: number, value: string) {
  useDebugStore.getState().addValueRecord({
    stepIndex, note: "", source: { type: "stack", depth, value },
  });
  toast.success("Value recorded", { id: "note-added", duration: 1500 });
}

export function addValueRecordFromMemory(stepIndex: number, offset: number, length: number, value: string) {
  useDebugStore.getState().addValueRecord({
    stepIndex, note: "", source: { type: "memory", offset, length, value },
  });
  toast.success("Memory range recorded", { id: "note-added", duration: 1500 });
}

export function addValueRecordFromStorage(stepIndex: number, key: string, value: string) {
  useDebugStore.getState().addValueRecord({
    stepIndex, note: "", source: { type: "storage", key, value },
  });
  toast.success("Storage slot recorded", { id: "note-added", duration: 1500 });
}

export function addStepMarkFromOpcode(stepIndex: number, opcode: number) {
  const name = OP_MAP[opcode]?.name ?? `0x${opcode.toString(16)}`;
  useDebugStore.getState().addStepMark({ stepIndex, opcodeName: name, note: "" });
  toast.success(`Step ${stepIndex} marked`, { id: "note-added", duration: 1500 });
}
