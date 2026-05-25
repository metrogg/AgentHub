# AgentHub

> 多 Agent 协作平台 —— 字节跳动 AI 全栈挑战赛参赛作品

AgentHub 是一个 IM 式多 Agent 协作平台，用户可以单独与 AI Agent 对话，也可以通过 `@orchestrator` 协调多个 Agent（架构师、实现者、审查者等）共同完成复杂任务。

## 核心特性

- **单聊（Direct）**：与单个 Agent 一对一对话，支持 LLM / Code Agent / 原生工具三种运行时
- **群聊（Group）**：Workspace 级别的 Agent Group，支持 `@Agent名` 指定回复对象
- **Orchestrator 调度**：通过 `@orchestrator` 自动拆解任务，生成 DAG 执行计划，按依赖层级并发调度（最多 3 个并行），失败自动重试/降级
- **Git 分支隔离**：每个非 read-only Agent 任务自动切出独立分支 `agenthub/{runId}/{agentKey}/{taskId}`，执行完毕后提取 diff，支持多 Agent 冲突检测与 LLM 3-way merge
- **LLM 智能聚合**：替代字符串拼接，调用 LLM 整合各 Agent 产出，消除重复、标注贡献者、指出风险
- **代码 Agent 即开即用**：Codex / Claude Code / OpenCode CLI 适配，默认启用，沙箱策略分级控制

## 技术栈

| 层面 | 技术选型 |
|------|---------|
| 运行时 | Bun >= 1.1.0 |
| Monorepo | Bun workspaces |
| 后端 | Hono + Bun.serve（HTTP + WebSocket 同一端口） |
| 前端 | React 18 + Vite + Tailwind CSS + Zustand + Radix UI |
| 数据库 | SQLite（bun:sqlite）+ Drizzle ORM（WAL 模式） |
| LLM | 自研流式客户端（OpenAI-compatible + Anthropic） |
| 共享 | Zod schemas + constants（packages/shared） |

## 快速开始

```bash
# 安装依赖
bun install

# 复制环境变量
 cp .env.example .env

# 启动数据库迁移
bun run db:migrate

# 同时启动服务端和前端（开发模式）
bun run dev

# 服务端: http://localhost:8000
# 前端: http://localhost:5173
```

## 常用命令

```bash
# 单独启动
bun run dev:server    # :8000，带 --watch
bun run dev:web       # Vite dev server :5173

# 构建
bun run build

# 类型检查
bun run typecheck

# 测试
bun test

# 数据库
bun run db:generate   # 生成 Drizzle 迁移
bun run db:migrate    # 执行迁移
bun run db:studio     # 打开 Drizzle Studio
```

## 项目结构

```
├── apps/
│   ├── server/          # Hono REST API + WebSocket 服务端
│   │   ├── src/
│   │   │   ├── index.ts              # 入口：种子默认用户、启动 Bun.serve
│   │   │   ├── app.ts                # Hono 应用：CORS、错误处理、路由挂载
│   │   │   ├── routes/               # API 路由
│   │   │   │   ├── sessions.ts
│   │   │   │   ├── messages.ts       # 核心：消息、编排计划、派发
│   │   │   │   ├── workspaces.ts     # 核心：Workspace、Agent、任务
│   │   │   │   ├── coding-tools.ts   # Codex / Claude Code / OpenCode 适配
│   │   │   │   └── ...
│   │   │   └── services/             # 业务逻辑层
│   │   │       ├── agent-runner.ts           # Agent 回复总调度
│   │   │       ├── runtime/                  # Agent Runtime 统一适配层
│   │   │       │   ├── agent-runtime.ts      # 统一接口
│   │   │       │   ├── runtime-registry.ts   # 注册中心
│   │   │       │   ├── llm-runtime.ts        # LLM 对话
│   │   │       │   ├── code-agent-runtime.ts # Code Agent CLI
│   │   │       │   └── native-tool-runtime.ts# 原生只读工具
│   │   │       ├── orchestrator/             # Orchestrator 引擎
│   │   │       │   ├── orchestrator-engine.ts# 总控引擎
│   │   │       │   ├── planner.ts            # Task DAG 生成
│   │   │       │   ├── task-scheduler.ts     # 并发调度
│   │   │       │   ├── task-graph.ts         # DAG 拓扑排序
│   │   │       │   ├── synthesizer.ts        # LLM 智能聚合
│   │   │       │   ├── conflict-resolver.ts  # 代码冲突检测
│   │   │       │   ├── fallback-engine.ts    # 失败降级
│   │   │       │   └── types.ts
│   │   │       ├── git/                      # Git 分支隔离
│   │   │       │   └── branch-manager.ts
│   │   │       └── ...
│   └── web/             # React SPA（Vite 构建）
│       └── src/
│           ├── pages/              # 页面级组件
│           ├── components/         # 业务组件
│           ├── stores/             # Zustand 状态
│           └── lib/                # API 客户端 + WebSocket
├── packages/
│   ├── db/              # Drizzle ORM 数据库层
│   │   ├── src/schema.ts         # 全量表定义
│   │   └── drizzle/              # 迁移文件
│   └── shared/          # 前后端共享 Zod schemas
├── tests/
│   └── smoke.test.ts    # 冒烟测试
├── docs/                # 产品设计/技术设计文档
└── README.md
```

## 架构亮点

### 四层架构

```
API / Routes (Hono)
    ↓
Orchestrator Engine（DAG 调度、并发控制、失败降级、冲突解决、LLM 聚合）
    ↓
Agent Runtime（统一接口：LLM / Code Agent / Native Tool）
    ↓
Infrastructure（LLM Client、Tool Registry、Git Branch Manager）
```

### Git 分支隔离

每个非 read-only Agent 任务执行前：
1. `git stash` 保护用户当前工作区
2. `git checkout -b agenthub/{runId}/{agentKey}/{taskId} main`
3. Agent 在分支上执行代码变更
4. 执行完毕后 `git diff main...branch` 提取变更作为 artifact
5. 冲突检测：`git merge` 多个 Agent 分支到临时分支
6. 用户确认后合并到 main，或丢弃分支

### 沙箱策略

| 策略 | 行为 |
|------|------|
| `read-only` | 不切分支，Agent 只读取文件 |
| `workspace-write` | 切独立 Git 分支，执行后提取 diff |
| `danger-full-access` | 同样走分支隔离，允许更多操作 |

## 测试

```bash
bun test
```

覆盖场景：
- 健康检查、会话/消息 CRUD
- 模型连接测试
- Workspace 任务派发与失败降级
- Agent 草案确认
- TaskGraph DAG 拓扑排序与环检测
- ConflictResolver 多 Agent 文件冲突检测
- GitBranchManager 分支生命周期

## 环境变量

复制 `.env.example` 为 `.env` 后按需填写：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | SQLite 文件路径 | `./storage/agenthub.db` |
| `PORT` | 服务端端口 | `8000` |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 通用 LLM 配置 | - |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | 供应商专用 Key | - |
| `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION` | Code Agent 执行开关 | `true` |
| `ENABLE_LOCAL_CLI_PROBES` | 探测本机 CLI 工具 | `true` |

## 开发约定

- **模块系统**：全项目 ESM
- **格式化**：Prettier（`semi: false`, `singleQuote: true`, `trailingComma: "all"`）
- **TypeScript**：`strict: true`, `isolatedModules: true`
- **注释**：中文为主，关键类型保留英文命名

## 比赛信息

- **赛事**：字节跳动 AI 全栈挑战赛
- **赛道**：多 Agent 协作平台
- **截止时间**：2026 年 6 月 10 日

## License

MIT
