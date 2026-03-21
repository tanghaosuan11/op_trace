import { bytesToHex } from "./utils";

export interface OpInfo {
  name: string;
  category: 'stop' | 'arithmetic' | 'logic' | 'keccak256' | 'info' | 'stack' | 'memory' | 'storage' | 'flow' | 'system' | 'invalid';
}

export interface Opcode {
  pc: number;
  name: string;
  category: string;
  data?: string;
  gas?: number;
  warning?: string;
  isMetadata?: boolean; 
}

export const OP_MAP: Record<number, OpInfo> = {
  // 0x00 range - Arithmetic
  0x00: { name: "STOP", category: "stop" },
  0x01: { name: "ADD", category: "arithmetic" },
  0x02: { name: "MUL", category: "arithmetic" },
  0x03: { name: "SUB", category: "arithmetic" },
  0x04: { name: "DIV", category: "arithmetic" },
  0x05: { name: "SDIV", category: "arithmetic" },
  0x06: { name: "MOD", category: "arithmetic" },
  0x07: { name: "SMOD", category: "arithmetic" },
  0x08: { name: "ADDMOD", category: "arithmetic" },
  0x09: { name: "MULMOD", category: "arithmetic" },
  0x0a: { name: "EXP", category: "arithmetic" },
  0x0b: { name: "SIGNEXTEND", category: "arithmetic" },

  // 0x10 range - Comparison & Bitwise
  0x10: { name: "LT", category: "logic" },
  0x11: { name: "GT", category: "logic" },
  0x12: { name: "SLT", category: "logic" },
  0x13: { name: "SGT", category: "logic" },
  0x14: { name: "EQ", category: "logic" },
  0x15: { name: "ISZERO", category: "logic" },
  0x16: { name: "AND", category: "logic" },
  0x17: { name: "OR", category: "logic" },
  0x18: { name: "XOR", category: "logic" },
  0x19: { name: "NOT", category: "logic" },
  0x1a: { name: "BYTE", category: "logic" },
  0x1b: { name: "SHL", category: "logic" },
  0x1c: { name: "SHR", category: "logic" },
  0x1d: { name: "SAR", category: "logic" },
  0x1e: { name: "CLZ", category: "logic" }, // EIP-7939, Count Leading Zeros

  // 0x20 range - KECCAK256
  0x20: { name: "KECCAK256", category: "keccak256" },

  // 0x30 range - Environmental Info
  0x30: { name: "ADDRESS", category: "info" },
  0x31: { name: "BALANCE", category: "info" },
  0x32: { name: "ORIGIN", category: "info" },
  0x33: { name: "CALLER", category: "info" },
  0x34: { name: "CALLVALUE", category: "info" },
  0x35: { name: "CALLDATALOAD", category: "info" },
  0x36: { name: "CALLDATASIZE", category: "info" },
  0x37: { name: "CALLDATACOPY", category: "info" },
  0x38: { name: "CODESIZE", category: "info" },
  0x39: { name: "CODECOPY", category: "info" },
  0x3a: { name: "GASPRICE", category: "info" },
  0x3b: { name: "EXTCODESIZE", category: "info" },
  0x3c: { name: "EXTCODECOPY", category: "info" },
  0x3d: { name: "RETURNDATASIZE", category: "info" },
  0x3e: { name: "RETURNDATACOPY", category: "info" },
  0x3f: { name: "EXTCODEHASH", category: "info" },

  // 0x40 range - Block Info
  0x40: { name: "BLOCKHASH", category: "info" },
  0x41: { name: "COINBASE", category: "info" },
  0x42: { name: "TIMESTAMP", category: "info" },
  0x43: { name: "NUMBER", category: "info" },
  0x44: { name: "DIFFICULTY", category: "info" },
  0x45: { name: "GASLIMIT", category: "info" },
  0x46: { name: "CHAINID", category: "info" },
  0x47: { name: "SELFBALANCE", category: "info" },
  0x48: { name: "BASEFEE", category: "info" },
  0x49: { name: "BLOBHASH", category: "info" },     // EIP-4844
  0x4a: { name: "BLOBBASEFEE", category: "info" }, // EIP-7516
  0x4b: { name: "SLOTNUM", category: "info" },      // custom

  // 0x50 range - Memory, Storage, Stack, Flow
  0x50: { name: "POP", category: "stack" },
  0x51: { name: "MLOAD", category: "memory" },
  0x52: { name: "MSTORE", category: "memory" },
  0x53: { name: "MSTORE8", category: "memory" },
  0x54: { name: "SLOAD", category: "storage" },
  0x55: { name: "SSTORE", category: "storage" },
  0x56: { name: "JUMP", category: "flow" },
  0x57: { name: "JUMPI", category: "flow" },
  0x58: { name: "PC", category: "info" },
  0x59: { name: "MSIZE", category: "memory" },
  0x5a: { name: "GAS", category: "info" },
  0x5b: { name: "JUMPDEST", category: "flow" },
  0x5c: { name: "TLOAD", category: "storage" }, // Cancun EIP-1153
  0x5d: { name: "TSTORE", category: "storage" }, // Cancun EIP-1153
  0x5e: { name: "MCOPY", category: "memory" }, // Cancun
  0x5f: { name: "PUSH0", category: "stack" }, // Shanghai

  // 0x60 - 0x7f: PUSH1 - PUSH32
  ...Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [
      0x60 + i,
      { name: `PUSH${i + 1}`, category: "stack" }
    ])
  ),

  // 0x80 - 0x8f: DUP1 - DUP16
  ...Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [
      0x80 + i,
      { name: `DUP${i + 1}`, category: "stack" }
    ])
  ),

  // 0x90 - 0x9f: SWAP1 - SWAP16
  ...Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [
      0x90 + i,
      { name: `SWAP${i + 1}`, category: "stack" }
    ])
  ),

  // 0xa0 range - Logging
  0xa0: { name: "LOG0", category: "system" },
  0xa1: { name: "LOG1", category: "system" },
  0xa2: { name: "LOG2", category: "system" },
  0xa3: { name: "LOG3", category: "system" },
  0xa4: { name: "LOG4", category: "system" },

  // 0xe6-0xe8: EOF EIP-663
  0xe6: { name: "DUPN", category: "stack" },
  0xe7: { name: "SWAPN", category: "stack" },
  0xe8: { name: "EXCHANGE", category: "stack" },

  // 0xf0 range - System
  0xf0: { name: "CREATE", category: "system" },
  0xf1: { name: "CALL", category: "system" },
  0xf2: { name: "CALLCODE", category: "system" },
  0xf3: { name: "RETURN", category: "stop" },
  0xf4: { name: "DELEGATECALL", category: "system" },
  0xf5: { name: "CREATE2", category: "system" },
  0xfa: { name: "STATICCALL", category: "system" },
  0xfd: { name: "REVERT", category: "stop" },
  0xfe: { name: "INVALID", category: "invalid" },
  0xff: { name: "SELFDESTRUCT", category: "stop" },
};


// Opcode descriptions for teaching
export interface MemoryAccessParam {
  offsetParam: string;   // stackInput 中 offset 参数的名称
  sizeParam?: string;    // stackInput 中 size 参数的名称（可选）
  fixedSize?: number;    // 固定大小（当无 sizeParam 时使用，如 MLOAD/MSTORE 为 32）
}

export interface OpcodeInfo {
  description: string;
  stackInput: string[];
  stackOutput: string[];
  /** Real total size of stackInput when "..." is used as an ellipsis placeholder */
  stackInputSize?: number;
  /** Real total size of stackOutput when "..." is used as an ellipsis placeholder */
  stackOutputSize?: number;
  memoryEffect?: string;
  storageEffect?: string;
  gas: string;
  memoryAccess?: MemoryAccessParam[];
}

export const OPCODE_INFO: Record<number, OpcodeInfo> = {
  // ── Stop ──
  0x00: { description: "Halts execution of the current contract call", stackInput: [], stackOutput: [], gas: "0" },

  // ── Arithmetic ──
  0x01: { description: "Addition: pops two values and pushes their sum (mod 2^256)", stackInput: ["a", "b"], stackOutput: ["a + b"], gas: "3" },
  0x02: { description: "Multiplication: pops two values and pushes their product (mod 2^256)", stackInput: ["a", "b"], stackOutput: ["a * b"], gas: "5" },
  0x03: { description: "Subtraction: pops two values and pushes a - b (mod 2^256)", stackInput: ["a", "b"], stackOutput: ["a - b"], gas: "3" },
  0x04: { description: "Integer division: pushes a / b (0 if b is zero)", stackInput: ["a", "b"], stackOutput: ["a / b"], gas: "5" },
  0x05: { description: "Signed integer division (truncated toward zero)", stackInput: ["a", "b"], stackOutput: ["a / b (signed)"], gas: "5" },
  0x06: { description: "Modulo remainder: pushes a mod b (0 if b is zero)", stackInput: ["a", "b"], stackOutput: ["a % b"], gas: "5" },
  0x07: { description: "Signed modulo remainder", stackInput: ["a", "b"], stackOutput: ["a % b (signed)"], gas: "5" },
  0x08: { description: "Modulo addition: pushes (a + b) mod N", stackInput: ["a", "b", "N"], stackOutput: ["(a + b) % N"], gas: "8" },
  0x09: { description: "Modulo multiplication: pushes (a * b) mod N", stackInput: ["a", "b", "N"], stackOutput: ["(a * b) % N"], gas: "8" },
  0x0a: { description: "Exponentiation: pushes a raised to the power b", stackInput: ["a", "b"], stackOutput: ["a ** b"], gas: "10*" },
  0x0b: { description: "Sign extends x from (b+1)*8 bits to 256 bits", stackInput: ["b", "x"], stackOutput: ["signextend(x, b)"], gas: "5" },

  // ── Comparison & Bitwise ──
  0x10: { description: "Less-than comparison: pushes 1 if a < b, else 0", stackInput: ["a", "b"], stackOutput: ["a < b ? 1 : 0"], gas: "3" },
  0x11: { description: "Greater-than comparison: pushes 1 if a > b, else 0", stackInput: ["a", "b"], stackOutput: ["a > b ? 1 : 0"], gas: "3" },
  0x12: { description: "Signed less-than comparison: pushes 1 if a < b (signed), else 0", stackInput: ["a", "b"], stackOutput: ["a < b ? 1 : 0 (signed)"], gas: "3" },
  0x13: { description: "Signed greater-than comparison: pushes 1 if a > b (signed), else 0", stackInput: ["a", "b"], stackOutput: ["a > b ? 1 : 0 (signed)"], gas: "3" },
  0x14: { description: "Equality comparison: pushes 1 if a == b, else 0", stackInput: ["a", "b"], stackOutput: ["a == b ? 1 : 0"], gas: "3" },
  0x15: { description: "Is-zero check: pushes 1 if a == 0, else 0", stackInput: ["a"], stackOutput: ["a == 0 ? 1 : 0"], gas: "3" },
  0x16: { description: "Bitwise AND", stackInput: ["a", "b"], stackOutput: ["a & b"], gas: "3" },
  0x17: { description: "Bitwise OR", stackInput: ["a", "b"], stackOutput: ["a | b"], gas: "3" },
  0x18: { description: "Bitwise XOR", stackInput: ["a", "b"], stackOutput: ["a ^ b"], gas: "3" },
  0x19: { description: "Bitwise NOT", stackInput: ["a"], stackOutput: ["~a"], gas: "3" },
  0x1a: { description: "Retrieve byte i from 32-byte value x (i=0 is the most significant)", stackInput: ["i", "x"], stackOutput: ["(x >> (248 - i*8)) & 0xFF"], gas: "3" },
  0x1b: { description: "Left shift: shifts value left by shift bits", stackInput: ["shift", "value"], stackOutput: ["value << shift"], gas: "3" },
  0x1c: { description: "Logical right shift: shifts value right by shift bits", stackInput: ["shift", "value"], stackOutput: ["value >> shift"], gas: "3" },
  0x1d: { description: "Arithmetic right shift: shifts value right preserving the sign bit", stackInput: ["shift", "value"], stackOutput: ["value >> shift (arithmetic)"], gas: "3" },
  0x1e: { description: "Count leading zeros: pushes the number of leading zero bits in x (EIP-7939)", stackInput: ["x"], stackOutput: ["clz(x)"], gas: "5" },

  // ── Hash ──
  0x20: { description: "Compute Keccak-256 hash of memory[offset : offset+size]", stackInput: ["offset", "size"], stackOutput: ["hash"], memoryEffect: "Reads memory[offset : offset+size]", gas: "30+", memoryAccess: [{ offsetParam: "offset", sizeParam: "size" }] },

  // ── Environmental Info ──
  0x30: { description: "Get the address of the currently executing account", stackInput: [], stackOutput: ["address"], gas: "2" },
  0x31: { description: "Get the ETH balance of the given address", stackInput: ["address"], stackOutput: ["balance"], gas: "100/2600" },
  0x32: { description: "Get the address that originated the transaction (tx.origin)", stackInput: [], stackOutput: ["origin"], gas: "2" },
  0x33: { description: "Get the caller address (msg.sender)", stackInput: [], stackOutput: ["caller"], gas: "2" },
  0x34: { description: "Get the ETH value sent with the current call (msg.value)", stackInput: [], stackOutput: ["value"], gas: "2" },
  0x35: { description: "Load 32 bytes from calldata at byte offset i", stackInput: ["i"], stackOutput: ["calldata[i:i+32]"], gas: "3" },
  0x36: { description: "Get byte size of the calldata", stackInput: [], stackOutput: ["size"], gas: "2" },
  0x37: { description: "Copy calldata to memory", stackInput: ["destOffset", "offset", "size"], stackOutput: [], memoryEffect: "memory[destOffset:destOffset+size] = calldata[offset:offset+size]", gas: "3+", memoryAccess: [{ offsetParam: "destOffset", sizeParam: "size" }] },
  0x38: { description: "Get byte size of the currently executing contract's code", stackInput: [], stackOutput: ["size"], gas: "2" },
  0x39: { description: "Copy currently executing contract's code to memory", stackInput: ["destOffset", "offset", "size"], stackOutput: [], memoryEffect: "memory[destOffset:destOffset+size] = code[offset:offset+size]", gas: "3+", memoryAccess: [{ offsetParam: "destOffset", sizeParam: "size" }] },
  0x3a: { description: "Get the gas price of the current transaction", stackInput: [], stackOutput: ["price"], gas: "2" },
  0x3b: { description: "Get byte size of an external account's code", stackInput: ["address"], stackOutput: ["size"], gas: "100/2600" },
  0x3c: { description: "Copy an external account's code to memory", stackInput: ["address", "destOffset", "offset", "size"], stackOutput: [], memoryEffect: "memory[destOffset:destOffset+size] = extcode[offset:offset+size]", gas: "100+", memoryAccess: [{ offsetParam: "destOffset", sizeParam: "size" }] },
  0x3d: { description: "Get byte size of the last return data", stackInput: [], stackOutput: ["size"], gas: "2" },
  0x3e: { description: "Copy last return data to memory", stackInput: ["destOffset", "offset", "size"], stackOutput: [], memoryEffect: "memory[destOffset:destOffset+size] = returndata[offset:offset+size]", gas: "3+", memoryAccess: [{ offsetParam: "destOffset", sizeParam: "size" }] },
  0x3f: { description: "Get the keccak256 hash of an external account's code", stackInput: ["address"], stackOutput: ["hash"], gas: "100/2600" },

  // ── Block Info ──
  0x40: { description: "Get hash of the given block (only valid for last 256 blocks)", stackInput: ["blockNumber"], stackOutput: ["hash"], gas: "20" },
  0x41: { description: "Get the block's beneficiary address (coinbase)", stackInput: [], stackOutput: ["coinbase"], gas: "2" },
  0x42: { description: "Get the block's Unix timestamp", stackInput: [], stackOutput: ["timestamp"], gas: "2" },
  0x43: { description: "Get the current block number", stackInput: [], stackOutput: ["blockNumber"], gas: "2" },
  0x44: { description: "Get the DIFFICULTY / PREVRANDAO value of the current block", stackInput: [], stackOutput: ["difficulty"], gas: "2" },
  0x45: { description: "Get the block's gas limit", stackInput: [], stackOutput: ["gasLimit"], gas: "2" },
  0x46: { description: "Get the chain ID", stackInput: [], stackOutput: ["chainId"], gas: "2" },
  0x47: { description: "Get the ETH balance of the currently executing account", stackInput: [], stackOutput: ["balance"], gas: "5" },
  0x48: { description: "Get the base fee of the current block (EIP-1559)", stackInput: [], stackOutput: ["basefee"], gas: "2" },
  0x49: { description: "Get the versioned hash of the blob at the given index (EIP-4844)", stackInput: ["index"], stackOutput: ["versionedHash"], gas: "3" },
  0x4a: { description: "Get the blob base fee of the current block (EIP-7516)", stackInput: [], stackOutput: ["blobBasefee"], gas: "2" },
  0x4b: { description: "Get the current slot number (custom extension)", stackInput: [], stackOutput: ["slotNum"], gas: "2" },

  // ── Stack / Memory / Storage ──
  0x50: { description: "Remove (pop and discard) the top stack item", stackInput: ["a"], stackOutput: [], gas: "2" },
  0x51: { description: "Load 32 bytes from memory at offset", stackInput: ["offset"], stackOutput: ["value"], memoryEffect: "Reads memory[offset : offset+32]", gas: "3+", memoryAccess: [{ offsetParam: "offset", fixedSize: 32 }] },
  0x52: { description: "Store 32-byte value to memory at offset", stackInput: ["offset", "value"], stackOutput: [], memoryEffect: "memory[offset:offset+32] = value", gas: "3+", memoryAccess: [{ offsetParam: "offset", fixedSize: 32 }] },
  0x53: { description: "Store the least significant byte of value to memory[offset]", stackInput: ["offset", "value"], stackOutput: [], memoryEffect: "memory[offset] = value & 0xFF", gas: "3+", memoryAccess: [{ offsetParam: "offset", fixedSize: 1 }] },
  0x54: { description: "Load a value from persistent storage at the given slot", stackInput: ["key"], stackOutput: ["value"], storageEffect: "Reads storage[key]", gas: "100/2100" },
  0x55: { description: "Store a value to persistent storage at the given slot", stackInput: ["key", "value"], stackOutput: [], storageEffect: "storage[key] = value", gas: "100/20000" },
  0x56: { description: "Unconditional jump: set PC to dest", stackInput: ["dest"], stackOutput: [], gas: "8" },
  0x57: { description: "Conditional jump: set PC to dest if cond is non-zero", stackInput: ["dest", "cond"], stackOutput: [], gas: "10" },
  0x58: { description: "Push the current program counter onto the stack", stackInput: [], stackOutput: ["pc"], gas: "2" },
  0x59: { description: "Push the current memory size (in bytes) onto the stack", stackInput: [], stackOutput: ["size"], gas: "2" },
  0x5a: { description: "Push the amount of remaining gas onto the stack", stackInput: [], stackOutput: ["gas"], gas: "2" },
  0x5b: { description: "Mark a valid jump destination; no-op", stackInput: [], stackOutput: [], gas: "1" },
  0x5c: { description: "Load a value from transient storage at the given slot (EIP-1153)", stackInput: ["key"], stackOutput: ["value"], gas: "100" },
  0x5d: { description: "Store a value to transient storage (valid only within the current transaction, EIP-1153)", stackInput: ["key", "value"], stackOutput: [], gas: "100" },
  0x5e: { description: "Copy memory regions within memory (Cancun, EIP-5656)", stackInput: ["dest", "src", "size"], stackOutput: [], memoryEffect: "memory[dest:dest+size] = memory[src:src+size]", gas: "3+", memoryAccess: [{ offsetParam: "dest", sizeParam: "size" }, { offsetParam: "src", sizeParam: "size" }] },
  0x5f: { description: "Push the constant value 0 onto the stack (Shanghai, EIP-3855)", stackInput: [], stackOutput: ["0"], gas: "2" },

  // ── PUSH1–PUSH32 ──
  0x60: { description: "Push 1-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x61: { description: "Push 2-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x62: { description: "Push 3-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x63: { description: "Push 4-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x64: { description: "Push 5-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x65: { description: "Push 6-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x66: { description: "Push 7-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x67: { description: "Push 8-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x68: { description: "Push 9-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x69: { description: "Push 10-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x6a: { description: "Push 11-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x6b: { description: "Push 12-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x6c: { description: "Push 13-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x6d: { description: "Push 14-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x6e: { description: "Push 15-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x6f: { description: "Push 16-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x70: { description: "Push 17-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x71: { description: "Push 18-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x72: { description: "Push 19-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x73: { description: "Push 20-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x74: { description: "Push 21-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x75: { description: "Push 22-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x76: { description: "Push 23-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x77: { description: "Push 24-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x78: { description: "Push 25-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x79: { description: "Push 26-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x7a: { description: "Push 27-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x7b: { description: "Push 28-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x7c: { description: "Push 29-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x7d: { description: "Push 30-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x7e: { description: "Push 31-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },
  0x7f: { description: "Push 32-byte immediate value onto the stack", stackInput: [], stackOutput: ["value"], gas: "3" },

  // ── DUP1–DUP16 ──
  0x80: { description: "Duplicate the 1st stack item", stackInput: ["a"], stackOutput: ["a", "a"], gas: "3" },
  0x81: { description: "Duplicate the 2nd stack item", stackInput: ["a", "b"], stackOutput: ["b", "a", "b"], gas: "3" },
  0x82: { description: "Duplicate the 3rd stack item",  stackInput: ["a", "...", "c"], stackInputSize: 3,  stackOutput: ["c", "a", "...", "c"], stackOutputSize: 4,  gas: "3" },
  0x83: { description: "Duplicate the 4th stack item",  stackInput: ["a", "...", "d"], stackInputSize: 4,  stackOutput: ["d", "a", "...", "d"], stackOutputSize: 5,  gas: "3" },
  0x84: { description: "Duplicate the 5th stack item",  stackInput: ["a", "...", "e"], stackInputSize: 5,  stackOutput: ["e", "a", "...", "e"], stackOutputSize: 6,  gas: "3" },
  0x85: { description: "Duplicate the 6th stack item",  stackInput: ["a", "...", "f"], stackInputSize: 6,  stackOutput: ["f", "a", "...", "f"], stackOutputSize: 7,  gas: "3" },
  0x86: { description: "Duplicate the 7th stack item",  stackInput: ["a", "...", "g"], stackInputSize: 7,  stackOutput: ["g", "a", "...", "g"], stackOutputSize: 8,  gas: "3" },
  0x87: { description: "Duplicate the 8th stack item",  stackInput: ["a", "...", "h"], stackInputSize: 8,  stackOutput: ["h", "a", "...", "h"], stackOutputSize: 9,  gas: "3" },
  0x88: { description: "Duplicate the 9th stack item",  stackInput: ["a", "...", "i"], stackInputSize: 9,  stackOutput: ["i", "a", "...", "i"], stackOutputSize: 10, gas: "3" },
  0x89: { description: "Duplicate the 10th stack item", stackInput: ["a", "...", "j"], stackInputSize: 10, stackOutput: ["j", "a", "...", "j"], stackOutputSize: 11, gas: "3" },
  0x8a: { description: "Duplicate the 11th stack item", stackInput: ["a", "...", "k"], stackInputSize: 11, stackOutput: ["k", "a", "...", "k"], stackOutputSize: 12, gas: "3" },
  0x8b: { description: "Duplicate the 12th stack item", stackInput: ["a", "...", "l"], stackInputSize: 12, stackOutput: ["l", "a", "...", "l"], stackOutputSize: 13, gas: "3" },
  0x8c: { description: "Duplicate the 13th stack item", stackInput: ["a", "...", "m"], stackInputSize: 13, stackOutput: ["m", "a", "...", "m"], stackOutputSize: 14, gas: "3" },
  0x8d: { description: "Duplicate the 14th stack item", stackInput: ["a", "...", "n"], stackInputSize: 14, stackOutput: ["n", "a", "...", "n"], stackOutputSize: 15, gas: "3" },
  0x8e: { description: "Duplicate the 15th stack item", stackInput: ["a", "...", "o"], stackInputSize: 15, stackOutput: ["o", "a", "...", "o"], stackOutputSize: 16, gas: "3" },
  0x8f: { description: "Duplicate the 16th stack item", stackInput: ["a", "...", "p"], stackInputSize: 16, stackOutput: ["p", "a", "...", "p"], stackOutputSize: 17, gas: "3" },

  // ── SWAP1–SWAP16 ──
  0x90: { description: "Exchange 1st and 2nd stack items", stackInput: ["a", "b"], stackOutput: ["b", "a"], gas: "3" },
  0x91: { description: "Exchange 1st and 3rd stack items",  stackInput: ["a", "...", "c"], stackInputSize: 3,  stackOutput: ["c", "...", "a"], stackOutputSize: 3,  gas: "3" },
  0x92: { description: "Exchange 1st and 4th stack items",  stackInput: ["a", "...", "d"], stackInputSize: 4,  stackOutput: ["d", "...", "a"], stackOutputSize: 4,  gas: "3" },
  0x93: { description: "Exchange 1st and 5th stack items",  stackInput: ["a", "...", "e"], stackInputSize: 5,  stackOutput: ["e", "...", "a"], stackOutputSize: 5,  gas: "3" },
  0x94: { description: "Exchange 1st and 6th stack items",  stackInput: ["a", "...", "f"], stackInputSize: 6,  stackOutput: ["f", "...", "a"], stackOutputSize: 6,  gas: "3" },
  0x95: { description: "Exchange 1st and 7th stack items",  stackInput: ["a", "...", "g"], stackInputSize: 7,  stackOutput: ["g", "...", "a"], stackOutputSize: 7,  gas: "3" },
  0x96: { description: "Exchange 1st and 8th stack items",  stackInput: ["a", "...", "h"], stackInputSize: 8,  stackOutput: ["h", "...", "a"], stackOutputSize: 8,  gas: "3" },
  0x97: { description: "Exchange 1st and 9th stack items",  stackInput: ["a", "...", "i"], stackInputSize: 9,  stackOutput: ["i", "...", "a"], stackOutputSize: 9,  gas: "3" },
  0x98: { description: "Exchange 1st and 10th stack items", stackInput: ["a", "...", "j"], stackInputSize: 10, stackOutput: ["j", "...", "a"], stackOutputSize: 10, gas: "3" },
  0x99: { description: "Exchange 1st and 11th stack items", stackInput: ["a", "...", "k"], stackInputSize: 11, stackOutput: ["k", "...", "a"], stackOutputSize: 11, gas: "3" },
  0x9a: { description: "Exchange 1st and 12th stack items", stackInput: ["a", "...", "l"], stackInputSize: 12, stackOutput: ["l", "...", "a"], stackOutputSize: 12, gas: "3" },
  0x9b: { description: "Exchange 1st and 13th stack items", stackInput: ["a", "...", "m"], stackInputSize: 13, stackOutput: ["m", "...", "a"], stackOutputSize: 13, gas: "3" },
  0x9c: { description: "Exchange 1st and 14th stack items", stackInput: ["a", "...", "n"], stackInputSize: 14, stackOutput: ["n", "...", "a"], stackOutputSize: 14, gas: "3" },
  0x9d: { description: "Exchange 1st and 15th stack items", stackInput: ["a", "...", "o"], stackInputSize: 15, stackOutput: ["o", "...", "a"], stackOutputSize: 15, gas: "3" },
  0x9e: { description: "Exchange 1st and 16th stack items", stackInput: ["a", "...", "p"], stackInputSize: 16, stackOutput: ["p", "...", "a"], stackOutputSize: 16, gas: "3" },
  0x9f: { description: "Exchange 1st and 17th stack items", stackInput: ["a", "...", "q"], stackInputSize: 17, stackOutput: ["q", "...", "a"], stackOutputSize: 17, gas: "3" },

  // ── Logging ──
  0xa0: { description: "Append log record with no topics", stackInput: ["offset", "size"], stackOutput: [], memoryEffect: "Reads memory[offset:offset+size]", gas: "375+", memoryAccess: [{ offsetParam: "offset", sizeParam: "size" }] },
  0xa1: { description: "Append log record with 1 topic", stackInput: ["offset", "size", "topic1"], stackOutput: [], memoryEffect: "Reads memory[offset:offset+size]", gas: "750+", memoryAccess: [{ offsetParam: "offset", sizeParam: "size" }] },
  0xa2: { description: "Append log record with 2 topics", stackInput: ["offset", "size", "topic1", "topic2"], stackOutput: [], memoryEffect: "Reads memory[offset:offset+size]", gas: "1125+", memoryAccess: [{ offsetParam: "offset", sizeParam: "size" }] },
  0xa3: { description: "Append log record with 3 topics", stackInput: ["offset", "size", "topic1", "topic2", "topic3"], stackOutput: [], memoryEffect: "Reads memory[offset:offset+size]", gas: "1500+", memoryAccess: [{ offsetParam: "offset", sizeParam: "size" }] },
  0xa4: { description: "Append log record with 4 topics", stackInput: ["offset", "size", "topic1", "topic2", "topic3", "topic4"], stackOutput: [], memoryEffect: "Reads memory[offset:offset+size]", gas: "1875+", memoryAccess: [{ offsetParam: "offset", sizeParam: "size" }] },

  // ── EOF Stack Operations (EIP-663) ──
  0xe6: { description: "Duplicate the Nth stack item where N is given by an immediate byte (EOF EIP-663)", stackInput: ["..."], stackOutput: ["value", "..."], gas: "3" },
  0xe7: { description: "Swap the top stack item with the Nth item where N is given by an immediate byte (EOF EIP-663)", stackInput: ["a", "...", "b"], stackOutput: ["b", "...", "a"], gas: "3" },
  0xe8: { description: "Exchange two stack items at positions given by an immediate byte (EOF EIP-663)", stackInput: ["..."], stackOutput: ["..."], gas: "3" },

  // ── System Operations ──
  0xf0: { description: "Create a new contract (address derived from sender nonce)", stackInput: ["value", "offset", "size"], stackOutput: ["address"], memoryEffect: "Reads memory[offset:offset+size] as init code", gas: "32000+", memoryAccess: [{ offsetParam: "offset", sizeParam: "size" }] },
  0xf1: { description: "Call into an external account (can send ETH)", stackInput: ["gas", "addr", "value", "argsOffset", "argsSize", "retOffset", "retSize"], stackOutput: ["success"], memoryEffect: "Writes return data to memory[retOffset:retOffset+retSize]", gas: "100+", memoryAccess: [{ offsetParam: "argsOffset", sizeParam: "argsSize" }, { offsetParam: "retOffset", sizeParam: "retSize" }] },
  0xf2: { description: "Call with current account's code but target's storage (deprecated)", stackInput: ["gas", "addr", "value", "argsOffset", "argsSize", "retOffset", "retSize"], stackOutput: ["success"], gas: "100+", memoryAccess: [{ offsetParam: "argsOffset", sizeParam: "argsSize" }, { offsetParam: "retOffset", sizeParam: "retSize" }] },
  0xf3: { description: "Halt execution and return output data", stackInput: ["offset", "size"], stackOutput: [], memoryEffect: "Returns memory[offset:offset+size]", gas: "0", memoryAccess: [{ offsetParam: "offset", sizeParam: "size" }] },
  0xf4: { description: "Delegate call: execute target's code in the current account's context (storage, sender, value)", stackInput: ["gas", "addr", "argsOffset", "argsSize", "retOffset", "retSize"], stackOutput: ["success"], memoryEffect: "Writes return data to memory[retOffset:retOffset+retSize]", gas: "100+", memoryAccess: [{ offsetParam: "argsOffset", sizeParam: "argsSize" }, { offsetParam: "retOffset", sizeParam: "retSize" }] },
  0xf5: { description: "Create a new contract with a deterministic address derived from salt", stackInput: ["value", "offset", "size", "salt"], stackOutput: ["address"], memoryEffect: "Reads memory[offset:offset+size] as init code", gas: "32000+", memoryAccess: [{ offsetParam: "offset", sizeParam: "size" }] },
  0xfa: { description: "Static call: read-only call that cannot modify state", stackInput: ["gas", "addr", "argsOffset", "argsSize", "retOffset", "retSize"], stackOutput: ["success"], memoryEffect: "Writes return data to memory[retOffset:retOffset+retSize]", gas: "100+", memoryAccess: [{ offsetParam: "argsOffset", sizeParam: "argsSize" }, { offsetParam: "retOffset", sizeParam: "retSize" }] },
  0xfd: { description: "Revert: revert all state changes and return error data", stackInput: ["offset", "size"], stackOutput: [], memoryEffect: "Returns memory[offset:offset+size]", gas: "0", memoryAccess: [{ offsetParam: "offset", sizeParam: "size" }] },
  0xfe: { description: "Invalid instruction: consume all remaining gas and revert", stackInput: [], stackOutput: [], gas: "all" },
  0xff: { description: "Self-destruct: send all ETH to address and mark contract for deletion (deprecated)", stackInput: ["address"], stackOutput: [], gas: "5000+" },
};


export function getOpInfo(op: number): OpInfo {
  const info = OP_MAP[op];
  if (info) return info;

  // 常见无效 opcode 可以特殊处理
  if (op === 0xfe) {
    return { name: "REVERT (legacy)", category: "stop" };  // 一些旧合约用 0xfe
  }

  return { name: `UNKNOWN(0x${op.toString(16)})`, category: "invalid" };
}

export function disassemble(bytecode: Uint8Array): Opcode[] {
  let effectiveLength = bytecode.length;

  // 检测 Solidity compiler metadata：末尾 2 字节标记 CBOR 长度
  let metadataStart = -1;
  if (bytecode.length > 4) {
    const cborLen = (bytecode[bytecode.length - 2] << 8) | bytecode[bytecode.length - 1];
    const start = bytecode.length - 2 - cborLen;
    // 验证：起始位置合法、长度合理、起始字节是 CBOR map 前缀 (0xa0-0xbf)
    if (start >= 0 && cborLen > 0 && cborLen < 512 && (bytecode[start] & 0xe0) === 0xa0) {
      // 进一步验证第一个 CBOR key 是已知的 Solidity metadata key
      // "ipfs" = 64697066735822, "bzzr" = 627a7a72, "solc" = 736f6c63
      const b = bytecode;
      const s = start + 1; // 跳过 map 头
      const isIpfs = s + 5 < bytecode.length && b[s] === 0x64 && b[s+1] === 0x69 && b[s+2] === 0x70 && b[s+3] === 0x66 && b[s+4] === 0x73;
      const isBzzr = s + 5 < bytecode.length && b[s] === 0x65 && b[s+1] === 0x62 && b[s+2] === 0x7a && b[s+3] === 0x7a && b[s+4] === 0x72;
      const isSolc = s + 4 < bytecode.length && b[s] === 0x64 && b[s+1] === 0x73 && b[s+2] === 0x6f && b[s+3] === 0x6c && b[s+4] === 0x63;
      if (isIpfs || isBzzr || isSolc) {
        metadataStart = start;
        effectiveLength = metadataStart;
      }
    }
  }

  const instructions: Opcode[] = [];
  let pc = 0;

  while (pc < effectiveLength) {
    const op = bytecode[pc];
    const opInfo = getOpInfo(op);
    const startPc = pc;

    let instr: Opcode = {
      pc: startPc,
      name: opInfo.name,
      category: opInfo.category,
    };

    if (op >= 0x60 && op <= 0x7f) {
      const pushSize = op - 0x5f;
      const remaining = effectiveLength - (pc + 1);
      const actualSize = Math.min(pushSize, remaining);

      if (actualSize < pushSize) {
        instr.warning = `Truncated PUSH${pushSize} (only ${actualSize} bytes)`;
      }

      const data = bytecode.slice(pc + 1, pc + 1 + actualSize);
      if (data.length > 0) {
        instr.data = bytesToHex(data);
      }

      pc += 1 + pushSize;
    } else {
      pc += 1;
    }

    instructions.push(instr);
  }

  // 如果检测到 metadata，在末尾加一条总结
  if (metadataStart !== -1) {
    instructions.push({
      pc: metadataStart,
      name: "METADATA (Solidity Compiler Info)",
      category: "metadata",
      warning: "CBOR-encoded metadata & IPFS hash (unreachable in execution)",
      data: bytesToHex(bytecode.subarray(metadataStart)),
      isMetadata: true,
    });
  }

  return instructions;
}