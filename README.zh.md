# OpTrace

OpTrace 是一款高性能、开源的 EVM 调试器，专注于深度以太坊交易重放、状态检查、高级条件扫描以及“假想（What-if）”分支调试。

<video src="https://github.com/user-attachments/assets/ac723ff6-48c3-4bc6-a0bf-c3f86588c89d"
       width="100%" muted autoplay loop playsinline controls>
</video>

[English](README.md)

## 功能概览

### 1) 交易回放与导航
- 按交易哈希加载并回放执行过程
- 支持单步、连续播放、拖动进度和指定步号跳转
- 支持播放速度调节与前进/后退导航

### 2) 执行状态查看
- Opcode 视图：当前 PC 高亮、断点标记、分类过滤
- Stack 视图：栈深与值展示
- Memory 视图：Hex/ASCII、区间查看与复制
- Storage 视图：持久存储与瞬态存储变更
- Logs 视图：事件日志浏览与定位
- Return Data / State Diff：返回数据与状态变化查看

### 3) 调用关系与上下文
- Call Tree：按调用层级展示内部调用关系
- 支持从调用节点快速跳转到对应步骤
- 支持按交易与帧上下文切换查看

### 4) 条件扫描（Scan）
- 支持多类条件（如存储读写、调用地址、选择器、日志主题等）
- 支持 AND/OR 条件组合
- 一键全量扫描命中步骤并快速跳转
- 支持按交易范围过滤扫描

### 5) 断点与标记
- 支持 opcode 行断点与标签
- 支持命中列表与快速定位
- 支持按操作码类型触发暂停

### 6) Fork 分支调试
- 在任意步骤修改栈/内存后开启分支执行
- 新窗口独立重放修改后的执行路径
- 便于做“假设变更”对比验证

### 7) 分析与工具
- Analysis：运行脚本分析 trace 数据
- Utilities：常用链上/编码转换工具（哈希、4byte、ABI、slot 等）
- Bytecode 工具：字节码反汇编与快速检查

### 8) CFG 视图
- 构建并展示控制流图
- 支持按执行序列联动高亮块与边
- 支持缩放、平移、居中与步进联动查看

## 安装与运行

```bash
pnpm install
pnpm tauri dev
```

## Sponsorship

如果 OpTrace 对你有帮助，欢迎赞助支持。

EVM 地址：`0xCa6D18615e4EB3Fa58ceB0155234E0F6b3A5e312`

## 第三方许可证

详见 `THIRD_PARTY_LICENSES.md`。

## 许可证

MIT，详见 `LICENSE`。
