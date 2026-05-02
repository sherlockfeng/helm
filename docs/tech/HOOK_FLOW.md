# Cursor Hook 数据流

> Phase 0 占位。完整内容在 Phase 3 实装 `src/host/cursor/normalize.ts` 时同步补齐。

## 数据流总览

```
Cursor IDE
  ↓ spawns
helm-hook 子进程  ← 每次 hook event 一个新进程
  ↓ stdin: hook payload JSON
host/cursor/normalize.ts
  ↓ HostEvent (统一格式)
bridge/client.ts
  ↓ UDS request
helm Electron main
  ↓ bridge/server.ts → handler 路由
处理结果
  ↓ JSON response
helm-hook
  ↓ stdout: hook response JSON
Cursor IDE
```

## 当前 Cursor 支持的 hooks

详见 [PROJECT_BLUEPRINT.md §8](../../PROJECT_BLUEPRINT.md)。MVP-1 安装：

- `sessionStart`
- `beforeSubmitPrompt`
- `afterAgentResponse`
- `postToolUse` / `postToolUseFailure` / `afterShellExecution`
- `stop`（loop_limit: null）
- `beforeShellExecution` / `beforeMCPExecution` / `preToolUse`（带 matcher）

## 字段映射表

待 Phase 3 补齐：每个 Cursor hook event 的 payload schema → HostEvent 字段映射，逐字段说明。

## Fallback 策略

bridge 不可达时（Phase 3 实装）：

| Event | Fallback 输出 |
|---|---|
| `beforeSubmitPrompt` | `{ continue: true }` |
| `stop` / `afterAgentResponse` | `{}` |
| `beforeShellExecution` / `beforeMCPExecution` / `preToolUse` | `{ permission: "ask", user_message: "Helm bridge not running" }` |

详见蓝图 §22.1。
