# Helm 架构

> 本文是 [PROJECT_BLUEPRINT.md](../PROJECT_BLUEPRINT.md) 的快速索引。蓝图是真相源；本文只用于快速 onboard。

## 三层抽象

```
┌──────────────────────────────────────────────────────────────┐
│  HostAdapter           谁产生 chat 事件流？                    │
│  └─ CursorHostAdapter (MVP-1)                                │
│  └─ ClaudeCodeHostAdapter (Phase 2)                          │
├──────────────────────────────────────────────────────────────┤
│  RemoteChannel         事件 / 审批镜像到哪个远程通道？           │
│  └─ LocalChannel       (本机通知 + UI，永远启用)               │
│  └─ LarkChannel        (飞书，opt-in)                         │
│  └─ Phase 2: Slack / Telegram / ...                          │
├──────────────────────────────────────────────────────────────┤
│  KnowledgeProvider     给 chat 注入什么外部知识 context？        │
│  └─ LocalRolesProvider (内置)                                 │
│  └─ DepscopeProvider   (reference, opt-in)                   │
│  └─ Phase 2: Wiki / SDK doc / ...                            │
└──────────────────────────────────────────────────────────────┘
```

详细接口见蓝图 §10 / §11 / §11.5。

## 数据流（3 个核心场景）

### 场景 1：Cursor chat 中用户输入到 Agent 回复

```
beforeSubmitPrompt hook
  → bridge → app 主进程 → 命令检查 / 心跳启动 → continue:true 给 Cursor
                                                          ↓
                                              Cursor 调 LLM 流式回复
                                                          ↓
afterAgentResponse hook → bridge → 写到 host_event_log + 镜像到 channel
```

### 场景 2：Cursor 工具拦截审批

```
beforeShellExecution / beforeMCPExecution / preToolUse hook
  → bridge → ApprovalRegistry 创建 pending → 并发推到所有 RemoteChannel
                                                          ↓
                                  LocalChannel：UI 弹窗 + macOS 通知
                                  LarkChannel：发飞书 markdown / card
                                                          ↓
                                  谁先决策谁定夺 → settle pending
                                                          ↓
hook 返回 {permission: 'allow' | 'deny' | 'ask'}
```

### 场景 3：飞书消息注入 chat

```
Lark 用户发消息 → lark-cli event +subscribe（adapter spawn 的子进程）
                            ↓
                    LarkChannel 解析 → bridge → channel_message_queue 入队
                                                          ↓
Cursor stop hook  ← 长轮询消费队列 → followup_message 注入下一条 user prompt
```

## 进程模型

桌面 app 启动后只有 1 个长期 Node 进程（Electron 主进程）：

- bridge UDS server
- HTTP API on 127.0.0.1
- MCP stdio server（每个 Cursor 连接一个 fork）
- HostAdapter / RemoteChannel / KnowledgeProvider 注册中心
- Renderer（BrowserWindow）

按需 spawn 的子进程：

- Cursor hook 子进程（每次 hook 一个，短命）
- lark-cli event +subscribe（启用 Lark 时常驻）

详见蓝图 §7。

## 数据持久化

唯一真相源：`~/.helm/data.db`（SQLite + WAL）

不存在的：

- 没有云
- 没有外部 message broker
- 没有跨进程共享内存

详细 schema 见蓝图 §9。

## 进一步阅读

- [HOOK_FLOW.md](./tech/HOOK_FLOW.md) — Cursor hook event → bridge wire 的逐字段映射
- [蓝图 §11.5](../PROJECT_BLUEPRINT.md) — KnowledgeProvider 全貌
- [蓝图 §17.4](../PROJECT_BLUEPRINT.md) — e2e 流程清单
