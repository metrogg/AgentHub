# AgentHub

> 本文档供 AI Coding Agent 阅读。如果你是人类开发者，请优先参考 `CLAUDE.md` 和 `docs/` 目录下的产品设计/技术设计文档。

## 项目概述

AgentHub 是一个**多 Agent 协作平台**（IM 式群聊交互），用户可以单独与 AI Agent 对话，也可以通过 `@orchestrator` 协调多个 Agent（架构师、实现者、审查者等）共同完成任务。项目为**字节跳动 AI 全栈挑战赛**参赛作品。

核心交互范式：

- **单聊（Direct）**：用户与一个 Agent 一对一对话。
- **群聊（Group）**：Workspace 级别的 Agent Group，支持 `@Agent名` 指定回复对象。
- **协调器（Orchestrator）**：通过 `@orchestrator` 触发任务拆解，自动创建 Workspace、分配 Agent、分发子任务，支持 DAG 依赖调度、并发执行、失败降级和代码冲突处理。

## 技术栈

| 层面       | 技术选型                                                       |
| -------- | ---------------------------------------------------------- |
| 运行时      | Bun >= 1.1.0                                               |
| Monorepo | Bun workspaces (`apps/*`, `packages/*`)                    |
| 后端框架     | Hono + Bun.serve（HTTP + WebSocket 同一端口）                    |
| 前端框架     | React 18 + Vite + TypeScript                               |
| UI / CSS | Tailwind CSS + Radix UI primitives + `@assistant-ui/react` |
| 状态管理     | Zustand                                                    |
| 数据库      | SQLite (`bun:sqlite`) + Drizzle ORM（WAL 模式）                |
| LLM 接入   | 自研流式客户端（OpenAI-compatible + Anthropic）                     |
| 共享契约     | Zod schemas + 常量（`packages/shared`）                        |
| 包管理器     | Bun（`bun.lock`）                                            |

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
│   │   │       ├── llm.ts                 # 薄封装
│   │   │       ├── runtime/               # Agent Runtime 统一适配层（新）
│   │   │       │   ├── agent-runtime.ts   # 统一接口定义
│   │   │       │   ├── runtime-registry.ts# Runtime 注册中心
│   │   │       │   ├── llm-runtime.ts     # LLM 对话 Runtime
│   │   │       │   ├── native-tool-runtime.ts # 原生只读工具 Runtime
│   │   │       │   ├── code-agent-runtime.ts  # Code Agent Runtime
│   │   │       │   └── index.ts
│   │   │       ├── orchestrator/          # Orchestrator 引擎（新）
│   │   │       │   ├── orchestrator-engine.ts # 总控引擎
│   │   │       │   ├── planner.ts         # Task DAG 生成器
│   │   │       │   ├── task-scheduler.ts  # 并发调度引擎
│   │   │       │   ├── task-graph.ts      # DAG 工具类
│   │   │       │   ├── synthesizer.ts     # LLM 智能聚合
│   │   │       │   ├── conflict-resolver.ts # 代码冲突检测与解决
│   │   │       │   ├── fallback-engine.ts # 失败降级引擎
│   │   │       │   ├── types.ts           # 共享类型定义
│   │   │       │   └── index.ts
│   │   │       ├── git/                   # Git 分支隔离（新）
│   │   │       │   └── branch-manager.ts  # 分支生命周期管理
│   │   │       ├── code-agent-adapter.ts  # 代码 Agent CLI 适配（保留，被 CodeAgentRuntime 引用）
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
│   │   │   │                       # workspace_tasks 已扩展 DAG 字段
│   │   │   │                       # 新增 orchestrator_runs 表
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
  - `session_members` / `settings`
  - `orchestrator_runs`（新增：记录 Orchestrator 调度生命周期）
- **workspace\_tasks 扩展字段**（支持 DAG 调度）：
  - `run_id`, `dependencies` (JSON), `parallel_group`, `max_retries`, `attempt_count`
  - `fallback_agent_id`, `artifacts` (JSON), `started_at`, `completed_at`, `error_log`
- **特性**：启用 `PRAGMA journal_mode = WAL;` 与 `PRAGMA foreign_keys = ON;`。
- **连接逻辑**：`packages/db/src/index.ts` 会根据 `PROJECT_ROOT` 锚定数据库文件位置，确保在 monorepo 任意目录启动都能找到同一数据库。

## 环境变量

复制 `.env.example` 为 `.env` 后按需填写。关键变量：

| 变量                                                             | 说明                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `DATABASE_URL`                                                 | SQLite 文件路径，默认 `./storage/agenthub.db`                    |
| `PORT`                                                         | 服务端端口，默认 `8000`                                           |
| `JWT_SECRET`                                                   | JWT 密钥（开发环境有默认值，生产必须修改）                                   |
| `CORS_ORIGIN`                                                  | 前端地址，默认 `http://localhost:5173`                           |
| `LLM_PROVIDER`                                                 | 默认 LLM 供应商，默认 `openai`                                    |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`                   | 通用 LLM 配置                                                 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`          | OpenAI 专用                                                 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` | Anthropic 专用                                              |
| `ENABLE_LOCAL_CLI_PROBES`                                      | 是否探测本机 CLI 工具（codex/claude/opencode），默认 `true`            |
| `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION`                         | 代码 Agent 执行总开关，默认 `true`；实际限制由 Agent 的 `sandboxPolicy` 控制 |
| `AGENTHUB_CODE_AGENT_TIMEOUT_MS`                               | 代码 Agent 超时，默认 `120000`                                   |

服务端优先从数据库 `settings` 表读取模型配置，其次回退到环境变量。

## 测试

- **框架**：`bun:test`（内置）。
- **入口**：`tests/smoke.test.ts`。
- **策略**：
  - 使用临时目录创建独立 SQLite 数据库，避免污染开发数据。
  - 默认用户通过 `beforeAll` 种子写入。
  - 外部 LLM 调用通过 `globalThis.fetch` mock 拦截。
  - 覆盖场景：健康检查、会话/消息 CRUD、模型连接测试、Workspace 任务派发、Artifact Demo、Agent 草案确认、任务失败降级等。
- **运行**：`bun test`。

## 安全与运行策略

- **鉴权**：当前为单用户模式（`src/middleware/auth.ts`），所有请求注入 `DEFAULT_USER`，无真实登录流程。
- **API Key 保护**：`llm-client.ts` 中 `redactSensitive` 会脱敏日志中的 Bearer Token、`sk-*`、`sess-*` 等。
- **代码 Agent 沙箱**：
  - Agent 具备三级沙箱策略：`read-only` / `workspace-write` / `danger-full-access`。
  - `read-only`：不切 Git 分支，Agent 只读取文件。
  - `workspace-write`：为每个 Agent 任务创建独立 Git 分支 `agenthub/{runId}/{agentKey}/{taskId}`，Agent 在分支上自由 commit，执行完毕后提取 diff。
  - `danger-full-access`：同样走分支隔离，但允许更多操作（如修改 `.gitignore`、删除文件等）。
  - `mcp` 运行时强制只读。
- **隔离架构**：策略层（sandboxPolicy）→ Git 分支层（Branch-per-Agent）→ OS 层（Codex/Claude Code 自带 Seatbelt/seccomp/Landlock）。
- **CORS**：动态解析允许来源，开发环境自动放行 `localhost:5173`。

## 日志与错误规范

### 统一错误响应

后端所有 API 错误返回统一格式：

```json
{
  "success": false,
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "会话不存在",
    "details": { ... },
    "requestId": "uuid"
  }
}
```

- `code`：机器可识别的错误码（`AppErrorCode`），方便前端分类处理。
- `message`：面向用户的中文可读消息。
- `details`：可选的调试上下文（开发环境可能包含 stack）。
- `requestId`：请求追踪 ID，用于全链路定位问题。

### 错误码体系

错误码定义于 `apps/server/src/lib/error.ts` 的 `AppErrorCodes`，按领域分组：

| 前缀               | 说明       | 示例                                                    |
| ---------------- | -------- | ----------------------------------------------------- |
| `GENERAL_*`      | 通用服务器错误  | `INTERNAL_ERROR`, `TIMEOUT`                           |
| `VALIDATION_*`   | 请求参数校验   | `VALIDATION_FAILED`, `MISSING_FIELD`                  |
| `AUTH_*`         | 认证授权（预留） | `UNAUTHORIZED`, `FORBIDDEN`                           |
| `SESSION_*`      | 会话       | `SESSION_NOT_FOUND`, `SESSION_CREATE_FAILED`          |
| `MESSAGE_*`      | 消息       | `MESSAGE_NOT_FOUND`, `MESSAGE_UPDATE_FAILED`          |
| `WORKSPACE_*`    | 工作区      | `WORKSPACE_NOT_FOUND`, `WORKSPACE_CREATE_FAILED`      |
| `TASK_*`         | 任务       | `TASK_NOT_FOUND`, `TASK_EXECUTION_FAILED`             |
| `AGENT_*`        | Agent    | `AGENT_NOT_FOUND`, `CODE_AGENT_EXECUTION_FAILED`      |
| `LLM_*`          | LLM 服务   | `LLM_REQUEST_FAILED`, `LLM_RATE_LIMITED`              |
| `ORCHESTRATOR_*` | 编排器      | `ORCHESTRATOR_PLAN_FAILED`, `ORCHESTRATOR_RUN_FAILED` |
| `FILE_*`         | 文件/产物    | `FILE_NOT_FOUND`, `DIFF_APPLY_FAILED`                 |

### 路由中使用 AppError

**禁止**在新增路由中继续使用裸 `HTTPException`。应使用 `AppError`：

```typescript
import { AppError, AppErrorCodes } from '../lib/error'

// 资源不存在
throw AppError.fromCode(AppErrorCodes.SESSION_NOT_FOUND, '会话不存在')

// 参数校验失败（带详情）
throw AppError.fromCode(AppErrorCodes.VALIDATION_FAILED, '参数错误', { field: 'title' })

// 内部错误
throw AppError.internal(AppErrorCodes.LLM_REQUEST_FAILED, 'LLM 请求失败', { provider: 'openai' })
```

已有的 `HTTPException` 在 `messages.ts` / `workspaces.ts` 已作为示例完成迁移，其余路由保持兼容（`app.ts` 的 `onError` 会自动包装为 `AppError`）。

### 请求追踪（requestId）

`requestContextMiddleware` 为每个 HTTP 请求注入：

1. **生成** **`requestId`**：优先读取请求头 `X-Request-Id`（支持分布式追踪），否则 `crypto.randomUUID()`。
2. **绑定 child logger**：通过 `c.get('requestContext').logger` 获取带 `requestId` 的 logger，日志自动关联请求。
3. **响应头回写**：`X-Request-Id` 随响应返回给前端，方便用户报障时定位。

路由中使用：

```typescript
const { requestId, logger } = c.get('requestContext')
logger.info({ taskId }, 'Task started')
```

### 日志级别规范

| 级别      | 使用场景                        |
| ------- | --------------------------- |
| `fatal` | 进程即将崩溃，无法恢复                 |
| `error` | 业务错误、未捕获异常、外部服务彻底失败         |
| `warn`  | 可恢复的错误、降级、重试、客户端错误（4xx）     |
| `info`  | 关键业务事件（请求完成、任务开始/结束、计划生成）   |
| `debug` | 调试信息（WebSocket 消息、工具调用入参出参） |

**禁止**使用 `console.log` / `console.error`（启动阶段 fallback 除外）。统一使用 `apps/server/src/lib/logger.ts` 导出的 pino logger。

## 核心架构说明

### Agent Runtime 统一适配层

所有 Agent 执行通过 `AgentRuntime` 接口统一：

```typescript
interface AgentRuntime {
  readonly runtimeType: string
  execute(ctx: ExecutionContext): AsyncGenerator<AgentOutputChunk>
}
```

- `LlmRuntime`：直接 LLM 对话
- `CodeAgentRuntime`：调用 Codex / Claude Code / OpenCode CLI
- `NativeToolRuntime`：LLM + 只读工具循环（OpenAI function calling / Anthropic tool\_use）

注册中心 `RuntimeRegistry` 根据 `profile.runtimeType` 自动路由。

### Orchestrator Engine

```
IntentClassifier（可选）→ Planner → TaskScheduler → Synthesizer
                                    ↓
                              FallbackEngine
                                    ↓
                              ConflictResolver
```

- **Planner**：调用 LLM 生成 Task DAG（带依赖关系），失败则回退到固定模板（Architect → Coder → Reviewer）。
- **TaskScheduler**：DAG 分层执行，同层任务并发（默认 max 3），支持超时检测。
- **Synthesizer**：LLM 智能聚合各 Agent 产出，消除重复、标注贡献者、指出风险。
- **ConflictResolver**：收集各 Agent 分支的 diff，尝试自动合并；冲突时调用 LLM 做 3-way merge。
- **FallbackEngine**：任务失败时支持重试、降级到 fallback Agent、Orchestrator 接管。

### Git 分支隔离

每个非 read-only Agent 任务执行前：

1. `git stash` 保护用户当前工作区
2. `git checkout -b agenthub/{runId}/{agentKey}/{taskId} main`
3. Agent 在分支上执行代码变更（Claude Code / Codex 会自动 commit）
4. 执行完毕后 `git diff main...branch` 提取变更作为 artifact
5. 冲突检测：`git merge` 多个 Agent 分支到临时分支
6. 用户确认后 `git merge --squash` 合并到 main，或丢弃分支

## 开发约定

- **新增路由**：在 `apps/server/src/routes/` 创建 Hono Router，然后在 `apps/server/src/app.ts` 中通过 `.route('/api/xxx', xxxRoutes)` 挂载。
- **新增数据库表**：在 `packages/db/src/schema.ts` 中定义，使用 `sqliteTable` + `relations`，然后执行 `bun run db:generate`。
- **前后端共享类型**：在 `packages/shared/src/schemas/` 中新增 Zod schema，并在 `packages/shared/src/index.ts` 导出。
- **前端新增页面**：在 `apps/web/src/pages/` 创建组件，在 `apps/web/src/App.tsx` 中添加 `<Route>`。
- **WebSocket 事件**：服务端通过 `broadcastSessionEvent` 发送，前端在 `chatStore.handleWSEvent` 中消费。常用事件类型定义于 `packages/shared/src/constants.ts` 的 `WsEvent`。新增事件：`task:update`。
- **Agent 回复流**：服务端 `agent-runner.ts` 中的 `runAgentReply` 负责调度；LLM 流式输出通过 `message:stream` 事件推送到前端，完成后写入数据库并发送 `message:completed`。

