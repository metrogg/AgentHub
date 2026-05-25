# AgentHub

> 本文档供 AI Coding Agent 阅读。如果你是人类开发者，请优先参考 `CLAUDE.md` 和 `docs/` 目录下的产品设计/技术设计文档。

## 项目概述

AgentHub 是一个**多 Agent 协作平台**（IM 式群聊交互），用户可以单独与 AI Agent 对话，也可以通过 `@orchestrator` 协调多个 Agent（架构师、实现者、审查者等）共同完成任务。项目为**字节跳动 AI 全栈挑战赛**参赛作品。

核心交互范式：
- **单聊（Direct）**：用户与一个 Agent 一对一对话。
- **群聊（Group）**：Workspace 级别的 Agent Group，支持 `@Agent名` 指定回复对象。
- **协调器（Orchestrator）**：通过 `@orchestrator` 触发任务拆解，自动创建 Workspace、分配 Agent、分发子任务。

## 技术栈

| 层面 | 技术选型 |
|------|---------|
| 运行时 | Bun >= 1.1.0 |
|  Monorepo | Bun workspaces (`apps/*`, `packages/*`) |
| 后端框架 | Hono + Bun.serve（HTTP + WebSocket 同一端口） |
| 前端框架 | React 18 + Vite + TypeScript |
| UI / CSS | Tailwind CSS + Radix UI primitives + `@assistant-ui/react` |
| 状态管理 | Zustand |
| 数据库 | SQLite (`bun:sqlite`) + Drizzle ORM（WAL 模式） |
| LLM 接入 | 自研流式客户端（OpenAI-compatible + Anthropic）+ Mastra (`@mastra/core`) |
| 共享契约 | Zod schemas + 常量（`packages/shared`） |
| 包管理器 | Bun（`bun.lock`） |

## 项目结构

```
├── apps/
│   ├── server/          # Hono REST API + WebSocket 服务端
│   │   ├── src/
│   │   │   ├── index.ts           # 入口：种子默认用户、启动 Bun.serve
│   │   │   ├── app.ts             # Hono 应用：CORS、错误处理、路由挂载
│   │   │   ├── env.ts             # Zod 校验的环境变量配置
│   │   │   ├── middleware/auth.ts # 单用户模式（无鉴权，注入默认用户）
│   │   │   ├── routes/            # API 路由（Hono sub-routers）
│   │   │   │   ├── sessions.ts
│   │   │   │   ├── messages.ts    # 核心：消息、编排计划、Agent 草案、产物演示
│   │   │   │   ├── workspaces.ts  # 核心：Workspace、Agent、任务、派发、汇总
│   │   │   │   ├── settings.ts
│   │   │   │   ├── coding-tools.ts# Codex / Claude Code / OpenCode 适配
│   │   │   │   ├── skills.ts
│   │   │   │   └── artifacts.ts
│   │   │   └── services/          # 业务逻辑层
│   │   │       ├── agent-runner.ts        # WebSocket 房间管理 + Agent 回复流
│   │   │       ├── llm-client.ts          # 多供应商 LLM 流式客户端
│   │   │       ├── llm.ts                 # 薄封装（被 agent-runner 调用）
│   │   │       ├── code-agent-adapter.ts  # 代码 Agent（codex/claude-code/opencode）
│   │   │       ├── native-agent-loop.ts   # 原生 Agent 循环（mcp / a2a）
│   │   │       ├── tool-registry.ts
│   │   │       ├── skill-registry.ts
│   │   │       └── codex-auth.ts
│   │   └── package.json
│   └── web/             # React SPA（Vite 构建）
│       ├── index.html
│       ├── vite.config.ts         # 开发代理 /api -> :8000, /ws -> ws://:8000
│       ├── tailwind.config.js
│       └── src/
│           ├── main.tsx
│           ├── App.tsx            # React Router 路由定义
│           ├── pages/             # 页面级组件
│           ├── components/        # 业务组件
│           ├── stores/            # Zustand 状态（chatStore、workspaceStore）
│           └── lib/
│               ├── api.ts         # 前端 API 客户端（含类型定义）
│               └── ws.ts          # WebSocket 客户端（自动重连）
├── packages/
│   ├── db/              # Drizzle ORM 数据库层
│   │   ├── src/
│   │   │   ├── index.ts           # SQLite 连接（WAL + foreign_keys）
│   │   │   ├── schema.ts          # 全量表定义（users/sessions/messages/workspaces/...）
│   │   │   └── migrate.ts         # 迁移执行脚本
│   │   └── drizzle.config.ts
│   └── shared/          # 前后端共享的 Zod schemas 与常量
│       └── src/
│           ├── constants.ts
│           └── schemas/
├── tests/
│   └── smoke.test.ts    # 冒烟测试（bun:test）
├── package.json         # workspace 根配置
├── tsconfig.base.json   # 共享 TS 编译选项
├── bunfig.toml          # Bun 配置
└── .env.example         # 环境变量模板
```

## 常用命令

```bash
# 安装依赖
bun install

# 同时启动服务端和前端（推荐）
bun run dev

# 单独启动
bun run dev:server    # :8000，带 --watch
bun run dev:web       # Vite dev server :5173

# 构建
bun run build

# 类型检查
bun run typecheck

# 代码检查（lint）
bun run lint

# 测试
bun test

# 数据库操作
bun run db:generate   # 生成 Drizzle 迁移
bun run db:migrate    # 执行迁移
bun run db:studio     # 打开 Drizzle Studio

# 单包类型检查
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck
```

## 代码风格

- **模块系统**：全项目 ESM（`"type": "module"`）。
- **格式化**：Prettier，配置见 `.prettierrc`：
  - `semi: false`
  - `singleQuote: true`
  - `trailingComma: "all"`
  - `printWidth: 100`
  - `tabWidth: 2`
- **TypeScript**：继承 `tsconfig.base.json`，启用 `strict: true`、`isolatedModules: true`、`noUncheckedIndexedAccess: true`。
- **路径别名**：
  - 前端：`@` → `./src`（Vite 配置）。
  - 后端无别名，直接使用相对路径或 workspace 包名（如 `@agenthub/db`、`@agenthub/shared`）。
- **注释语言**：代码注释以中文为主，关键类型/接口保留英文命名。

## 数据库

- **引擎**：SQLite（`bun:sqlite`），默认路径 `./storage/agenthub.db`。
- **ORM**：Drizzle ORM (`0.36.0`)，使用 `drizzle-kit` 生成迁移。
- **关键表**：
  - `users` / `sessions`（`direct` | `group`）/ `messages`
  - `workspaces` / `workspace_agents` / `workspace_tasks`
  - `session_members` / `settings` / `tasks` / `agents`
- **特性**：启用 `PRAGMA journal_mode = WAL;` 与 `PRAGMA foreign_keys = ON;`。
- **连接逻辑**：`packages/db/src/index.ts` 会根据 `PROJECT_ROOT` 锚定数据库文件位置，确保在 monorepo 任意目录启动都能找到同一数据库。

## 环境变量

复制 `.env.example` 为 `.env` 后按需填写。关键变量：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | SQLite 文件路径，默认 `./storage/agenthub.db` |
| `PORT` | 服务端端口，默认 `8000` |
| `JWT_SECRET` | JWT 密钥（开发环境有默认值，生产必须修改） |
| `CORS_ORIGIN` | 前端地址，默认 `http://localhost:5173` |
| `LLM_PROVIDER` | 默认 LLM 供应商，默认 `openai` |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 通用 LLM 配置 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | OpenAI 专用 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` | Anthropic 专用 |
| `ENABLE_LOCAL_CLI_PROBES` | 是否探测本机 CLI 工具（codex/claude/opencode），默认 `true` |
| `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION` | 是否启用代码 Agent 实际执行，默认 `false` |
| `AGENTHUB_CODE_AGENT_TIMEOUT_MS` | 代码 Agent 超时，默认 `120000` |

服务端优先从数据库 `settings` 表读取模型配置，其次回退到环境变量。

## 测试

- **框架**：`bun:test`（内置）。
- **入口**：`tests/smoke.test.ts`。
- **策略**：
  - 使用临时目录创建独立 SQLite 数据库，避免污染开发数据。
  - 默认用户通过 `beforeAll` 种子写入。
  - 外部 LLM 调用通过 `globalThis.fetch` mock 拦截。
  - 覆盖场景：健康检查、会话/消息 CRUD、模型连接测试、Workspace 任务派发、Artifact Demo、Agent 草案确认等。
- **运行**：`bun test`。

## 安全与运行策略

- **鉴权**：当前为单用户模式（`src/middleware/auth.ts`），所有请求注入 `DEFAULT_USER`，无真实登录流程。
- **API Key 保护**：`llm-client.ts` 中 `redactSensitive` 会脱敏日志中的 Bearer Token、`sk-*`、`sess-*` 等。
- **代码 Agent 沙箱**：
  - 默认关闭实际执行（`AGENTHUB_ENABLE_CODE_AGENT_EXECUTION=false`）。
  - Agent 具备三级沙箱策略：`read-only` / `workspace-write` / `danger-full-access`。
  - `mcp` 运行时强制只读。
- **CORS**：动态解析允许来源，开发环境自动放行 `localhost:5173`。

## 开发约定

- **新增路由**：在 `apps/server/src/routes/` 创建 Hono Router，然后在 `apps/server/src/app.ts` 中通过 `.route('/api/xxx', xxxRoutes)` 挂载。
- **新增数据库表**：在 `packages/db/src/schema.ts` 中定义，使用 `sqliteTable` + `relations`，然后执行 `bun run db:generate`。
- **前后端共享类型**：在 `packages/shared/src/schemas/` 中新增 Zod schema，并在 `packages/shared/src/index.ts` 导出。
- **前端新增页面**：在 `apps/web/src/pages/` 创建组件，在 `apps/web/src/App.tsx` 中添加 `<Route>`。
- **WebSocket 事件**：服务端通过 `broadcastSessionEvent` 发送，前端在 `chatStore.handleWSEvent` 中消费。常用事件类型定义于 `packages/shared/src/constants.ts` 的 `WsEvent`。
- **Agent 回复流**：服务端 `agent-runner.ts` 中的 `runAgentReply` 负责调度；LLM 流式输出通过 `message:stream` 事件推送到前端，完成后写入数据库并发送 `message:completed`。
