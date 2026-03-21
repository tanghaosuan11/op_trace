// LOG 事件汇总
// 列出所有 LOG0-LOG4 事件的 step、topic 数量和 memory 数据偏移
const LOG_OPS = ["LOG0", "LOG1", "LOG2", "LOG3", "LOG4"];
trace
  .filter(s => LOG_OPS.includes(s.opcode))
  .map(s => {
    const stack = s.stack;
    const len = stack.length;
    const offset = hexToNumber(stack[len - 1]);
    const size = hexToNumber(stack[len - 2]);
    const topicCount = parseInt(s.opcode.replace("LOG", ""), 10);
    const topics = [];
    for (let i = 0; i < topicCount; i++) {
      topics.push(stack[len - 3 - i]);
    }
    return {
      step: s.index,
      context: s.contextId,
      pc: s.pc,
      opcode: s.opcode,
      offset,
      size,
      topics,
      data: readMemory(s, offset, size),
    };
  })
