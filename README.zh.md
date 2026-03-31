<p align="center">
  <h1 align="center">OpTrace</h1>
  <p align="center">
    高性能 EVM 交易逐步调试器
  </p>
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

<video src="https://github.com/user-attachments/assets/67993f1e-5729-4845-ba4a-3e32e0d1c097" 
       width="100%" muted autoplay loop playsinline controls muted>
</video>


## 什么是 OpTrace？

OpTrace 是一个**原生桌面 EVM 逐步调试器**，基于 Tauri 2 + React 19 + Rust 构建。它可以逐 opcode 重放任意以太坊交易，让你在每一步检查完整的执行状态 —— 栈、内存、存储、日志、调用树等。

不同于浏览器端调试工具，OpTrace 使用 **Rust 后端**通过 [revm](https://github.com/bluealloy/revm) 在本地执行 EVM，通过紧凑的**二进制协议**流式传输 trace 数据，并利用 [Rayon](https://github.com/rayon-rs/rayon) 进行并行条件扫描 —— 轻松处理 **70 万步以上**的复杂交易。

## 核心功能

### 交易回放 & 导航

- **获取任意交易**：输入哈希，从可配置的 RPC 端点获取
- **逐步播放**，支持完整快捷键：
  | 快捷键 | 操作 |
  |--------|------|
  | k    | 前进一步 |
  | j    | 回退一步 |
  | 空格  | 继续执行 |
- **进度条**：拖动快速跳转（100ms 防抖），支持直接输入步数
- **可调速度**：1×–100× 播放倍速滑块
- **历史导航**：前进/后退按钮记录最近 10 次 tab + 步骤变更

### 检查面板

| 面板 | 说明 |
|------|------|
| **Opcode 查看器** | 反汇编字节码，当前 PC 高亮，每条指令的 gas 消耗，已执行 opcode 绿色标记，断点标记。支持按类别快速过滤（CALL、LOG、STORAGE、MEMORY、JUMP、REVERT 等）。虚拟滚动支持 1 万+ 行。 |
| **栈查看器** | 完整 256 位栈值，逆序显示（栈顶在上），带深度索引。MLOAD/MSTORE 时自动高亮相关内存位置。虚拟滚动。 |
| **内存查看器** | 每行 32 字节，十六进制 + ASCII 显示。鼠标拖拽选择字节范围（蓝色高亮），右键复制，跳转到指定偏移量。高亮 MLOAD/MSTORE 访问区域。虚拟滚动支持 1MB+ 内存。 |
| **存储查看器** | 按合约地址分组。同时显示持久存储和**临时存储**（EIP-1153）。展示 Key → 旧值 → 新值。点击槽位查看该交易中的完整修改历史。支持 Solidity 类型槽位注解（uint256、address、mapping、struct、packed）。 |
| **日志（事件）** | 当前帧的所有 LOG0–LOG4。通过本地 4byte 数据库 + Sourcify API 自动解码事件签名。点击跳转到产生日志的 opcode。 |
| **返回数据** | RETURN/REVERT 数据，支持原始十六进制和 32 字节分块两种显示模式。 |
| **状态差异** | 交易执行后的全局状态变更（最终快照，非逐帧存储）。 |
| **调用树** | 所有内部调用的层级视图。每个节点显示调用类型、目标地址、调用者、gas 消耗、成功/回退状态。点击节点跳转到对应的第一步。 |
| **区块信息** | 区块号、时间戳、Gas Limit、Base Fee —— 字段可编辑（用于 fork 模式）。 |
| **交易信息** | 哈希、From、To、Value、Gas Price、Gas Limit、Calldata、成功/回退徽章。 |

### 条件断点（7 种类型）

| 类型 | 触发时机 |
|------|---------|
| **SSTORE slot** | 写入指定存储槽时 |
| **SLOAD slot** | 读取指定存储槽时 |
| **CALL address** | 对指定地址发起 CALL/STATICCALL/DELEGATECALL 时 |
| **Call selector** | Calldata 前 4 字节匹配指定函数选择器时 |
| **LOG topic** | LOG1–LOG4 且 topic[0] 匹配时 |
| **Contract address** | 在指定合约内执行任意步骤时（bytecode_address） |
| **Target address** | 所在帧的 CALL 目标地址匹配时 |

**条件树**：支持 AND/OR 组合逻辑（最多 3 个叶子、1 层嵌套）。多个根节点之间为 OR 关系。

**扫描**：一键并行扫描整个交易（Rayon），列出所有匹配步骤，点击直接跳转。

**自动扫描**：调试结束后自动执行完整扫描。

### PC 断点 & 书签

- 单击 opcode 行切换断点
- 支持为断点添加标签注释
- 书签面板列出所有断点并支持快速跳转
- **按 opcode 类型中断**：工具栏下拉菜单选择（CALL/RETURN/REVERT 等）

### Fork 模式（"What-If"假设分析）

1. 调试过程中暂停在任意步骤
2. 编辑栈或内存值
3. 点击 "Fork" → 在**新窗口**中以修改后的参数重新执行交易
4. 对比修改后的执行与原始执行
5. 支持递归 fork（在 fork 结果上再 fork）

### 集成工具箱

| 工具 | 说明 |
|------|------|
| **进制转换** | 十进制 ↔ 十六进制 ↔ 二进制 |
| **Gwei 转换** | Wei ↔ Gwei ↔ Ether |
| **Keccak256** | 哈希计算 |
| **4Byte 查询** | 反向查询函数/事件签名 |
| **校验和地址** | EIP-55 地址校验和计算 |
| **ABI 解码** | 解码函数 calldata 或事件日志 |
| **Slot 计算** | 计算 Solidity mapping/array 存储槽位 |
| **时间戳转换** | Unix 时间戳 ↔ 可读日期 |

### JavaScript 分析沙盒

编写并运行自定义 JS 脚本分析完整执行 trace：

```js
// 可用全局变量：
// trace / steps — 全部 StepData 数组
// getMemory(stepIndex) — 计算指定步骤的内存
// readMemory(step, offset, size) — 读取内存片段
// hexToNumber(hex) — 十六进制字符串转数字

// 示例：找到 gas 消耗最高的 10 步
const sorted = steps.sort((a, b) => b.gasCost - a.gasCost);
return sorted.slice(0, 10).map(s => `Step ${s.index}: ${s.opName} cost=${s.gasCost}`);
```

在沙盒化的 Rust 线程中运行（QuickJS 引擎），不会阻塞 UI。

### 字节码测试工具

粘贴原始十六进制字节码 → 即时反汇编，显示 PC、opcode 名称和 PUSH 立即数。

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  前端 (React 19 + TypeScript + Tailwind + shadcn/ui)         │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐   │
│  │ Zustand  │ │ 虚拟滚动 │ │ Monaco   │ │ 二进制消息     │   │
│  │ 状态管理 │ │          │ │ 编辑器   │ │ 解码器         │   │
│  └─────────┘ └──────────┘ └──────────┘ └────────────────┘   │
├──────────────────── Tauri IPC ───────────────────────────────┤
│  后端 (Rust + revm + Rayon + Alloy)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ EVM      │ │Inspector │ │ 二进制   │ │ 并行扫描       │  │
│  │ 执行引擎 │ │ (revm)   │ │ 编码器   │ │ (Rayon)        │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────────┘  │
│  ┌──────────┐ ┌──────────┐                                   │
│  │ 调试会话 │ │ Alloy    │                                   │
│  │          │ │ RPC 客户端│                                   │
│  └──────────┘ └──────────┘                                   │
└──────────────────────────────────────────────────────────────┘
```

**二进制协议**：8 种消息类型（StepBatch、ContractSource、Logs、StorageChange、FrameEnter/Exit、ReturnData、Finished）—— 比 JSON 小约 60%，执行过程中实时流式传输。

**Seek**：`seek_to` IPC 通过增量内存快照（每 50 步一次）+ 补丁重建任意步骤的完整栈 + 内存。每帧 O(log N) 复杂度。

## 性能特点

- **70 万步以上** —— 渐进式流式传输，无需等待全量加载
- **二进制协议** —— 比 JSON 编码小约 60%
- **Rayon 并行扫描** —— 条件扫描利用所有 CPU 核心
- **虚拟滚动** —— 所有列表（opcode、栈、内存、存储、日志）均使用 @tanstack/react-virtual
- **增量内存** —— 每 50 步快照 + 补丁，非完整复制
- **Dev 模式 O2 优化** —— Rust 依赖即使在开发模式下也以 O2 优化级别编译

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2 |
| 前端 | React 19、TypeScript 5.8、Vite 7 |
| 样式 | Tailwind CSS 3、shadcn/ui、Radix UI |
| 状态管理 | Zustand 5 |
| 代码编辑器 | Monaco Editor |
| 虚拟滚动 | @tanstack/react-virtual 3 |
| EVM 引擎 | revm 36 |
| RPC 客户端 | Alloy |
| 并行计算 | Rayon |
| 以太坊工具 | Viem 2 |
| 反编译 | Heimdall-rs |

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install)（stable）
- Tauri 2 前置依赖：参见 [Tauri 文档](https://v2.tauri.app/start/prerequisites/)

### 安装与运行

```bash
# 安装依赖
pnpm install

# 开发模式运行
pnpm tauri dev

# 构建生产版本
pnpm tauri build
```

### 使用方法

1. 从顶部栏选择链和 RPC 端点
2. 粘贴交易哈希，点击 **Fetch（获取）**
3. 查看交易信息和区块信息面板
4. 点击 **Debug（调试）** 启动 EVM 重放
5. 使用播放控件（或键盘快捷键）逐步执行
6. 在每一步检查栈、内存、存储、日志
7. 设置条件断点并扫描匹配的步骤
8. 使用 Fork 模式测试 "what-if" 假设场景

## 赞助

如果这个工具给你带来了帮助，可以考虑给点赞助支持一下。
合约爆仓，努力还债中.

EVM 地址：`0xCa6D18615e4EB3Fa58ceB0155234E0F6b3A5e312`

---

## License

MIT
