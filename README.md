# Helm

> macOS 桌面 app — Cursor IDE 的本机 chat 管家。

Helm 在 menubar 常驻，通过 Cursor public hooks 旁观所有 chat 的生命周期，提供：

- **远程协作通道** — 把当前 chat 镜像到 Lark thread，离开电脑后用手机继续对话和审批
- **本地审批护栏** — 拦截 Cursor 高风险工具（Shell / Write / MCP），桌面 + Lark 双通道审批
- **知识 / 需求沉淀** — 主动把对话沉淀为可复用的角色知识 / 需求记忆
- **多 Agent 工作流** — campaign → cycle → product/dev/test 任务模型 + doc-first 强制审计
- **MCP server** — stdio 端口暴露，供 Cursor / Claude Code / 其他 MCP client 调用
- **外部知识源** — `KnowledgeProvider` 抽象，可接入 depscope、内部 wiki、SDK 文档站等

## 状态

**Phase 0 — 仓库骨架**。设计阶段完成，运行时实现进行中。

详细设计：[PROJECT_BLUEPRINT.md](./PROJECT_BLUEPRINT.md)
当前进度：[PROGRESS.md](./PROGRESS.md)
AI agent 协作约定：[AGENTS.md](./AGENTS.md)

## 开发

```bash
pnpm install

# 后端 watch 模式
pnpm dev:backend

# Renderer dev server
pnpm dev:web

# 启动 Electron（dev，需要先把 backend build 一次）
HELM_DEV=1 pnpm dev:electron

# 完整 build
pnpm build

# 打包 macOS DMG
pnpm package

# 测试
pnpm test           # 单元 + 集成（vitest）
pnpm test:e2e       # 端到端（Playwright，强制要求；详见 AGENTS.md）
pnpm typecheck
```

## 项目布局

```
electron/    Electron 主进程 + preload
src/         业务逻辑（bridge / host adapter / channel / workflow / mcp / ...）
web/         React renderer (Vite)
bin/         CLI 入口（helm / helm-hook）
tests/       Vitest 单元 + Playwright e2e
docs/        架构、role 描述、hook 数据流
```

## 与前身项目的关系

Helm 合并自：

- [`agent2lark-cursor`](https://github.com/sherlockfeng/agent2lark-cursor) — 飞书 ↔ Cursor 中继 + 远程审批
- [`relay`](https://github.com/sherlockfeng/relay) — MCP 多 Agent 编排

老项目仓库归档为只读 reference。Helm 不读老项目的运行时数据；如需保留请用户自行复制。

## License

TBD（Phase 0 暂未确定，倾向 MIT）。
