// SSTORE 操作汇总
// 列出所有 SSTORE 操作的 step、槽位 (key) 和写入值 (value)
// 点击行可跳转到对应步骤
trace
  .filter(s => s.opcode === "SSTORE")
  .map(s => ({
    stepIndex: s.index,
    context: s.contextId,
    pc: s.pc,
    key: s.stack[s.stack.length - 1],
    value: s.stack[s.stack.length - 2],
  }))
