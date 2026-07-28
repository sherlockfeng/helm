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

## hook 命令的解释器

host 配置（`~/.cursor/hooks.json` / `~/.claude/settings.json`）里的命令形如：

```
'<HELM_HOME>/bin/helm-hook-node' '<repo>/bin/helm-hook.mjs' --event 'stop'
```

第一段是 helm 生成的 sh 启动器，不是 node 的绝对路径。它在**运行时**解析 node
（env override → 缓存 → PATH → 版本管理器/系统目录 → 登录 shell），所以：

- 终端启动的 host（PATH 在）和 GUI 启动的 host（没有用户 PATH）都能跑
- 用户升级 / 删除 / 切换 node 后配置不会烂，也不需要重装
- 找不到任何 node 时输出中性响应并 exit 0，只往
  `$HELM_HOME/logs/hook-launcher.log` 记一行，绝不打断 host

历史背景与完整解析顺序见 [PROJECT_BLUEPRINT.md §7.2.1](../../PROJECT_BLUEPRINT.md)
和 `src/host/hook-launcher.ts` 的模块注释。

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
