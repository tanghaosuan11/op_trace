// ============================================================
//  OpTrace Analysis Script Guide
//  This file is documentation only — it is not executable.
// ============================================================
//
// Each script is plain JavaScript. Two global variables are
// injected before your script runs:
//
//   trace  — array of step objects (see "Step Object" below)
//   steps  — alias for trace
//
// The script's return value (last expression) is displayed as
// the result. Return an array or object for best readability.
//
// ── Step Object ─────────────────────────────────────────────
//
//   stepIndex    {number}   global step index (click to jump)
//   index        {number}   same as stepIndex (legacy alias)
//   contextId    {number}   call frame ID
//   frameStep    {number}   step counter within the frame
//   pc           {number}   program counter
//   opcode       {string}   opcode name, e.g. "SSTORE"
//   opcodeNum    {number}   opcode byte value
//   opcodeHex    {string}   opcode as hex, e.g. "0x55"
//   gasCost      {number}   gas consumed by this step
//   gasRemaining {number}   gas left after this step
//   contract     {string}   bytecode address (hex, 0x-prefixed)
//   target       {string}   call target address (hex, 0x-prefixed)
//   stack        {string[]} stack items as 0x-prefixed hex (top = last)
//
// ── Built-in Helpers ────────────────────────────────────────
//
//   hexToNumber(hex)
//     Convert a 0x-prefixed hex string to a JS number.
//     Example: hexToNumber("0x1e") === 30
//
//   readMemory(stepOrIndex, offset, size)
//     Read a slice of memory at the given step.
//     - stepOrIndex: a step object or a global stepIndex number
//     - offset, size: byte offset and byte length
//     Returns a 0x-prefixed hex string.
//     Example: readMemory(s, 0, 32)
//
// ── Pre-execution Filters (@filter directives) ──────────────
//
// Write filter directives as comments at the top of the script.
// The backend applies them before injecting steps into JS,
// which significantly reduces memory and execution time for
// large transactions.
//
// Supported directives:
//
//   // @filter opcodes:  SSTORE, SLOAD
//     Only include steps whose opcode matches any in the list.
//     Accepts opcode names or hex values (e.g. 0x55).
//
//   // @filter contract: 0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
//     Only include steps where the executing contract address
//     matches (case-insensitive). Useful for focusing on one
//     specific contract in a multi-contract transaction.
//
//   // @filter target:   0x1234...
//     Only include steps where the call target matches.
//
//   // @filter frames:   1, 5, 10
//     Only include steps belonging to the listed frame IDs
//     (contextId values). Use the Call Tree to find frame IDs.
//
//   // @filter steps:    100000-200000
//     Only include steps whose global index is within [from, to]
//     (inclusive). Useful for narrowing down a long trace.
//     Separator can be a dash (-) or comma (,).
//
// Multiple directives can be combined; all conditions are AND-ed.
//
// Example:
//
//   // @filter opcodes:  SSTORE
//   // @filter contract: 0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
//   // @filter steps:    0-500000
//
//   trace.map(s => ({
//     stepIndex: s.stepIndex,
//     slot:  s.stack[s.stack.length - 1],
//     value: s.stack[s.stack.length - 2],
//   }))
//
// ── Lazy Mode (@lazy) ───────────────────────────────────────
//
// Add // @lazy anywhere in the script to skip the trace injection
// step entirely. trace and steps will be empty arrays. All data
// must be fetched via the Query API below.
//
// When to use: scripts that operate on 100k+ steps and only use
// query functions — avoids the O(n) serialisation cost upfront.
//
// Example:
//
//   // @lazy
//   aggregateByOpcode()    // purely Rust-side, instant
//
// Note: readMemory() and iteration over trace/steps will not work
// in lazy mode. Use getStep(i) for individual step access.
//
// ── Query API (Memory-efficient, Rust-side) ─────────────────
//
// These functions operate directly on the trace data in Rust,
// avoiding the cost of injecting large arrays into JS.
// Use them when the full `trace` array would be too large.
//
//   totalSteps()
//     Returns the total number of steps in the session.
//     Example: totalSteps()  →  700000
//
//   findStepIndices(opcode, from?, to?)
//     Returns an array of global step indices (numbers only)
//     where the opcode matches. from/to are optional range limits.
//     Example: findStepIndices("SSTORE")
//     Example: findStepIndices("SLOAD", 100000, 200000)
//
//   firstStep(opcode, from?)
//     Returns the global index of the first matching step, or null.
//     Example: firstStep("DELEGATECALL")
//
//   countSteps(opcode, from?, to?)
//     Returns a count without building an array.
//     Example: countSteps("SSTORE")  →  847
//
//   getStep(i)
//     Fetch a single step object by global index (on-demand).
//     Same fields as steps in the `trace` array.
//     Combine with findStepIndices for memory-efficient access:
//       findStepIndices("SSTORE").map(i => getStep(i))
//
//   aggregateByOpcode(from?, to?)
//     Returns [{opcode, count, totalGas}] sorted by totalGas desc.
//     Entire computation happens in Rust — result is a small object.
//     Example: aggregateByOpcode()
//     Example: aggregateByOpcode(0, 500000)
//
//   countByFrame()
//     Returns [{contextId, stepCount}] sorted by stepCount desc.
//     Uses the pre-built frame index — nearly instant.
//     Example: countByFrame()
//
//   getContractStats(addr)
//     Returns { stepCount, totalGas, opcodes: {name: count} }
//     for a specific contract address.
//     Example: getContractStats("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")
//
//   getSlotHistory(slot)
//     Returns all SSTORE/TSTORE writes to a specific storage slot.
//     Includes old/new values (from execution journal — no guessing).
//     Result: [{stepIndex, frameId, isTransient, contract, key, oldValue, newValue}]
//     Useful for tracking balance/allowance changes in hack analysis.
//     Example: getSlotHistory("0x0000000000000000000000000000000000000000000000000000000000000001")
//
//   getFrameInfo(frameId)
//     Returns full metadata for a call frame by its ID (the contextId on step objects).
//     Result: {frameId, parentId, depth, address, caller, target, kind,
//              gasLimit, gasUsed, stepCount, success}  | null
//     kind: "Call" | "StaticCall" | "DelegateCall" | "CallCode" | "Create" | "Create2"
//     Example: getFrameInfo(5)
//     Example: getFrameInfo(getStep(idx).contextId)
//
//   getStorageChanges(address?, from?, to?)
//     Returns all storage reads AND writes for a contract address.
//     Pass "" or omit address to get changes across all contracts.
//     from/to are optional step index limits.
//     Result: [{stepIndex, frameId, isTransient, isRead, contract, key, oldValue, newValue}]
//     Example: getStorageChanges("0xa0b8...")
//     Example: getStorageChanges("", 0, 100000)   // all contracts, first 100k steps
//
// ── Recommended Pattern for Large Transactions ──────────────
//
//   // Step 1: find indices in Rust (cheap)
//   const sstoreIndices = findStepIndices("SSTORE");
//
//   // Step 2: fetch only what you need
//   const results = sstoreIndices
//     .filter(i => getStep(i).contract === "0x1234...")
//     .map(i => {
//       const s = getStep(i);
//       return { stepIndex: s.stepIndex, slot: s.stack.at(-1), value: s.stack.at(-2) };
//     });
//
//   results
//
// ── Result Interactivity ────────────────────────────────────
//
// Any numeric value under the key "stepIndex" in the result
// is rendered as a clickable link. Clicking it seeks the
// debugger to that step.
//
// ── Keyboard Shortcuts ──────────────────────────────────────
//
//   Ctrl+Enter  Run the current script
//   Ctrl+S      Save the current script
//
// ── Tips ────────────────────────────────────────────────────
//
//   • For large transactions (700k+ steps):
//     - Add // @lazy if you only need query API functions.
//     - Add // @filter opcodes: ... to reduce injected step count.
//   • Access the stack top with: s.stack[s.stack.length - 1]
//   • Sort results: .sort((a, b) => b.gas - a.gas)
//   • Group by field: use a plain object as a map.
