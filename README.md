# OpTrace

OpTrace is a high-performance, open-source EVM Debugger for deep-dive Ethereum transaction replaying, state inspection, advanced condition scanning, and what-if fork debugging.

<video src="https://github.com/user-attachments/assets/ac723ff6-48c3-4bc6-a0bf-c3f86588c89d"
       width="100%" muted autoplay loop playsinline controls>
</video>

[中文文档](README.zh.md)

## Feature Overview

### 1) Transaction Replay and Navigation
- Load and replay execution by transaction hash
- Step, continue, drag timeline, and jump to specific step
- Playback speed control and back/forward navigation

### 2) Execution State Inspection
- Opcode view: current PC highlight, breakpoints, category filters
- Stack view: depth and values
- Memory view: hex/ASCII, range selection, copy
- Storage view: persistent and transient storage changes
- Logs view: event browsing and step jump
- Return Data / State Diff views

### 3) Call Context and Structure
- Call Tree for internal call hierarchy
- Jump from call nodes to corresponding steps
- Switch by transaction/frame context

### 4) Condition Scan
- Multiple condition types (storage access, call address, selector, log topic, etc.)
- AND/OR condition composition
- One-click full scan with hit list and quick jump
- Optional scan scope by transaction

### 5) Breakpoints and Marks
- Opcode line breakpoints with labels
- Hit list and fast positioning
- Pause by opcode type

### 6) Fork Debugging
- Modify stack/memory at any step and fork execution
- Replay patched execution in a separate window
- Compare what-if paths against original run

### 7) Analysis and Utilities
- Analysis: run scripts against trace data
- Utilities: hash, 4byte, ABI, slot, and conversion tools
- Bytecode tool: quick disassembly and inspection

### 8) CFG View
- Build and render control flow graph
- Highlight blocks/edges by execution sequence
- Zoom, pan, center, and step-linked navigation

## Install & Run

```bash
pnpm install
pnpm tauri dev
```

## Sponsorship

If OpTrace helps your workflow, sponsorship is appreciated.

EVM Address: `0xCa6D18615e4EB3Fa58ceB0155234E0F6b3A5e312`

## Third-Party Licenses

See `THIRD_PARTY_LICENSES.md`.

## License

MIT. See `LICENSE`.
