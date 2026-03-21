import { useRef, useState, useMemo, useEffect, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardContent } from "@/components/ui/card";
import { useDebugStore } from "@/store/debugStore";
import { getContractSlots, solTypeToString, type SlotInfo } from "@/lib/contractSlots";
import type { StorageChangeEntry } from "@/lib/types";
import {
  PanelContextMenu, PanelContextMenuContent, PanelContextMenuItem,
  PanelContextMenuTrigger,
} from "@/components/ui/panel-context-menu";
// import { addValueRecordFromStorage } from "@/components/NotesDrawer";
import { SlotAnnotationDrawer } from "@/components/SlotAnnotationDrawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Re-export for backward compatibility
export type { StorageChangeEntry };

interface StorageSlot {
  address: string;
  key: string;
  storageType: "storage" | "tstorage";
  isRead: boolean;
  presentValue: string;
  history: StorageChangeEntry[];
}

type VirtualRow =
  | { kind: "header"; address: string; count: number }
  | { kind: "slot"; slot: StorageSlot };

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 22;
const SMALL_THRESHOLD = 1n << 64n;
function isSmallKey(key: string) { try { return BigInt(key) < SMALL_THRESHOLD; } catch { return false; } }

export function StorageViewer() {
  const storageChanges = useDebugStore((s) => s.storageChanges);
  const currentStepIndex = useDebugStore((s) => s.currentStepIndex);
  const callType = useDebugStore((s) => s.callType);
  const callerAddress = useDebugStore((s) => s.callerAddress);
  const currentDebugChainId = useDebugStore((s) => s.currentDebugChainId);
  const parentRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"storage" | "tstorage">("storage");
  // address(lowercase) -> slotHex(lowercase) -> SlotInfo
  const [annotationsMap, setAnnotationsMap] = useState<Map<string, Map<string, SlotInfo>>>(new Map());
  // 槽位注解抽屉
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerAddress, setDrawerAddress] = useState<string | undefined>();

  const visibleChanges = useMemo(
    () => storageChanges.filter(e =>
      e.stepIndex <= currentStepIndex && e.storageType === tab
    ),
    [storageChanges, currentStepIndex, tab]
  );

  // 按 address+(key+type) 聚合，同 key 的 read/write 合并，有 write 则非 read-only
  const slotsByAddress = useMemo(() => {
    const addrMap = new Map<string, Map<string, StorageSlot>>();
    for (const entry of visibleChanges) {
      if (!addrMap.has(entry.address)) addrMap.set(entry.address, new Map());
      const slotMap = addrMap.get(entry.address)!;
      const slotKey = `${entry.storageType}|${entry.key}`;
      const existing = slotMap.get(slotKey);
      if (existing) {
        existing.presentValue = entry.newValue;
        if (!entry.isRead) {
          existing.isRead = false;
          existing.history.push(entry);
        }
      } else {
        slotMap.set(slotKey, {
          address: entry.address,
          key: entry.key,
          storageType: entry.storageType,
          isRead: entry.isRead,
          presentValue: entry.newValue,
          history: entry.isRead ? [] : [entry],
        });
      }
    }
    return addrMap;
  }, [visibleChanges]);

  const flatRows = useMemo<VirtualRow[]>(() => {
    const rows: VirtualRow[] = [];
    for (const [address, slotMap] of slotsByAddress) {
      const allSlots = Array.from(slotMap.values());
      const small: StorageSlot[] = [];
      const large: StorageSlot[] = [];
      for (const s of allSlots) {
        isSmallKey(s.key) ? small.push(s) : large.push(s);
      }
      small.sort((a, b) => { try { const d = BigInt(a.key) - BigInt(b.key); return d < 0n ? -1 : d > 0n ? 1 : 0; } catch { return 0; } });
      large.sort((a, b) => a.key.localeCompare(b.key));
      const sorted = [...small, ...large];
      rows.push({ kind: "header", address, count: sorted.length });
      for (const slot of sorted) rows.push({ kind: "slot", slot });
    }
    return rows;
  }, [slotsByAddress]);

  const totalSlots = useMemo(
    () => Array.from(slotsByAddress.values()).reduce((s, m) => s + m.size, 0),
    [slotsByAddress]
  );

  // 异步加载当前所有地址的槽位注解
  useEffect(() => {
    if (!currentDebugChainId) return;
    const addresses = Array.from(slotsByAddress.keys());
    if (addresses.length === 0) return;
    let cancelled = false;
    const newMap = new Map<string, Map<string, SlotInfo>>();
    Promise.all(
      addresses.map(async (addr) => {
        const data = await getContractSlots(currentDebugChainId, addr);
        if (data) {
          const slotMap = new Map<string, SlotInfo>();
          for (const si of data.slots) {
            slotMap.set(si.slotHex.toLowerCase(), si);
          }
          newMap.set(addr.toLowerCase(), slotMap);
        }
      })
    ).then(() => {
      if (!cancelled) setAnnotationsMap(new Map(newMap));
    });
    return () => { cancelled = true; };
  }, [currentDebugChainId, slotsByAddress]);

  // 单个地址的注解更新回调
  const handleAnnotationsSaved = useCallback((addr: string, savedSlots: SlotInfo[]) => {
    setAnnotationsMap((prev) => {
      const next = new Map(prev);
      const slotMap = new Map<string, SlotInfo>();
      for (const si of savedSlots) {
        slotMap.set(si.slotHex.toLowerCase(), si);
      }
      next.set(addr.toLowerCase(), slotMap);
      return next;
    });
  }, []);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      const r = flatRows[i];
      if (!r) return ROW_HEIGHT;
      if (r.kind === "header") return HEADER_HEIGHT;
      return ROW_HEIGHT;
    },
    overscan: 5,
  });

  return (
    <>
    <Card className="h-full flex flex-col">
      <div className="py-1 px-3 flex-shrink-0 bg-muted/50 border-b">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">Storage ({totalSlots})</span>
          <div className="flex items-center gap-1.5">
            {callType === "delegatecall" && (
              <span className="text-[9px] font-mono text-amber-500 bg-amber-500/10 px-1 h-5 inline-flex items-center rounded" title={`写入的是 Caller (${callerAddress ?? '?'}) 的 Storage`}>
                ⚠ DELEGATECALL
              </span>
            )}
            {(["storage", "tstorage"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`h-5 leading-5 px-2 text-[10px] font-mono rounded text-center appearance-none border-none outline-none ring-0 shadow-none transition-colors ${
                  tab === t
                    ? "bg-muted text-foreground"
                    : "bg-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "storage" ? "SSTORE" : "TSTORE"}
              </button>
            ))}
          </div>
        </div>
      </div>
      <CardContent className="p-0 flex-1 min-h-0 relative">
        {flatRows.length > 0 ? (
          <div ref={parentRef} className="h-full overflow-auto scrollbar-hidden">
            <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
              {virtualizer.getVirtualItems().map((vRow) => {
                const row = flatRows[vRow.index];
                if (row.kind === "header") {
                  return (
                    <div
                      key={vRow.key}
                      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: `${vRow.size}px`, transform: `translateY(${vRow.start}px)` }}
                      className="flex items-center px-2 gap-1.5 bg-muted/50 border-b border-t text-[11px] font-mono"
                    >
                      <span className={`font-medium truncate min-w-0`} title={row.address} data-addr={row.address.toLowerCase()}>{row.address}</span>
                      <span
                        title="Edit slot annotations"
                        onClick={(e) => { e.stopPropagation(); setDrawerAddress(row.address); setDrawerOpen(true); }}
                        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors text-[14px] leading-none cursor-pointer select-none"
                      >✎</span>
                      <span className="text-muted-foreground shrink-0 ml-auto">({row.count})</span>
                    </div>
                  );
                }
                const { slot } = row;
                const annotation = annotationsMap
                  .get(slot.address.toLowerCase())
                  ?.get(slot.key.toLowerCase());
                const small = isSmallKey(slot.key);
                const trimmedKey = (() => { try { return `0x${BigInt(slot.key).toString(16)}`; } catch { return slot.key; } })();
                return (
                  <PanelContextMenu key={vRow.key}>
                    <PanelContextMenuTrigger asChild>
                  <div
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: `${vRow.size}px`, transform: `translateY(${vRow.start}px)` }}
                    className={`flex flex-col justify-center pl-3 pr-6 text-[11px] font-mono border-b ${
                      vRow.index % 2 === 0 ? "bg-muted/30" : ""
                    }`}
                  >
                    {/* 第一行: R标记 + key + type + 第三栏 */}
                    <div className="flex items-center leading-tight w-full overflow-hidden">
                      {slot.isRead && (
                        <span className="shrink-0 text-[9px] text-cyan-400/70" title="SLOAD">R</span>
                      )}
                      {annotation ? (
                        <>
                          <span className="w-[10%] shrink-0 truncate text-muted-foreground" title={slot.key}>
                            {small ? trimmedKey : slot.key.slice(0, 10) + "…"}
                          </span>
                          <span className="w-[50%] shrink-0 truncate text-muted-foreground" title={`${annotation.name ?? ""}: ${solTypeToString(annotation.type)}`}>
                            {annotation.name ? `${annotation.name} ${solTypeToString(annotation.type)}` : solTypeToString(annotation.type)}
                          </span>
                          <span className="w-[40%] shrink-0 truncate text-muted-foreground" />
                        </>
                      ) : (
                        <span className="flex-1 truncate text-muted-foreground" title={slot.key}>
                          {small ? trimmedKey : slot.key}
                        </span>
                      )}
                    </div>
                    {/* 第二行: value */}
                    <div className="pl-6 leading-tight truncate text-muted-foreground text-center" title={slot.presentValue}>
                      {slot.presentValue}
                    </div>
                    {/* ⊞ 绝对定位，垂直居中右侧 */}
                    {!slot.isRead && slot.history.length > 0 && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <span
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none"
                            title="查看变迁历史"
                          >⊞</span>
                        </PopoverTrigger>
                        <PopoverContent side="top" align="center" className="w-max p-0 overflow-hidden border-2 shadow-xl bg-card/95 backdrop-blur-sm">
                          <div className="max-h-64 overflow-auto font-mono text-[11px]">
                            {slot.history.map((h, i) => (
                              <div
                                key={i}
                                className={`flex items-center gap-4 px-3 py-1.5 border-b last:border-b-0 whitespace-nowrap ${
                                  i % 2 === 0 ? "bg-muted/30" : ""
                                }`}
                              >
                                <span className="text-amber-500 shrink-0">#{h.stepIndex}</span>
                                <span className="text-muted-foreground shrink-0">{h.hadValue}</span>
                                <span className="text-muted-foreground shrink-0">→</span>
                                <span className="text-muted-foreground shrink-0">{h.newValue}</span>
                              </div>
                            ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                    </PanelContextMenuTrigger>
                    <PanelContextMenuContent>
                      <PanelContextMenuItem
                        onSelect={() => navigator.clipboard.writeText(slot.presentValue)}
                      >
                        Copy Value
                      </PanelContextMenuItem>
                      <PanelContextMenuItem
                        onSelect={() => {
                          const stripped = slot.presentValue.replace(/^0x/i, "").replace(/^0+/, "") || "0";
                          navigator.clipboard.writeText("0x" + stripped);
                        }}
                      >
                        Copy as Hex
                      </PanelContextMenuItem>
                      <PanelContextMenuItem
                        onSelect={() => {
                          const hex = slot.presentValue.replace(/^0x/i, "");
                          navigator.clipboard.writeText("0x" + hex.slice(-40).toLowerCase());
                        }}
                      >
                        Copy as Address
                      </PanelContextMenuItem>
                      <PanelContextMenuItem
                        onSelect={() => {
                          try {
                            const dec = BigInt(slot.presentValue).toString(10);
                            navigator.clipboard.writeText(dec);
                          } catch {
                            navigator.clipboard.writeText(slot.presentValue);
                          }
                        }}
                      >
                        Copy as Uint256 (dec)
                      </PanelContextMenuItem>
                      {/* Notes: hidden until feature is complete
                      <PanelContextMenuSeparator />
                      <PanelContextMenuItem
                        onSelect={() => {
                          const stepIndex = useDebugStore.getState().currentStepIndex;
                          addValueRecordFromStorage(stepIndex, slot.key, slot.presentValue);
                        }}
                      >
                        Record Value
                      </PanelContextMenuItem>
                      */}
                    </PanelContextMenuContent>
                  </PanelContextMenu>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm border-t">
            Empty Storage 
          </div>
        )}

        {/* 变迁历史 popover 已内联在每个 slot 行里 */}
      </CardContent>
    </Card>

    <SlotAnnotationDrawer
      open={drawerOpen}
      onClose={() => setDrawerOpen(false)}
      chainId={currentDebugChainId}
      address={drawerAddress}
      onSaved={(savedSlots) => {
        if (drawerAddress) handleAnnotationsSaved(drawerAddress, savedSlots);
      }}
    />
  </>
  );
}
