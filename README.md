<p align="center">
  <h1 align="center">OpTrace</h1>
  <p align="center">
    High-performance EVM Transaction Step Debugger
  </p>
</p>

<p align="center">
  <a href="README.zh.md">中文文档</a>
</p>

<video src="https://github.com/user-attachments/assets/67993f1e-5729-4845-ba4a-3e32e0d1c097" 
       width="100%" muted autoplay loop playsinline controls muted>
</video>


## What is OpTrace?

OpTrace is a **native desktop EVM step debugger** built with Tauri 2 + React 19 + Rust. It replays any Ethereum transaction opcode-by-opcode, letting you inspect the full execution state at every step — stack, memory, storage, logs, call tree, and more.

Unlike browser-based debuggers, OpTrace uses a **Rust backend** that runs the EVM locally via [revm](https://github.com/bluealloy/revm), streams trace data through a compact **binary protocol**, and performs parallel condition scanning with [Rayon](https://github.com/rayon-rs/rayon) — handling **700k+ step** transactions without breaking a sweat.

### Key Features

#### Transaction Replay & Navigation

- **Fetch any transaction** by hash from configurable RPC endpoints
- **Step-by-step playback** with full keyboard shortcuts:
  | Shortcut | Action |
  |----------|--------|
  | j     | Move Forward |
  | k     | Move Back |
  | Space | Continue  |
- **Progress bar** with drag-to-seek (100ms debounce) and direct step-number input
- **Adjustable speed**: 1×–100× playback via slider
- **Navigation history**: Back/Forward buttons track your last 10 tab + step changes

#### Inspection Panels

| Panel | Description |
|-------|-------------|
| **Opcode Viewer** | Disassembled bytecode with current PC highlight, gas cost per instruction, executed-opcode highlighting (green), breakpoint markers. Supports quick-filter by opcode category (CALL, LOG, STORAGE, MEMORY, JUMP, REVERT, etc). Virtual scrolling for 10k+ lines. |
| **Stack Viewer** | Full 256-bit stack in reverse order (top-first) with depth index. Auto-highlights memory-related positions on MLOAD/MSTORE. Virtual scrolling. |
| **Memory Viewer** | 32 bytes/row hex + ASCII display. Mouse-drag byte selection (blue highlight), right-click copy, jump-to-offset input. Highlights MLOAD/MSTORE accessed ranges. Virtual scrolling for 1MB+ memory. |
| **Storage Viewer** | Grouped by contract address. Shows both persistent storage and **transient storage** (EIP-1153). Displays Key → Old Value → New Value. Click a slot to see its full modification history across the transaction. Slot annotation system for Solidity types (uint256, address, mapping, struct, packed). |
| **Logs (Events)** | All LOG0–LOG4 from the current frame. Auto-decodes event signatures via local 4byte db + Sourcify API. Click to jump to the emitting opcode. |
| **Return Data** | RETURN/REVERT data display in raw hex or 32-byte chunked mode. |
| **State Diff** | Global state changes after the transaction (final snapshot, not per-frame). |
| **Call Tree** | Hierarchical view of all internal calls. Each node shows call type, target address, caller, gas used, success/reverted status. Click a node to jump to its first step. |
| **Block Info** | Block number, timestamp, gas limit, base fee — fields are editable for fork mode. |
| **Tx Info** | Hash, from, to, value, gas price, gas limit, calldata, success/reverted badge. |

#### Conditional Breakpoints (7 Types)

| Type | Trigger |
|------|---------|
| **SSTORE slot** | Write to a specific storage slot |
| **SLOAD slot** | Read from a specific storage slot |
| **CALL address** | CALL/STATICCALL/DELEGATECALL to a specific address |
| **Call selector** | Calldata first 4 bytes match a specific function selector |
| **LOG topic** | LOG1–LOG4 with matching topic[0] |
| **Contract address** | Any step executing inside a specific contract (bytecode_address) |
| **Target address** | Any step in a frame whose CALL target matches a specific address |

**Condition tree**: Combine conditions with AND/OR logic (max 3 leaves, 1 nesting level). Multiple root nodes are OR'd together.

**Scan**: One click scans the entire transaction in parallel (Rayon) and lists all matching steps. Click any hit to jump there.

**Auto-scan**: Automatically runs a full scan when debugging finishes.

#### PC Breakpoints & Bookmarks

- Double-click any opcode line to toggle a breakpoint
- Add labels to breakpoints for annotation
- Bookmarks panel lists all breakpoints with quick-jump
- **Break on opcode type**: toolbar dropdown to break on any CALL/RETURN/REVERT/etc

#### Fork Mode ("What-If")

1. Pause at any step during debugging
2. Edit stack or memory values
3. Click "Fork" → opens a **new window** that re-executes the transaction with your patches
4. Compare modified execution vs original
5. Supports recursive forking (fork a fork)

#### Integrated Utilities Drawer

| Tool | Description |
|------|-------------|
| **Base Converter** | Decimal ↔ Hex ↔ Binary |
| **Gwei Converter** | Wei ↔ Gwei ↔ Ether |
| **Keccak256** | Hash any input |
| **4Byte Lookup** | Reverse-lookup function/event signatures |
| **Checksum Address** | EIP-55 address checksum |
| **ABI Decoder** | Decode function calldata or event logs |
| **Slot Calculator** | Compute Solidity mapping/array storage slot |
| **Timestamp Converter** | Unix ↔ human-readable date |

#### JavaScript Analysis Sandbox

Write and run custom JS scripts to analyze the full execution trace:

```js
// Available globals:
// trace / steps — all StepData[]
// getMemory(stepIndex) — compute memory at a step
// readMemory(step, offset, size) — read memory slice
// hexToNumber(hex) — hex string to number

// Example: find top 10 gas-consuming steps
const sorted = steps.sort((a, b) => b.gasCost - a.gasCost);
return sorted.slice(0, 10).map(s => `Step ${s.index}: ${s.opName} cost=${s.gasCost}`);
```

Runs in a sandboxed Rust thread (QuickJS) — won't block the UI.

#### Bytecode Test Tool

Paste raw hex bytecode → instant disassembly with PC, opcode name, and PUSH immediate data.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend (React 19 + TypeScript + Tailwind + shadcn/ui)     │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐   │
│  │ Zustand  │ │ Virtual  │ │ Monaco   │ │ Binary Message │   │
│  │ Store    │ │ Scroll   │ │ Editor   │ │ Decoder        │   │
│  └─────────┘ └──────────┘ └──────────┘ └────────────────┘   │
├──────────────────── Tauri IPC ───────────────────────────────┤
│  Backend (Rust + revm + Rayon + Alloy)                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ EVM      │ │ Inspector│ │ Binary   │ │ Parallel Scan  │  │
│  │ Runner   │ │ (revm)   │ │ Encoder  │ │ (Rayon)        │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │
│  ┌──────────┐ ┌──────────┐                                   │
│  │ Debug    │ │ Alloy    │                                   │
│  │ Session  │ │ RPC      │                                   │
│  └──────────┘ └──────────┘                                   │
└──────────────────────────────────────────────────────────────┘
```

**Binary Protocol**: 8 message types (StepBatch, ContractSource, Logs, StorageChange, FrameEnter/Exit, ReturnData, Finished) — ~60% smaller than JSON, streamed in real-time during execution.

**Seek**: `seek_to` IPC reconstructs full stack + memory at any step via incremental memory snapshots (every 50 steps) + patches. O(log N) per frame.

### Performance

- **700k+ steps** — streamed progressively, no full-load wait
- **Binary protocol** — ~60% smaller than JSON encoding
- **Rayon parallel scan** — condition scanning across all CPU cores
- **Virtual scrolling** — all lists (opcode, stack, memory, storage, logs) use @tanstack/react-virtual
- **Incremental memory** — snapshots every 50 steps + patches, not full copies
- **Dev profile O2** — Rust dependencies compiled at O2 optimization even in dev mode

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Tauri 2 |
| Frontend | React 19, TypeScript 5.8, Vite 7 |
| Styling | Tailwind CSS 3, shadcn/ui, Radix UI |
| State | Zustand 5 |
| Code Editor | Monaco Editor |
| Virtual Scroll | @tanstack/react-virtual 3 |
| EVM | Revm 36 |
| RPC Client | Alloy |
| Parallel | Rayon |
| Ethereum Utils | Viem 2 |
| Decompile | Heimdall-rs |

### Getting Started

#### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Tauri 2 prerequisites: see [Tauri docs](https://v2.tauri.app/start/prerequisites/)

#### Install & Run

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev

# Build for production
pnpm tauri build
```

#### Usage

1. Select a chain and RPC endpoint from the top bar
2. Paste a transaction hash and click **Fetch**
3. Review the Tx Info and Block Info panels
4. Click **Debug** to start the EVM replay
5. Use playback controls (or keyboard shortcuts) to step through execution
6. Inspect stack, memory, storage, logs at each step
7. Set conditional breakpoints and scan for matching steps
8. Use Fork mode to test "what-if" scenarios

## Sponsorship

If this tool has been helpful to you, feel free to buy me a coffee.
got liquidated on-chain, currently grinding to pay off debts .

EVM Address: `0xCa6D18615e4EB3Fa58ceB0155234E0F6b3A5e312`

---

## License

MIT
