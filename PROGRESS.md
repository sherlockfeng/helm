# Helm — 进度记录

## 当前阶段

**Phase 0：仓库骨架（进行中，已暂停）**

设计阶段已完成，骨架文件创建被用户中断。

## 已完成

- ✅ 项目命名（`helm`）
- ✅ 设计讨论（架构、技术栈、范围、抽象层）
- ✅ `PROJECT_BLUEPRINT.md` 完整草稿（24 节 + 三处增补）
  - 含 MVP-1/2/3 + Phase 2 路线图
  - 增补 §11.5 KnowledgeProvider 抽象（depscope 等外部知识源接入）
  - 增补 §11.6 RelayBackend 抽象（Phase 2 mobile/PWA 通道，可复用 depscope server）
  - 增补 §17.4 e2e 测试套件（用户级强制要求，攻击性视角）
  - 增补 §19.5 日志与 Diagnostics（用户级强制要求，便于反馈问题）
  - 增补 Phase 7.5 / 13 / 14 / 15 实现顺序条目
- ✅ Git 仓库 init（`/Users/bytedance/projects/helm`，main 分支）
- ✅ 目录骨架（electron / src / web / bin / tests / docs，含子目录）
- ✅ `package.json`（含 dependencies、scripts、bin 入口）

## 待补充（Phase 0 剩余）

- [ ] `pnpm-workspace.yaml`
- [ ] `.gitignore` / `.npmrc`
- [ ] `tsconfig.json` / `tsconfig.base.json`
- [ ] `tsup.config.ts`
- [ ] `vitest.config.ts`
- [ ] `electron-builder.config.cjs`
- [ ] `electron/main.ts` / `preload.ts`（最小 stub）
- [ ] `src/constants.ts` / `config.ts`（stub）
- [ ] `bin/helm.mjs` / `bin/helm-hook.mjs`（stub）
- [ ] `web/package.json` / `vite.config.ts` / `index.html` / `src/main.tsx` / `App.tsx`
- [ ] `README.md`
- [ ] `AGENTS.md`
- [ ] `docs/ARCHITECTURE.md` / `ROADMAP.md` / `roles/*.md`

## 用户后续追加的强制要求（须写进 AGENTS.md / 测试策略）

1. **每个用户流程必须有 e2e 测试** —— 攻击性测试视角，不是乐观路径
2. **详细 log** —— 用户反馈问题时能有完整上下文（每个模块独立 logger、按 session 归档、敏感信息 redact）
3. **UI 设计与测试由独立 subagent 承担**
   - UI agent 身份：资深 Mac app 设计与交互专家
   - 测试 agent 身份：资深测试，攻击性视角，不做乐观假设

## 设计关键决定（来自讨论）

| 项 | 决定 | 备注 |
|---|---|---|
| 桌面壳子 | Electron | Tauri 评估后否决（Node 代码复用价值高） |
| 手机端 | 一期不做 | Lark adapter 兜底；二期 PWA + Cloudflare Tunnel |
| Lark | adapter 化 | 默认不开，Settings 中启用 |
| 远程通道 | RemoteChannel 抽象 | LocalChannel 必启，LarkChannel 可选 |
| 宿主 | HostAdapter 抽象 | 一期 Cursor，预留 Claude Code |
| 数据源 | 单 SQLite | `~/.helm/data.db` |
| MCP | 保留并扩展 | 复用 relay 的 tool 签名，新增 `get_active_chats` / `bind_to_remote_channel` |
| Hook 定位 | 强制护栏 + 自动化触发器 | doc-first 强制、远程审批不可绕过 |
| 知识沉淀 | 用户主动触发 | 不自动识别意图 |
| 老项目兼容 | 不兼容、不迁移 | 复制代码作为起点，TS 化，不读 `~/.agent2lark/`、`~/.relay/` |
| IPC | localhost HTTP + WebSocket | renderer 复用 relay/web 的 useApi；二期 PWA 切换无成本 |
| 测试栈 | Vitest + Playwright | 单元 + e2e，e2e 攻击性视角 |
| Electron 体积 | 接受 ~200MB | 不为体积重写 |
| 外部知识源 | KnowledgeProvider 抽象 | LocalRolesProvider（内置）+ DepscopeProvider（reference）；可扩展 wiki / 内部 SDK 文档站 |
| 手机端通道 | RelayBackend 抽象（Phase 2） | DepscopeRelay（内部零配置）/ CloudflareTunnelRelay（开源默认）/ TailscaleRelay |
| depscope 集成 | 部署层复用，概念层隔离 | depscope 进程内可加 /relay/* 路由用于 Phase 2，但与现有 ServiceSpec/分析逻辑互不耦合 |

## 待决定（Open Questions）

- [ ] 一期是否拆 daemon / UI（推荐：不拆，二期做 PWA 时自然演化）
- [ ] DMG 是否签名 / 公证（建议至少 ad-hoc sign）
- [ ] 一期是否就支持 Claude Code（推荐：不做，预留接口）

## 下一步

恢复 Phase 0 时按 `PROJECT_BLUEPRINT.md` §21 顺序补齐剩余骨架文件，然后进 Phase 1（数据层）。

---

最后更新：2026-05-02
