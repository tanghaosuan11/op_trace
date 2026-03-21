// CALL 调用统计
// 列出所有外部调用 (CALL/STATICCALL/DELEGATECALL/CALLCODE)
const CALL_OPS = ["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE"];
trace
  .filter(s => CALL_OPS.includes(s.opcode))
  .map(s => {
    const stack = s.stack;
    const len = stack.length;
    // CALL: gas, addr, value, ...  STATICCALL/DELEGATECALL: gas, addr, ...
    const gasArg = stack[len - 1];
    const addr = "0x" + (stack[len - 2] || "").slice(-40);
    return {
      stepIndex: s.index,
      context: s.contextId,
      opcode: s.opcode,
      pc: s.pc,
      target: addr,
      gasArg: hexToNumber(gasArg),
    };
  })
