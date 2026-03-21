import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://api.4byte.sourcify.dev/signature-database/v1/lookup";
const OUT_PATH = join(__dirname, "../src/lib/fourbyteDb.json");
// 并发请求数，避免被限速
const CONCURRENCY = 5;
// 请求失败时重试次数
const RETRIES = 2;

// 读取 4byte.txt
const txtPath = join(__dirname, "4byte.txt");
const lines = readFileSync(txtPath, "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^0x[0-9a-fA-F]{8}$/.test(l));

// 读取已有结果（支持断点续传）
const db = existsSync(OUT_PATH)
  ? JSON.parse(readFileSync(OUT_PATH, "utf-8"))
  : {};

// 跳过已有有效结果的条目（fn 或 ev），null(无结果/曾经失败) 重新查询
const pending = lines.filter((sel) => {
  if (!(sel in db)) return true;       // 从未查过
  if (db[sel] === null) return true;   // 曾查不到或失败，重试
  return false;                        // 已有有效结果，跳过
});
const skipped = lines.length - pending.length;
const uniqueLines = new Set(lines).size;
console.log(`总计 ${lines.length} 条（唯一 ${uniqueLines} 条），已有有效结果 ${skipped} 条，待查询 ${pending.length} 条\n`);

let found = 0;
let notFound = 0;
let errors = 0;

async function lookup(sel) {
  const url = `${API_BASE}?function=${sel}&event=${sel}&filter=false`;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        // 被限速，等待后重试
        const wait = 2000 * (attempt + 1);
        console.error(`[429] ${sel} 限速，${wait}ms 后重试 (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        if (attempt < RETRIES) {
          const wait = 1000 * (attempt + 1);
          console.error(`[HTTP ${res.status}] ${sel}，${wait}ms 后重试 (attempt ${attempt + 1})`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        console.error(`[HTTP ${res.status}] ${sel} 放弃`);
        errors++;
        return;
      }
      const json = await res.json();
      const firstFunc = (json?.result?.function?.[sel] ?? [])[0];
      const firstEvent = (json?.result?.event?.[sel] ?? [])[0];

      if (!firstFunc && !firstEvent) {
        db[sel] = null;
        notFound++;
        process.stdout.write(`${sel}  → (no match)\n`);
      } else {
        const entry = {};
        if (firstFunc) entry.fn = firstFunc.name;
        if (firstEvent) entry.ev = firstEvent.name;
        db[sel] = entry;
        found++;
        const parts = [];
        if (entry.fn) parts.push(`fn: ${entry.fn}`);
        if (entry.ev) parts.push(`ev: ${entry.ev}`);
        process.stdout.write(`${sel}  → ${parts.join("  /  ")}\n`);
      }
      return;
    } catch (err) {
      if (attempt < RETRIES) {
        const wait = 1000 * (attempt + 1);
        console.error(`[ERROR] ${sel}: ${err.message}，${wait}ms 后重试 (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        console.error(`[ERROR] ${sel}: ${err.message} 放弃`);
        errors++;
      }
    }
  }
}

// 按 CONCURRENCY 分批并发执行
for (let i = 0; i < pending.length; i += CONCURRENCY) {
  const batch = pending.slice(i, i + CONCURRENCY);
  await Promise.all(batch.map(lookup));

  // 每 100 条保存一次，支持中途 Ctrl+C 续传
  if ((i + CONCURRENCY) % 100 === 0 || i + CONCURRENCY >= pending.length) {
    // 只写入有结果的条目（null 也写入，避免重复查询）
    writeFileSync(OUT_PATH, JSON.stringify(db, null, 2));
    console.log(`[saved] ${i + batch.length}/${pending.length}`);
  }
}

// 最终保存
writeFileSync(OUT_PATH, JSON.stringify(db, null, 2));
console.log(`\n✅ 有结果: ${found}  ❌ 无结果: ${notFound}  ⚠ 错误: ${errors}`);
console.log(`已保存到 ${OUT_PATH}`);
