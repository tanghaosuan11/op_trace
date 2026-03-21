/**
 * 右侧抽屉：为指定合约地址管理槽位注解（增删改）。
 *
 * Props:
 *   open        — 是否打开
 *   onClose     — 关闭回调
 *   chainId     — 当前调试的 chainId
 *   address     — 当前合约地址（小写 hex）
 *   onSaved     — 保存成功后回调（传入最新 SlotInfo[]）
 */
import { useEffect, useReducer, useRef, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getContractSlots,
  saveContractSlots,
  normalizeSlotHex,
  solTypeToString,
  type SlotInfo,
  type SolType,
  type SolPrimitive,
  type SolMapping,
  type SolArray,
  type SolStruct,
  type SolPacked,
} from "@/lib/contractSlots";

// ── 常用 primitive 候选 ──────────────────────────────────────────
const PRIMITIVE_SUGGESTIONS = [
  "address", "bool",
  "uint8", "uint16", "uint32", "uint64", "uint128", "uint256",
  "int8", "int16", "int32", "int64", "int128", "int256",
  "bytes1", "bytes2", "bytes4", "bytes8", "bytes16", "bytes20", "bytes32",
  "bytes", "string",
];

// ── SolType 编辑器（递归）────────────────────────────────────────

interface TypeEditorProps {
  value: SolType;
  onChange: (t: SolType) => void;
  /** 限制只能选值类型，用于 mapping key / packed field */
  onlyPrimitive?: boolean;
  depth?: number;
}

function TypeEditor({ value, onChange, onlyPrimitive = false, depth = 0 }: TypeEditorProps) {
  const kinds = onlyPrimitive
    ? (["primitive"] as const)
    : (["primitive", "mapping", "array", "struct", "packed"] as const);

  function handleKindChange(kind: string) {
    switch (kind) {
      case "primitive": onChange({ kind: "primitive", type: "uint256" }); break;
      case "mapping":   onChange({ kind: "mapping", key: { kind: "primitive", type: "address" }, value: { kind: "primitive", type: "uint256" } }); break;
      case "array":     onChange({ kind: "array", element: { kind: "primitive", type: "uint256" } }); break;
      case "struct":    onChange({ kind: "struct", fields: [{ name: "field0", type: { kind: "primitive", type: "uint256" } }] }); break;
      case "packed":    onChange({ kind: "packed", fields: [{ name: "field0", type: { kind: "primitive", type: "uint8" }, byteOffset: 0, byteSize: 1 }] }); break;
    }
  }

  const indent = depth * 12;

  return (
    <div style={{ marginLeft: indent }} className="flex flex-col gap-1.5">
      {/* kind 选择 */}
      <Select value={value.kind} onValueChange={handleKindChange}>
        <SelectTrigger className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {kinds.map((k) => (
            <SelectItem key={k} value={k} className="text-xs">{k}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* primitive */}
      {value.kind === "primitive" && (
        <PrimitiveEditor value={value} onChange={onChange as (t: SolPrimitive) => void} />
      )}

      {/* mapping */}
      {value.kind === "mapping" && (
        <MappingEditor value={value} onChange={onChange as (t: SolMapping) => void} depth={depth} />
      )}

      {/* array */}
      {value.kind === "array" && (
        <ArrayEditor value={value} onChange={onChange as (t: SolArray) => void} depth={depth} />
      )}

      {/* struct */}
      {value.kind === "struct" && (
        <StructEditor value={value} onChange={onChange as (t: SolStruct) => void} depth={depth} />
      )}

      {/* packed */}
      {value.kind === "packed" && (
        <PackedEditor value={value} onChange={onChange as (t: SolPacked) => void} />
      )}
    </div>
  );
}

function PrimitiveEditor({ value, onChange }: { value: SolPrimitive; onChange: (t: SolPrimitive) => void }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {PRIMITIVE_SUGGESTIONS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange({ kind: "primitive", type: s })}
          className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
            value.type === s
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          {s}
        </button>
      ))}
      {/* 自定义输入 */}
      <Input
        className="h-6 text-xs w-28 mt-0.5"
        placeholder="custom type..."
        value={PRIMITIVE_SUGGESTIONS.includes(value.type) ? "" : value.type}
        onChange={(e) => onChange({ kind: "primitive", type: e.target.value })}
      />
    </div>
  );
}

function MappingEditor({ value, onChange, depth }: { value: SolMapping; onChange: (t: SolMapping) => void; depth: number }) {
  return (
    <div className="flex flex-col gap-1 border-l-2 border-muted pl-2">
      <span className="text-[10px] text-muted-foreground">Key (value type only)</span>
      <TypeEditor
        value={value.key}
        onlyPrimitive
        depth={depth + 1}
        onChange={(k) => onChange({ ...value, key: k as SolPrimitive })}
      />
      <span className="text-[10px] text-muted-foreground mt-1">Value</span>
      <TypeEditor
        value={value.value}
        depth={depth + 1}
        onChange={(v) => onChange({ ...value, value: v })}
      />
    </div>
  );
}

function ArrayEditor({ value, onChange, depth }: { value: SolArray; onChange: (t: SolArray) => void; depth: number }) {
  return (
    <div className="flex flex-col gap-1 border-l-2 border-muted pl-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">Size</span>
        <Input
          className="h-6 text-xs w-20"
          placeholder="dynamic"
          value={value.size ?? ""}
          onChange={(e) => {
            const v = e.target.value.trim();
            onChange({ ...value, size: v === "" ? undefined : Number(v) });
          }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground">Element type</span>
      <TypeEditor
        value={value.element}
        depth={depth + 1}
        onChange={(el) => onChange({ ...value, element: el })}
      />
    </div>
  );
}

function StructEditor({ value, onChange, depth }: { value: SolStruct; onChange: (t: SolStruct) => void; depth: number }) {
  function updateField(i: number, name: string, type: SolType) {
    const fields = [...value.fields];
    fields[i] = { name, type };
    onChange({ ...value, fields });
  }
  function addField() {
    onChange({ ...value, fields: [...value.fields, { name: `field${value.fields.length}`, type: { kind: "primitive", type: "uint256" } }] });
  }
  function removeField(i: number) {
    onChange({ ...value, fields: value.fields.filter((_, idx) => idx !== i) });
  }
  return (
    <div className="flex flex-col gap-1 border-l-2 border-muted pl-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">Struct name</span>
        <Input
          className="h-6 text-xs w-28"
          placeholder="optional"
          value={value.name ?? ""}
          onChange={(e) => onChange({ ...value, name: e.target.value || undefined })}
        />
      </div>
      {value.fields.map((f, i) => (
        <div key={i} className="flex flex-col gap-0.5 border border-border rounded px-1.5 py-1">
          <div className="flex items-center gap-1">
            <Input
              className="h-5 text-xs flex-1"
              value={f.name}
              onChange={(e) => updateField(i, e.target.value, f.type)}
            />
            <button type="button" onClick={() => removeField(i)} className="text-muted-foreground hover:text-destructive text-xs shrink-0">✕</button>
          </div>
          <TypeEditor value={f.type} depth={depth + 1} onChange={(t) => updateField(i, f.name, t)} />
        </div>
      ))}
      <button type="button" onClick={addField} className="text-[10px] text-muted-foreground hover:text-foreground text-left">+ add field</button>
    </div>
  );
}

function PackedEditor({ value, onChange }: { value: SolPacked; onChange: (t: SolPacked) => void }) {
  function updateField(i: number, patch: Partial<SolPacked["fields"][number]>) {
    const fields = [...value.fields];
    fields[i] = { ...fields[i], ...patch };
    onChange({ ...value, fields });
  }
  function addField() {
    const last = value.fields[value.fields.length - 1];
    const nextOffset = last ? last.byteOffset + last.byteSize : 0;
    onChange({ ...value, fields: [...value.fields, { name: `field${value.fields.length}`, type: { kind: "primitive", type: "uint8" }, byteOffset: nextOffset, byteSize: 1 }] });
  }
  function removeField(i: number) {
    onChange({ ...value, fields: value.fields.filter((_, idx) => idx !== i) });
  }
  return (
    <div className="flex flex-col gap-1 border-l-2 border-muted pl-2">
      <span className="text-[10px] text-muted-foreground">Packed fields (LSB = byte 0)</span>
      {value.fields.map((f, i) => (
        <div key={i} className="flex items-center gap-1 flex-wrap border border-border rounded px-1.5 py-1">
          <Input className="h-5 text-xs w-20" value={f.name} onChange={(e) => updateField(i, { name: e.target.value })} placeholder="name" />
          <Select value={f.type.type} onValueChange={(v) => updateField(i, { type: { kind: "primitive", type: v } })}>
            <SelectTrigger className="h-5 text-xs w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PRIMITIVE_SUGGESTIONS.map((s) => <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-0.5">
            <span className="text-[9px] text-muted-foreground">@</span>
            <Input className="h-5 text-xs w-8" value={f.byteOffset} type="number" min={0} max={31} onChange={(e) => updateField(i, { byteOffset: Number(e.target.value) })} />
            <span className="text-[9px] text-muted-foreground">sz</span>
            <Input className="h-5 text-xs w-8" value={f.byteSize} type="number" min={1} max={32} onChange={(e) => updateField(i, { byteSize: Number(e.target.value) })} />
          </div>
          <button type="button" onClick={() => removeField(i)} className="text-muted-foreground hover:text-destructive text-xs ml-auto">✕</button>
        </div>
      ))}
      <button type="button" onClick={addField} className="text-[10px] text-muted-foreground hover:text-foreground text-left">+ add field</button>
    </div>
  );
}

// ── 单条 SlotInfo 表单 ───────────────────────────────────────────

interface SlotFormState {
  slotHex: string;
  name: string;
  type: SolType;
  slotError: string;
}

type SlotFormAction =
  | { t: "setSlot"; v: string }
  | { t: "setName"; v: string }
  | { t: "setType"; v: SolType }
  | { t: "setSlotError"; v: string }
  | { t: "reset"; payload: SlotFormState };

function slotFormReducer(state: SlotFormState, action: SlotFormAction): SlotFormState {
  switch (action.t) {
    case "setSlot": return { ...state, slotHex: action.v, slotError: "" };
    case "setName": return { ...state, name: action.v };
    case "setType": return { ...state, type: action.v };
    case "setSlotError": return { ...state, slotError: action.v };
    case "reset": return action.payload;
  }
}

const defaultFormState: SlotFormState = {
  slotHex: "",
  name: "",
  type: { kind: "primitive", type: "uint256" },
  slotError: "",
};

// ── 主组件 ───────────────────────────────────────────────────────

export interface SlotAnnotationDrawerProps {
  open: boolean;
  onClose: () => void;
  chainId: number | undefined;
  address: string | undefined;
  onSaved: (slots: SlotInfo[]) => void;
}

export function SlotAnnotationDrawer({
  open, onClose, chainId, address, onSaved,
}: SlotAnnotationDrawerProps) {
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null); // null = new
  const [form, dispatchForm] = useReducer(slotFormReducer, defaultFormState);
  const [saving, setSaving] = useState(false);
  // 防止重复加载
  const loadedKey = useRef<string>("");

  // 打开时加载已有槽位
  useEffect(() => {
    if (!open || !chainId || !address) return;
    const key = `${chainId}:${address.toLowerCase()}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    getContractSlots(chainId, address).then((data) => {
      setSlots(data?.slots ?? []);
    });
    resetForm();
    setEditingIndex(null);
  }, [open, chainId, address]);

  function resetForm(preset?: Partial<SlotFormState>) {
    dispatchForm({ t: "reset", payload: { ...defaultFormState, ...preset } });
  }

  function startEdit(index: number) {
    const s = slots[index];
    setEditingIndex(index);
    resetForm({ slotHex: s.slotHex, name: s.name ?? "", type: s.type });
  }

  function startNew() {
    setEditingIndex(null);
    resetForm();
  }

  async function handleDelete(index: number) {
    if (!chainId || !address) return;
    const next = slots.filter((_, i) => i !== index);
    setSlots(next);
    if (editingIndex === index) { setEditingIndex(null); resetForm(); }
    await persist(next);
  }

  async function handleSave() {
    if (!chainId || !address) return;
    let normalized: string;
    try {
      normalized = normalizeSlotHex(form.slotHex);
    } catch (e) {
      dispatchForm({ t: "setSlotError", v: e instanceof Error ? e.message : "Invalid slot" });
      return;
    }

    const entry: SlotInfo = {
      slotHex: normalized,
      name: form.name.trim() || undefined,
      type: form.type,
    };

    let next: SlotInfo[];
    if (editingIndex !== null) {
      next = slots.map((s, i) => (i === editingIndex ? entry : s));
    } else {
      // 检查 slotHex 重复
      const dup = slots.findIndex((s) => s.slotHex === normalized);
      if (dup !== -1) {
        next = slots.map((s, i) => (i === dup ? entry : s));
        setEditingIndex(null);
      } else {
        next = [...slots, entry];
      }
    }

    setSaving(true);
    setSlots(next);
    await persist(next);
    setSaving(false);
    onSaved(next);
    setEditingIndex(null);
    resetForm();
  }

  async function persist(next: SlotInfo[]) {
    if (!chainId || !address) return;
    await saveContractSlots({ chainId, address, slots: next, updatedAt: Date.now() });
  }

  const isFormDirty = form.slotHex.trim() !== "";

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent
        side="right"
        className="w-[420px] sm:max-w-[420px] p-0 flex flex-col [&>button]:hidden"
        aria-describedby={undefined}
      >
        <SheetTitle className="sr-only">Slot Annotations</SheetTitle>

        {/* ── 标题栏 ── */}
        <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0">
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-sm font-semibold">Slot Annotations</span>
            {chainId && address && (
              <span className="text-[10px] text-muted-foreground font-mono truncate">
                chain {chainId} · {address}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={startNew}
            className="text-xs px-2 py-1 rounded border border-dashed border-muted-foreground/50 text-muted-foreground hover:text-foreground hover:border-foreground/50 transition-colors shrink-0"
          >
            + New
          </button>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Close"
          >✕</button>
        </div>

        {/* ── 已有列表 ── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {slots.length === 0 && editingIndex === null && !isFormDirty && (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              No annotations yet
            </div>
          )}
          {slots.map((s, i) => (
            <div
              key={s.slotHex}
              className={`flex items-start gap-2 px-4 py-2.5 border-b cursor-pointer transition-colors ${
                editingIndex === i ? "bg-muted/70" : "hover:bg-muted/40"
              }`}
              onClick={() => startEdit(i)}
            >
              <div className="flex flex-col flex-1 min-w-0 font-mono text-xs">
                <div className="flex items-center gap-1.5">
                  {s.name && <span className="text-emerald-400 font-semibold">{s.name}</span>}
                  <span className="text-muted-foreground/70 text-[10px] truncate">{s.slotHex}</span>
                </div>
                <span className="text-muted-foreground text-[10px] truncate">{solTypeToString(s.type)}</span>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); handleDelete(i); }}
                className="text-muted-foreground hover:text-destructive transition-colors text-xs shrink-0 mt-0.5"
                title="Delete"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* ── 表单区域 ── */}
        <div className="border-t shrink-0 bg-muted/20">
          <div className="px-4 pt-3 pb-1 flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground">
              {editingIndex !== null ? `Edit slot #${editingIndex}` : "New slot"}
            </span>
            {editingIndex !== null && (
              <button type="button" onClick={startNew} className="text-[10px] text-muted-foreground hover:text-foreground">
                Cancel edit
              </button>
            )}
          </div>

          <div className="px-4 pb-4 flex flex-col gap-3 overflow-y-auto max-h-[52vh]">
            {/* Slot hex */}
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Slot (hex or decimal)</Label>
              <Input
                className={`h-7 text-xs font-mono ${form.slotError ? "border-destructive" : ""}`}
                placeholder="0x0000...0001 or 1"
                value={form.slotHex}
                onChange={(e) => dispatchForm({ t: "setSlot", v: e.target.value })}
              />
              {form.slotError && (
                <span className="text-[10px] text-destructive">{form.slotError}</span>
              )}
            </div>

            {/* Name */}
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Name <span className="text-muted-foreground">(optional)</span></Label>
              <Input
                className="h-7 text-xs"
                placeholder="e.g. balances, owner"
                value={form.name}
                onChange={(e) => dispatchForm({ t: "setName", v: e.target.value })}
              />
            </div>

            {/* Type */}
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Type</Label>
              <div className="text-[10px] text-muted-foreground font-mono mb-0.5">
                {solTypeToString(form.type)}
              </div>
              <TypeEditor value={form.type} onChange={(t) => dispatchForm({ t: "setType", v: t })} />
            </div>

            {/* Save */}
            <button
              type="button"
              disabled={!isFormDirty || saving || !chainId || !address}
              onClick={handleSave}
              className="mt-1 h-8 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
            >
              {saving ? "Saving…" : editingIndex !== null ? "Update" : "Add"}
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
