// Opcode 频率统计
// 按 opcode 类型分组统计出现次数和总 gas
const stats = {};
for (const s of trace) {
  if (!stats[s.opcode]) stats[s.opcode] = { count: 0, gas: 0 };
  stats[s.opcode].count++;
  stats[s.opcode].gas += s.gasCost;
}
Object.entries(stats)
  .map(([op, v]) => ({ opcode: op, count: v.count, totalGas: v.gas }))
  .sort((a, b) => b.totalGas - a.totalGas)
