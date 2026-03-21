// Gas 消耗 Top 20
// 找出 gas 消耗最高的 20 个步骤，按消耗降序排列
// 点击行可跳转到对应步骤
trace
  .sort((a, b) => b.gasCost - a.gasCost)
  .slice(0, 20)
  .map(s => ({ stepIndex: s.index, pc: s.pc, opcode: s.opcode, gas: s.gasCost }))
