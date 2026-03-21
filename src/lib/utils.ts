import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs))
}
export function bytesToHex(bytes: Uint8Array): string {
    return '0x' + Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// 根据地址末 4 位确定性地映射到一个固定颜色类，相同地址始终同色
const ADDR_PALETTE = [
  'text-blue-400',    'text-emerald-400', 'text-violet-400',
  'text-amber-400',   'text-rose-400',    'text-cyan-400',
  'text-orange-400',  'text-teal-400',    'text-pink-400',
  'text-indigo-400',  'text-sky-400',     'text-lime-400',
];
export function addrColor(addr?: string): string {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return 'text-muted-foreground';
  const h = parseInt(addr.slice(-4), 16) || 0;
  return ADDR_PALETTE[h % ADDR_PALETTE.length];
}