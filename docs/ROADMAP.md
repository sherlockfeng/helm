# Helm Roadmap

详细 Phase 划分见 [PROJECT_BLUEPRINT.md §21](../PROJECT_BLUEPRINT.md)。

## 当前

| 阶段 | 状态 | 备注 |
|---|---|---|
| Phase 0 — 仓库骨架 | ✅ done | 蓝图、配置、stub 入口、AGENTS.md |
| Phase 1 — 数据层 | ⏳ next | SQLite schema + migration 框架 |

## MVP-1（本地闭环）

| Phase | 范围 | 估时 |
|---|---|---|
| 1 | SQLite schema + migrations | 1-2 天 |
| 2 | Bridge UDS server / client / protocol | 1 天 |
| 3 | Cursor HostAdapter (normalize / installer / hook-entry) | 2 天 |
| 4 | Approval 核心（registry / policy / scope-inference） | 2 天 |
| 5 | LocalChannel | 1 天 |
| 6 | MCP server（迁移 relay tool + 新增 query_knowledge / list_knowledge_providers / get_active_chats / bind_to_remote_channel） | 1-2 天 |
| 7 | Workflow / Roles / Requirements / Spawner / Summarizer（迁自 relay） | 2-3 天 |
| 7.5 | KnowledgeProvider 接口 + LocalRolesProvider | 1 天 |
| 8 | Electron 壳（main / menubar / 主窗口 / HTTP API） | 2-3 天 |
| 9 | Renderer（迁移 + 新页面 + 实时事件流） | 4-5 天 |

**累计 ~2-3 周**

## MVP-2（Lark 远程通道）

| Phase | 范围 | 估时 |
|---|---|---|
| 10 | LarkChannel adapter + 命令解析 + 绑定 UI | 2-3 天 |
| 11 | Lark 远程审批 + 消息注入 + progress relay | 2-3 天 |

## MVP-3（完整工作流 + reference KnowledgeProvider）

| Phase | 范围 | 估时 |
|---|---|---|
| 12 | campaign / cycle / task UI + doc-first 强制 + bug 回流 + summarize | 3-4 天 |
| 13 | DepscopeProvider reference 实现 | 1-2 天 |
| 14 | e2e 测试套件全量补齐 + CI 强制 | 贯穿 |
| 15 | logger 落地 + Diagnostics 导出包 | 1 天 |

**累计 ~7-9 周**

## Phase 2（不在 MVP 内）

- KnowledgeProvider v1.5 → v2 → v2.5 演进（filePath 切换 → `.helm-project` → 自动发现）
- RelayBackend 抽象 + DepscopeRelay / CloudflareTunnelRelay 实现
- PWA 移动端
- Web Push 推送
- Claude Code HostAdapter
- 知识 / 需求 bundle 团队共享
- 额外 RemoteChannel adapter（Slack / Telegram）
