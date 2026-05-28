# AgentHub 项目全景分析

> **版本**: v0.1.0 | **日期**: 2026-05-28 | **分支**: dev/wzd
> **定位**: 多 Agent 协作平台 — 字节 AI 全栈挑战赛参赛作品

---

## 目录

1. [项目总览](#1-项目总览)
2. [技术栈与架构](#2-技术栈与架构)
3. [模块详解](#3-模块详解)
4. [多 Agent 协作核心（重点）](#4-多-agent-协作核心重点)
5. [流程图与架构图](#5-流程图与架构图)
6. [现存问题诊断](#6-现存问题诊断)
7. [行业对标与开源案例](#7-行业对标与开源案例)
8. [重构与优化路线图](#8-重构与优化路线图)

---

## 1. 项目总览

### 1.1 一句话定位

AgentHub 是一个**本地优先的多 Agent 协作平台**，用户可以与 AI Agent 单独对话，也可以编排 Agent 团队（架构师、编码者、审查者、研究员）协同完成复杂任务。核心差异化在于 **DAG 编排引擎 + Git 分支隔离 + Blackboard 共享内存** 的三件套。

### 1.2 核心能力矩阵

| 能力 | 状态 | 说明 |
|------|------|------|
| 单 Agent 对话 | ✅ 成熟 | LLM 流式对话，支持多模型切换 |
| 多 Agent 编排 | ✅ 核心 | DAG 任务图 + 并发调度 + 自动审查 |
| Code Agent 执行 | ✅ 成熟 | Codex / Claude Code / OpenCode / Gemini CLI 适配 |
| Git 分支隔离 | ✅ 独特 | 每个 Agent 任务独立 worktree，冲突检测 + LLM 三路合并 |
| Blackboard 共享内存 | ✅ 成熟 | 带版本控制、类型化、命名空间隔离的 KV 存储 |
| Intent Router | ✅ 可用 | 启发式复杂度评估，自动路由到编排器 |
| 桌面应用 | ✅ 可用 | Tauri v2 + Rust 侧载 |
| 移动配对 | ✅ 可用 | Android 端配对码认证 |
| A2A 协议 | ❌ 未实现 | `runtimeType: 'a2a'` 已定义但无实现 |
| MCP 服务器 | ⚠️ 部分 | `NativeToolRuntime` 实现了 MCP runtime 类型，但非标准 MCP 协议 |

### 1.3 代码规模估算

```
apps/server/src/           ~15,000 行 TypeScript
  ├── routes/              ~4,500 行 (9 个路由模块)
  ├── services/            ~8,000 行 (核心业务逻辑)
  │   ├── orchestrator/    ~3,500 行 (15 个文件，编排引擎)
  │   ├── runtime/         ~1,500 行 (4 个 runtime 实现)
  │   ├── code-agent-adapter.ts  ~1,540 行 (最大单文件)
  │   └── ...其他服务
  └── middleware/           ~50 行
apps/web/src/              ~20,000 行 TypeScript/TSX
  ├── components/          ~8,000 行
  │   └── Thread.tsx       ~3,290 行 (最大单文件)
  ├── pages/               ~6,000 行
  ├── stores/              ~1,500 行
  └── lib/                 ~4,000 行
packages/db/               ~800 行 (15 张表，13 次迁移)
packages/shared/           ~500 行 (Zod schemas + constants)
tests/                     ~985 行 (smoke 测试)
```

---

## 2. 技术栈与架构

### 2.1 技术栈全景

```
┌─────────────────────────────────────────────────────────┐
│                    Desktop (Tauri v2)                     │
│              Rust shell + Bun 编译的 sidecar              │
├─────────────────────────────────────────────────────────┤
│                    Web Frontend                           │
│    React 18 + Vite + Tailwind CSS + Zustand              │
│    @assistant-ui/react + Radix UI + highlight.js         │
├─────────────────────────────────────────────────────────┤
│                    API Server                             │
│    Hono framework + Bun.serve + WebSocket                 │
│    Zod validation + JWT auth (单用户模式)                  │
├─────────────────────────────────────────────────────────┤
│                    Service Layer                          │
│    Agent Runtime (LLM/Code-Agent/MCP)                    │
│    Orchestrator Engine (DAG + Scheduler)                  │
│    Blackboard + Git Branch Manager                       │
├─────────────────────────────────────────────────────────┤
│                    Data Layer                             │
│    SQLite (bun:sqlite) + Drizzle ORM (WAL mode)          │
├─────────────────────────────────────────────────────────┤
│                    External                               │
│    OpenAI API / Anthropic API / 本地 CLI 工具              │
│    Codex / Claude Code / OpenCode / Gemini CLI            │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Monorepo 结构

```
AgentHub/
├── apps/
│   ├── server/        ← Hono REST API + WebSocket 服务
│   ├── web/           ← React SPA (Vite)
│   └── desktop/       ← Tauri v2 桌面壳
├── packages/
│   ├── db/            ← Drizzle ORM schema + migrations
│   └── shared/        ← Zod schemas + constants
├── tests/             ← Bun smoke tests
├── docs/              ← 产品文档
└── storage/           ← SQLite 数据库文件
```

### 2.3 数据库 ER 图

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│  users   │────<│  workspaces  │────<│workspace_     │
│          │     │              │     │agents         │
└──────────┘     └──────┬───────┘     └──────┬───────┘
                        │                    │
                        │              ┌─────┴──────────┐
                        │              │workspace_agent_ │
                        │              │relations        │
                        │              └─────────────────┘
                        │
                        ├────<┌──────────────────┐
                        │     │workspace_tasks    │
                        │     │(DAG fields)       │
                        │     └──────┬────────────┘
                        │            │ (run_id FK)
                        │     ┌──────┴────────────┐
                        ├────<│orchestrator_runs   │
                        │     └──────┬────────────┘
                        │            │ (CASCADE)
                        │     ┌──────┴────────────┐
                        │     │orchestrator_run_   │
                        │     │events              │
                        │     └────────────────────┘
                        │
┌──────────┐     ┌──────┴───────┐     ┌──────────────┐
│ sessions │────<│  messages    │     │session_      │
│(direct/  │     │              │     │members       │
│ group)   │────<├──────────────┤     └──────────────┘
└──────┬───┘     │execution_logs│
       │         └──────────────┘
       ├────<┌──────────────┐
       │     │  tasks       │ (session-level)
       │     └──────────────┘
       │
┌──────┴───┐     ┌──────────────┐
│blackboard│     │  settings    │
│_entries  │     │(key-value)   │
└──────────┘     └──────────────┘
```

---

## 3. 模块详解

### 3.1 Server 模块

#### 3.1.1 路由层 (`apps/server/src/routes/`)

| 路由模块 | 文件 | 端点数 | 核心职责 |
|----------|------|--------|----------|
| Sessions | sessions.ts | 5 | 会话 CRUD，支持 direct/group 类型 |
| Messages | messages.ts | 12+ | 消息发送、编辑、撤回、重生成；编排计划创建/分发 |
| Settings | settings.ts | 7 | 系统配置、LLM 连接测试、存储管理 |
| Workspaces | workspaces.ts | 18+ | 工作区、Agent、任务、关系的完整 CRUD |
| Coding Tools | coding-tools.ts | 15+ | CLI 工具探测、配置、认证（Codex 设备认证流） |
| Skills | skills.ts | 5 | 技能市场搜索、安装、管理 |
| Artifacts | artifacts.ts | 4 | 静态部署、diff 应用、ZIP 下载 |
| Orchestrator Runs | orchestrator-runs.ts | 9 | 运行历史、事件时间线、黑板查看、冲突解决 |
| Mobile | mobile.ts | 2 | 移动端配对码认证 |

#### 3.1.2 中间件 (`apps/server/src/middleware/`)

- **auth.ts**: 单用户模式，硬编码 `default-user`，无真实认证

#### 3.1.3 环境配置 (`apps/server/src/env.ts`)

Zod 验证的环境变量，30+ 配置项，支持 `envBoolean` 预处理器。

### 3.2 Web 模块

#### 3.2.1 页面路由

| 路径 | 页面 | 功能 |
|------|------|------|
| `/` , `/chat/:id` | ChatPage | 主聊天界面，支持单 Agent 和群聊 |
| `/office` | OfficePage | 仪表盘，统计 + 快捷操作 |
| `/agent-config` | AgentConfigPage | 全局 Agent 库 CRUD |
| `/coding-tools` | CodingToolsPage | CLI 工具管理 |
| `/models` | ModelManagementPage | 模型目录管理 |
| `/skills` | SkillsMarketPage | 技能市场 |
| `/orchestrator-runs` | OrchestratorRunsPage | 编排运行历史 |
| `/execution-logs` | ExecutionLogsPage | 执行日志查看器 |
| `/settings` | SettingsPage | 7 大设置分区 |

#### 3.2.2 状态管理

**chatStore** (Zustand):
- 会话列表、当前会话、消息流
- WebSocket 事件处理（8 种事件类型）
- 流式消息缓冲（32ms 去抖）
- **Intent Router**: 启发式复杂度评估，>=3 个信号自动路由到编排器

**workspaceStore** (Zustand):
- 工作区 CRUD、Agent CRUD、任务 CRUD
- 任务分发、工作区摘要生成

#### 3.2.3 核心组件

**Thread.tsx** (~3290 行):
- `OrchestratorPlanCard`: 编排计划卡片，显示任务列表、合约详情、路由理由、澄清问题
- `CodeAgentRunCard`: Code Agent 运行状态，显示工具调用、文件变更、diff 查看器
- `AgentArtifactsCard`: 产物展示（diff、preview、file、deploy、workflow）
- `DiffViewer`: 统一 diff 解析器和渲染器
- `Composer`: 丰富输入区，支持 `/skill`、`@agent`、模型选择、图片粘贴

### 3.3 Database 模块

#### 3.3.1 表清单（15 张表）

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `users` | 用户 | id, email, username, role |
| `sessions` | 会话 | type(direct/group), workspace_id, metadata(JSON) |
| `messages` | 消息 | sender_type(user/agent/system), type, is_pinned |
| `workspaces` | 工作区 | name, goal, project_path |
| `workspace_agents` | Agent 配置 | runtime_type, code_agent_type, sandbox_policy, capability_tags |
| `workspace_agent_relations` | Agent 关系 | relation_type(handoff_to/reviewed_by/fallback_to/reports_to/blocks) |
| `workspace_tasks` | 任务 | dependencies(JSON), run_id, parallel_group, max_retries |
| `session_members` | 会话成员 | member_type(user/agent) |
| `agents` | 全局 Agent 库 | provider, model, capabilities |
| `settings` | 键值配置 | key(unique), value |
| `tasks` | 会话级任务 | parent_id(self-ref), status |
| `blackboard_entries` | 黑板存储 | namespace, key, version, schema_version, tags |
| `orchestrator_runs` | 编排运行 | status, plan(JSON), conflict_report |
| `orchestrator_run_events` | 运行事件 | type, payload(JSON), severity |
| `execution_logs` | 执行日志 | type(llm_call/tool_call/...), token_usage |

#### 3.3.2 迁移历史（13 次）

从初始 schema 到 DAG 调度字段、黑板表、编排事件表、Agent 关系表，反映了功能的渐进式增长。

### 3.4 Shared 模块

Zod schemas: `auth`, `session`, `message`, `agent`, `task`, `artifact`（discriminated union）

Constants: `SenderType`, `MessageType`, `TaskStatus`, `SessionType`, `WsEvent`

### 3.5 Desktop 模块

Tauri v2 + Rust，侧载 `agenthub-server.exe`，启动流程：找端口 → 启动服务 → 轮询 `/health` → 加载 Web UI。

Rust 命令：`pick_workspace_folder`, `open_in_editor`, `notify_user`, `desktop_info`

---

## 4. 多 Agent 协作核心（重点）

### 4.1 Agent Runtime 层

```
┌─────────────────────────────────────────────────────────────┐
│                    AgentRuntime 接口                          │
│  execute(ctx: ExecutionContext): AsyncGenerator<Chunk>       │
│  runtimeType: string                                        │
│  displayName: string                                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
   ┌──────┴──────┐ ┌──┴──────────┐ ┌──┴──────────────┐
   │  LlmRuntime │ │NativeTool   │ │CodeAgentRuntime │
   │  (纯对话)   │ │Runtime      │ │(CLI 适配器)     │
   │             │ │(LLM+工具)   │ │                 │
   │ streamReply │ │ 多轮工具调用 │ │Bun.spawn CLI    │
   │             │ │ 只读工具集   │ │ Codex/Claude/   │
   │             │ │             │ │ OpenCode/Gemini │
   └─────────────┘ └─────────────┘ └─────────────────┘
```

#### RuntimeRegistry

简单的 Map 注册表，`resolveForProfile(profile)` 根据 `runtimeType` 分发到对应 runtime，未注册时 fallback 到 `llm`。

#### LlmRuntime

- 构建 system prompt（优先使用 Harness 系统，fallback 到手动拼接）
- 调用 `streamReply()` 流式输出
- 支持 OpenAI-compatible 和 Anthropic 两种 API

#### NativeToolRuntime

- **多轮工具调用循环**，最多 `AGENTHUB_NATIVE_MAX_TOOL_ROUNDS`（默认 6）轮
- 工具集：`workspace_info`, `list_files`, `read_file`, `search_code`, `list_skills`, `read_skill`
- 所有工具**只读**，路径沙箱化
- 支持 OpenAI function calling 和 Anthropic tool_use 两种格式

#### CodeAgentRuntime

- 薄包装层，调用 `code-agent-adapter.ts` 的 `streamCodeAgentReply()`
- 支持 4 种 CLI 工具：

| 工具 | 命令 | API Key | 提示模式 |
|------|------|---------|----------|
| Codex | `codex` | OPENAI_API_KEY | stdin |
| Claude Code | `claude` | ANTHROPIC_API_KEY | stdin |
| OpenCode | `opencode` | DEEPSEEK_API_KEY | argument |
| Gemini | `gemini` | GEMINI_API_KEY | argument |

**Code Agent Adapter 核心流程**:
1. 预检查：命令安装、API Key 配置、执行开关
2. Git 快照：`git status --short` 记录执行前状态
3. 进程生成：`Bun.spawn()` + stdin/argument 提示注入
4. 流解析：Claude Code 的 `stream-json` 格式专用解析器
5. 元数据收集：工具调用、文件变更、命令执行
6. Diff 收集：执行前后对比，生成 diff artifacts
7. 超时处理：`AGENTHUB_CODE_AGENT_TIMEOUT_MS`（默认 120s）

### 4.2 Orchestrator Engine（编排引擎）

这是整个系统最复杂的部分，15 个文件，~3500 行代码。

#### 4.2.1 核心组件关系

```
┌─────────────────────────────────────────────────────────────┐
│                  OrchestratorEngine                          │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐         │
│  │ Planner  │  │TaskScheduler │  │  Synthesizer  │         │
│  │          │  │              │  │               │         │
│  │ LLM 规划 │  │ DAG 并发调度 │  │ LLM 综合报告  │         │
│  └────┬─────┘  └──────┬───────┘  └───────────────┘         │
│       │               │                                     │
│  ┌────┴─────┐  ┌──────┴───────┐  ┌───────────────┐         │
│  │TaskGraph │  │Replanning   │  │ConflictResolver│         │
│  │(DAG 拓扑)│  │Engine       │  │(冲突检测/合并) │         │
│  └──────────┘  └──────────────┘  └───────────────┘         │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │InputGuardrails│ │TaskValidation│  │ TaskContract │      │
│  │(安全检查)     │ │(安全命令执行)│  │(输出合约验证) │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐                        │
│  │ RunEvents    │  │ RunLedger    │                        │
│  │(事件发射)     │  │(状态跟踪)    │                        │
│  └──────────────┘  └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

#### 4.2.2 Planner（规划器）

**三层层级 + Fallback**:

1. **Harness Spec 匹配**（可选）: 加载 `.agenthub/specs/*.spec.yml` 作为参考
2. **Spec 生成**: LLM 调用生成 `ProjectSpec`（模块分解、数据流、技术栈、文件布局）
3. **LLM 计划生成**: 基于 Spec + Agent 目录 + 关系图，生成 `ExecutionPlan`
4. **规范化**: 验证、去重 task ID、验证 agent key、解析 task type
5. **Fallback 计划**: LLM 失败时，确定性生成 3 阶段计划（plan → build → review）

**ExecutionPlan 结构**:
```typescript
interface ExecutionPlan {
  runId: string
  title: string
  goal: string
  phases?: OrchestratorPhase[]          // 任务分组
  agents: ExecutionAgent[]              // Agent 目录
  tasks: ExecutionTask[]                // DAG 任务节点
  agentRelations?: AgentRelation[]      // Agent 协作关系
  clarificationQuestions?: ClarificationQuestion[]  // 澄清问题
  taskLedger?: TaskLedger               // 任务快照
  progressLedger?: ProgressLedger       // 实时进度
}
```

#### 4.2.3 TaskGraph（DAG 图）

- **环检测**: DFS 基于 visited/stack
- **拓扑排序**: Kahn 算法（BFS，计算入度）
- **就绪查询**: `getReadyTasks()` 返回所有依赖已完成的 pending 任务
- **动态扩展**: `addTasks()` 支持运行时添加新任务（用于 replanning）

#### 4.2.4 TaskScheduler（调度器）

- **并发限制**: Semaphore，默认 3 并发（可配置 1-10）
- **轮询循环**: 200ms 间隔检查就绪任务
- **任务信号**: 每个任务有独立 AbortController，支持取消
- **信号组合**: `combineAbortSignals()` 支持多信号聚合

#### 4.2.5 Agent Router（Agent 选择）

**评分系统**:
- `roleType` 匹配: +30
- `capabilityTags` 匹配: +8/个（上限 25）
- Code 任务 + code-agent runtime: +20
- Non-code 任务 + llm runtime: +10
- Code 任务 + workspace-write sandbox: +10
- 有协作关系: +10
- workspace:write 权限: +5

**关系解析**: `reviewed_by` → 审查者，`fallback_to` → 备选 Agent

#### 4.2.6 Replanning Engine（重规划引擎）

**错误分类**:
- `transient_error`: 超时、限流、连接错误
- `timeout`: 任务级超时
- `schema_mismatch`: JSON/Schema 解析错误
- `unrecoverable_error`: 不可恢复错误

**策略矩阵**:

| 错误类型 | retry < max | retry >= max |
|----------|-------------|--------------|
| transient_error | retry_with_backoff (指数退避) | agent_substitution |
| timeout | local_replan (timeout x 1.5) | agent_substitution |
| schema_mismatch | agent_substitution | task_split / escalate_to_user |
| unrecoverable | retry_with_backoff (仅 1 次) | escalate_to_user |

#### 4.2.7 Conflict Resolver（冲突解决）

1. 按文件路径分组 artifacts
2. 多 Agent 修改同一文件 → 冲突
3. 尝试 auto-merge（当前仅单变体成功）
4. LLM 三路合并（base + variants → mergedContent）
5. 失败 → `needs-human`，用户手动解决

#### 4.2.8 Synthesizer（综合器）

LLM 生成结构化报告：执行摘要、各 Agent 输出、冲突处理、风险建议、下一步。

### 4.3 Blackboard（黑板系统）

**命名空间**: `workspace/${workspaceId}/run/${runId}`

**7 种类型化 Schema**:
- `fact`: 事实发现
- `decision`: 设计决策
- `risk`: 风险项
- `artifact_ref`: 产物引用
- `diff_summary`: 变更摘要
- `test_result`: 测试结果
- `task_output`: 任务完整输出

**API**: write/read/readRef/update/query/subscribe/clearNamespace

### 4.4 Git Branch Manager（分支隔离）

**核心流程**:
1. `prepareBranch()`: stash → checkout -b `agenthub/{runId}/{agentKey}/{taskId}` → worktree
2. Agent 在隔离 worktree 中工作
3. `collectDiff()` + `collectChangedFiles()`: 收集变更
4. `cleanupBranch()`: 删除 worktree → 恢复原分支 → pop stash → 删除 agent 分支

**并发控制**: `ProjectLock` — 按 projectPath 的 Promise 链互斥锁

### 4.5 Agent 关系系统

**5 种关系类型**:
- `handoff_to`: 任务交接（A → B）
- `reviewed_by`: 代码审查（A 被 B 审查）
- `fallback_to`: 备选 Agent（A 失败时用 B）
- `reports_to`: 汇报关系
- `blocks`: 阻塞关系

**默认团队配置**（seedClassicAgents）:
- Clarifier（澄清者）→ Architect（架构师）: handoff_to
- Architect → Coder（编码者）: handoff_to
- Coder → Reviewer（审查者）: reviewed_by
- Coder → Integrator（集成者）: fallback_to

### 4.6 Harness 系统

`.agenthub/` 目录下的 YAML 配置:
- `specs/*.spec.yml`: 多阶段执行规范
- `skills/*.skill.yml`: Agent 技能模板（支持 `{{BASE_PROMPT}}` 等占位符）
- `rules/*.yml`: 编码规范（约束、命名、禁止模式）

### 4.7 Intent Router（意图路由）

**三步决策**:
1. 显式 `@orchestrator` / `@协调器` / `@调度` → 强制路由
2. 非 group 会话或 <2 个 Agent → 不路由
3. `assessIntentComplexity()` 启发式评估

**复杂度信号**（阈值 >= 3）:
- +2: 多文件引用（.ts, .py, .rs 等扩展名）
- +2: 多阶段模式（"先...然后"、"step N"）
- +2: 架构级关键词（refactor, migration, system design）
- +1: 多 Agent 协作提示（simultaneously, in parallel）
- +1: 复杂动词 + 技术对象（build + api, create + database）
- +1: 长消息（>200 字符）+ 技术内容

---

## 5. 流程图与架构图

### 5.1 用户消息处理全流程

```
用户输入
    │
    ▼
┌───────────────┐
│ Intent Router │──(复杂度 >= 3)──→ ┌──────────────────────┐
│ (前端评估)    │                    │ Orchestrator Plan    │
└───────┬───────┘                    │ (后端 LLM 生成计划)   │
        │ (简单消息)                 └──────────┬───────────┘
        ▼                                       │
┌───────────────┐                               ▼
│ sendMessage() │                    ┌──────────────────────┐
│ (API 调用)    │                    │ dispatch()           │
└───────┬───────┘                    │ (创建 run + tasks)   │
        │                            └──────────┬───────────┘
        ▼                                       │
┌───────────────┐                               ▼
│ runAgentReply │                    ┌──────────────────────┐
│ (选择 Runtime)│                    │ OrchestratorEngine   │
└───────┬───────┘                    │ .startRun()          │
        │                            └──────────┬───────────┘
        ▼                                       │
┌───────────────┐                    ┌──────────┴───────────┐
│ Runtime       │                    │ TaskScheduler         │
│ .execute()    │                    │ (DAG 并发调度)        │
└───────┬───────┘                    └──────────┬───────────┘
        │                                       │
        ▼                                       ▼
┌───────────────┐                    ┌──────────────────────┐
│ WebSocket     │                    │ executeTask() x N    │
│ 流式广播      │                    │ (每个任务独立执行)    │
└───────────────┘                    └──────────┬───────────┘
                                                │
                                                ▼
                                    ┌──────────────────────┐
                                    │ Post-execution       │
                                    │ ├─ Auto-review       │
                                    │ ├─ Conflict resolve  │
                                    │ └─ Synthesize report │
                                    └──────────────────────┘
```

### 5.2 单任务执行流程

```
executeTask(task, plan, ...)
    │
    ▼
┌─────────────────────┐
│ 1. Git Branch       │ (sandboxPolicy != 'read-only')
│    prepareBranch()  │ → stash → checkout -b → worktree
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 2. Build Prompt     │
│    ├─ Agent system  │
│    ├─ 协作目标      │
│    ├─ 任务描述      │
│    └─ 上下文注入    │ ← Blackboard 读取上游输出
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 3. Execute Agent    │
│    runAgentReply()  │ → Runtime.execute()
│    (流式输出)       │ → WebSocket 广播
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 4. Collect Artifacts│
│    ├─ Git diff      │
│    ├─ Changed files │
│    └─ Summary       │ (regex/LLM 摘要)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 5. Write Blackboard │
│    ├─ task_output    │
│    ├─ decisions/*    │
│    ├─ diffs/*        │
│    └─ artifacts/*    │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 6. Validate         │
│    ├─ Task commands  │ (test/lint/typecheck)
│    └─ Output contract│ (artifacts/paths/writes)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 7. Cleanup          │
│    ├─ Update DB     │
│    ├─ Broadcast     │
│    └─ Git cleanup   │ → delete worktree → restore branch
└─────────────────────┘
```

### 5.3 编排引擎完整生命周期

```
POST /orchestrator-plan/:id/dispatch
    │
    ▼
┌──────────────────────┐
│ Input Guardrails     │ → 检查危险命令/敏感操作
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Create Workspace     │ → 复用或新建
│ Create Group Session │ → 群聊会话
│ Create Tasks         │ → workspace_tasks 记录
│ Create Child Sessions│ → 每个任务一个子会话
│ Insert OrchestratorRun│ → orchestrator_runs 记录
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ OrchestratorEngine   │
│ .startRun()          │
│                      │
│ 1. initializeLedger  │ → 初始化进度账本
│ 2. Register engine   │
│ 3. DB status='running│
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│ TaskScheduler.executePlan()                   │
│                                              │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐     │
│  │ Task A  │  │ Task B  │  │ Task C  │     │
│  │(Layer 0)│  │(Layer 0)│  │(Layer 1)│     │
│  │ pending │  │ pending │  │ pending │     │
│  └────┬────┘  └────┬────┘  └────┬────┘     │
│       │            │            │           │
│       ▼            ▼            │           │
│  ┌─────────┐  ┌─────────┐      │           │
│  │running  │  │running  │      │           │
│  │(并发)   │  │(并发)   │      │           │
│  └────┬────┘  └────┬────┘      │           │
│       │            │            │           │
│       ▼            ▼            ▼           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐     │
│  │  done   │  │  done   │  │running  │     │
│  └─────────┘  └─────────┘  └─────────┘     │
│                                             │
│  (每 200ms 轮询，Semaphore 限制 3 并发)      │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│ Post-Execution                                │
│                                              │
│ 1. Auto-Review                               │
│    └─ code tasks + requiresReview            │
│       → 注入 review-{taskId} 任务            │
│       → 内联执行（不经调度器）                │
│                                              │
│ 2. Conflict Resolution                       │
│    └─ 检测多 Agent 修改同一文件               │
│       → auto-merge / LLM 3-way / needs-human │
│                                              │
│ 3. Synthesize                                │
│    └─ LLM 生成综合报告                       │
│       → 发送到群聊会话                       │
│                                              │
│ 4. Cleanup                                   │
│    └─ 清除黑板命名空间                       │
│       → DB status='completed'                │
└──────────────────────────────────────────────┘
```

### 5.4 Replanning 策略决策树

```
任务失败
    │
    ▼
┌───────────────────┐
│ analyze(error)    │
│ 分类错误类型       │
└─────────┬─────────┘
          │
    ┌─────┼─────┬──────────┬──────────┐
    │     │     │          │          │
    ▼     ▼     ▼          ▼          ▼
transient timeout schema   capability unrecoverable
    │     │     _mismatch _mismatch  │
    │     │     │          │          │
    ▼     ▼     ▼          ▼          ▼
┌───────┐ ┌───────┐ ┌──────────┐ ┌───────────┐
│retry  │ │local  │ │agent_    │ │retry(1x)  │
│with   │ │replan │ │substitutn│ │→ escalate │
│backoff│ │(t*1.5)│ │→ task_   │ │           │
│       │ │       │ │  split   │ │           │
└───┬───┘ └───┬───┘ └────┬─────┘ └─────┬─────┘
    │         │          │              │
    ▼         ▼          ▼              ▼
  还有重试?  还有重试?  还有重试?    写入黑板
  ┌─Y─┐     ┌─Y─┐     ┌─Y─┐        发射事件
  │   │     │   │     │   │        返回失败
  │重试│     │重试│     │替换│
  └───┘     └───┘     └─N─┘
  ┌─N─┐     ┌─N─┐      │
  │   │     │   │      ▼
  │替换│     │替换│   task_split
  └───┘     └───┘   (拆分子任务)
```

### 5.5 WebSocket 事件流

```
Server                              Client
  │                                    │
  │---- agent:typing ----------------->│  (Agent 开始输入)
  │                                    │
  │---- message:stream --------------->│  (流式文本增量, 32ms 去抖)
  │---- message:stream --------------->│
  │---- message:stream --------------->│
  │                                    │
  │---- message:metadata ------------->│  (Code Agent 元数据)
  │                                    │
  │---- message:completed ------------>│  (最终消息 + DB 持久化)
  │                                    │
  │     --- 编排模式 ---                │
  │                                    │
  │---- run:event(task.started) ------>│  (任务开始)
  │---- task:update ------------------>│  (任务状态更新)
  │---- blackboard:update ------------>│  (黑板写入通知)
  │---- run:event(task.completed) ---->│  (任务完成)
  │                                    │
  │---- run:event(conflict.detected) ->│  (冲突检测)
  │---- run:event(conflict.resolved) ->│  (冲突解决)
  │                                    │
  │---- run:event(run.synthesizing) -->│  (开始综合)
  │---- run:event(run.completed) ----->│  (运行完成)
```

---

## 6. 现存问题诊断

### 6.1 架构层面问题

#### P0: `messages.ts` 过度膨胀（~1990 行）

**症状**: 单文件包含 12+ 个端点、Agent 推断函数、计划生成、消息回滚、群组回复路由。

**根因**: 编排计划的创建/分发、Agent 草稿、消息 CRUD 全部堆在一个路由文件中。

**影响**: 难以测试、难以维护、改一个功能可能影响其他功能。

#### P0: `Thread.tsx` 过度膨胀（~3290 行）

**症状**: 单组件包含 OrchestratorPlanCard、CodeAgentRunCard、DiffViewer、Composer、UserMessage、AssistantMessage 等所有聊天 UI。

**根因**: 缺乏组件拆分策略，所有相关 UI 放在一起便于状态共享。

**影响**: IDE 性能差、重构困难、多人协作冲突。

#### P1: `native-agent-loop.ts` 与 `native-tool-runtime.ts` 代码重复

**症状**: 两个文件包含几乎相同的工具循环实现（~800 行重复代码）。

**根因**: `native-agent-loop.ts` 是旧版独立实现，`native-tool-runtime.ts` 是 Runtime 层重构后的版本，旧版未删除。

#### P1: 前端类型定义与后端 Schema 不一致

**症状**: `api.ts` 自行定义了 `AgentArtifact`、`OrchestratorPlan` 等类型，与 `packages/shared` 的 Zod schema 不完全对应（如 `workflow` artifact 只在前端定义）。

**根因**: 前后端类型未通过共享包统一管理。

#### P2: Agent 推断函数硬编码在路由层

**症状**: `inferCodeAgentType`, `inferAgentRole`, `inferAgentName` 等函数在 `messages.ts` 中通过正则匹配自然语言内容来推断 Agent 属性。

**根因**: 缺乏标准化的 Agent 创建流程，用"智能推断"替代了显式配置。

**影响**: 推断逻辑不可靠，难以扩展，测试困难。

### 6.2 多 Agent 协作问题

#### P0: LLM 调用缺乏成本控制

**症状**: 编排引擎的每次任务执行、摘要生成、冲突合并、Spec 生成、计划生成都调用 LLM，无 token 预算或成本跟踪。

**根因**: 追求功能完整性时未考虑成本优化。

**行业参考**: Anthropic 指出 orchestrator-worker 模式只有在任务价值超过 15x 基线时才值得使用。CrewAI 提供 `max_rpm` 和 `max_execution_time` 控制。

#### P0: 编排计划的 LLM 生成质量不可控

**症状**: Planner 依赖 LLM 生成 `ExecutionPlan`，包括任务分解、依赖关系、Agent 分配。LLM 输出质量波动大，fallback 计划过于简单（固定 3 阶段）。

**根因**: 将结构化规划完全委托给 LLM，缺乏验证和修正机制。

**行业参考**: MetaGPT 用 SOP（标准操作流程）约束 LLM 输出，而非让 LLM 自由发挥。LangGraph 用确定性图结构 + 条件边，LLM 只做内容不做结构决策。

#### P1: Blackboard 上下文注入过于粗糙

**症状**: `buildTaskPrompt()` 将上游任务的完整输出（截断到一定长度）注入下游任务提示词。

**根因**: 缺乏智能的上下文选择和压缩机制。

**影响**: Token 浪费严重，下游 Agent 收到大量无关信息。

**行业参考**: Anthropic 建议"子 Agent 应接收窄的、自包含的提示——而非完整的父对话"。

#### P1: Auto-Review 执行方式不当

**症状**: `injectAutoReviewTasks()` 在所有任务完成后**内联执行**审查任务（不经过调度器），这意味着审查任务无法并行。

**根因**: 审查任务作为"事后补充"而非"计划内任务"。

**行业参考**: MetaGPT 的 QA Engineer 是 SOP 中的正式角色，审查是流水线的一部分而非事后添加。

#### P1: Conflict Resolver 的 auto-merge 形同虚设

**症状**: `tryAutoMerge()` 当前只对单变体情况成功，对真正的多 Agent 冲突直接返回失败。

**根因**: auto-merge 算法未实现，直接 fallback 到 LLM 合并。

#### P2: Replanning Engine 策略过于激进

**症状**: `global_replan` 策略会重新生成整个计划，可能导致已完成的任务被重复执行。

**根因**: 缺乏"已完成任务不可变"的保护机制。

#### P2: 缺乏 Agent 间直接通信机制

**症状**: Agent 之间只能通过 Blackboard 间接通信，无法进行实时对话或协商。

**根因**: 架构设计选择了 Hub-and-Spoke 模式，未考虑 Peer-to-Peer 场景。

**行业参考**: AutoGen 的 Agent 之间可以直接消息传递；Swarm 的 Handoff 机制允许 Agent 直接切换。

### 6.3 基础设施问题

#### P1: WebSocket 无认证

**症状**: WebSocket 连接无 token 验证，任何人连接后通过 `session:join` 即可加入会话房间。

**根因**: 单用户模式下未考虑安全性。

#### P1: SQLite 单文件数据库的并发限制

**症状**: WAL 模式下读写并发有所改善，但写操作仍是串行的。多个 Agent 同时写入 Blackboard 时可能产生锁竞争。

**行业参考**: 生产环境通常使用 PostgreSQL。

#### P2: 前端 Zustand Store 状态同步问题

**症状**: `chatStore` 中的 `streamingMessage` 依赖 32ms 去抖定时器，网络抖动可能导致消息顺序错乱。

#### P2: 无持久化 WebSocket 重连状态

**症状**: WebSocket 断连重连后，只重新加入当前会话房间，丢失期间的事件（如任务状态更新）。

### 6.4 功能缺失

| 缺失功能 | 严重性 | 说明 |
|----------|--------|------|
| 多用户支持 | 低 | 比赛场景单用户足够 |
| Agent 对话历史持久化 | 中 | Group 会话的 Agent 上下文丢失 |
| 任务取消后状态一致性 | 中 | 取消的任务可能已部分执行 |
| 编排计划模板 | 中 | 常见任务模式无法复用 |
| Agent 执行沙箱 | 中 | Code Agent 在宿主机执行，无容器隔离 |
| 单元测试覆盖 | 中 | 仅 smoke 测试，无细粒度单元测试 |
| CI/CD | 低 | 比赛阶段不需要 |

---

## 7. 行业对标与开源案例

### 7.1 对标矩阵

| 维度 | AgentHub | MetaGPT | AutoGen | LangGraph | CrewAI |
|------|----------|---------|---------|-----------|--------|
| **编排模式** | DAG + 调度器 | SOP-as-DAG | Actor Model | Graph + Super-steps | Sequential/Hierarchical |
| **通信机制** | Blackboard | Shared Message Pool | Message Passing | Shared State | Delegation |
| **Agent 定义** | DB 配置 + Runtime | YAML + Role Pipeline | Agent Class | Node Function | YAML + Role/Goal |
| **冲突解决** | Git 分支隔离 + LLM 合并 | 结构化接口避免冲突 | 消息隔离 | State Reducer | 无 |
| **失败处理** | 重规划引擎(7策略) | 可执行反馈循环 | 重试 + 人工介入 | 持久化 + 恢复 | max_retry_limit |
| **成本控制** | 无 | 无显式控制 | 无 | 无 | max_rpm/max_execution_time |
| **可观测性** | ExecutionTracer + Events | 日志 | 日志 | LangSmith | 日志 |
| **人机交互** | 澄清问题 + 计划审批 | 无 | UserProxyAgent | 中断断点 | 无 |
| **Code Agent** | CLI 适配(4种) | 内置代码生成 | 代码执行器 | 自定义 | 自定义 |
| **语言** | TypeScript/Bun | Python | Python/.NET | Python | Python |

### 7.2 值得借鉴的模式

#### MetaGPT: SOP 约束 LLM 输出

MetaGPT 的核心洞察：不要让 LLM 自由发挥，而是用 SOP（标准操作流程）约束其输出格式和内容。每个角色有明确的**输入 Schema**和**输出 Schema**，消除角色混淆和幻觉级联。

**AgentHub 可借鉴**: 将 Planner 的 LLM 调用改为 SOP 驱动——预定义任务模板，LLM 只填充内容而非决定结构。

#### Anthropic: 15x 成本规则

> "Orchestrator-worker 模式只有在任务价值超过 15x 基线且工作真正可并行化时才值得使用。"

**AgentHub 可借鉴**: 引入任务复杂度评估，简单任务直接单 Agent 处理，只有复杂任务才进入编排流程。

#### LangGraph: 持久化执行 + 中断断点

LangGraph 的核心能力：Agent 在任何执行点都可以暂停、检查状态、恢复执行。状态通过 checkpointing 持久化。

**AgentHub 可借鉴**: 为编排引擎添加 checkpoint 机制，支持运行暂停/恢复。

#### OpenAI Swarm: 极简 Handoff

Swarm 的核心洞察：Agent 之间的切换（Handoff）应该是最简单的操作——一个函数返回另一个 Agent 即可。

**AgentHub 可借鉴**: 简化 Agent 关系系统，`handoff_to` 可以更轻量化。

#### SWE-Agent: Agent-Computer Interface 设计

SWE-Agent 的核心创新：为 LLM 设计专用的命令接口（`find_file`, `search_dir`），比原始 shell 命令高效得多。

**AgentHub 可借鉴**: NativeToolRuntime 的只读工具集已经是这个方向，可以扩展为更丰富的 ACI。

### 7.3 中国开源项目参考

| 项目 | 星标 | 核心特点 | AgentHub 可借鉴 |
|------|------|----------|----------------|
| MetaGPT | 45K+ | SOP 驱动、结构化通信 | SOP 约束 LLM 输出 |
| ChatDev | — | 虚拟软件公司 | 角色扮演对话模式 |
| AgentScope | — | 阿里 DAMO 通用平台 | 可扩展的 Runtime 架构 |
| Qwen-Agent | — | 通义千问 Agent 框架 | 模型原生工具调用 |

---

## 8. 重构与优化路线图

### 8.1 Phase 1: 代码治理（1-2 周）

**目标**: 降低复杂度，消除技术债务

#### 1.1 拆分 `messages.ts`

```
routes/messages.ts (保留消息 CRUD)
routes/orchestrator.ts (编排计划相关)
routes/agent-draft.ts (Agent 草稿相关)
services/message-rollback.ts (消息回滚逻辑)
services/agent-inference.ts (Agent 推断函数)
services/group-reply.ts (群组回复路由)
```

#### 1.2 拆分 `Thread.tsx`

```
components/chat/Thread.tsx (核心容器)
components/chat/OrchestratorPlanCard.tsx
components/chat/CodeAgentRunCard.tsx
components/chat/DiffViewer.tsx
components/chat/Composer.tsx
components/chat/UserMessage.tsx
components/chat/AssistantMessage.tsx
components/chat/AgentArtifactsCard.tsx
```

#### 1.3 删除 `native-agent-loop.ts`

直接使用 `NativeToolRuntime`，消除代码重复。

#### 1.4 统一前后端类型

将 `api.ts` 中的自定义类型迁移到 `packages/shared`，通过 Zod schema 统一管理。

### 8.2 Phase 2: 编排引擎增强（2-3 周）

**目标**: 提升编排质量和可靠性

#### 2.1 SOP 驱动的计划生成

```
当前: LLM 自由生成 ExecutionPlan (结构 + 内容)
目标: 预定义任务模板 + LLM 填充内容

planner.ts 改造:
1. 定义任务模板库 (web-app, api-service, refactor, etc.)
2. LLM 选择模板 + 填充具体内容
3. 确定性算法组装 DAG
4. LLM 只负责: 标题、描述、Agent 选择
```

#### 2.2 智能上下文注入

```
当前: 截断上游输出全量注入
目标: 按相关性选择性注入

context-builder.ts (新文件):
1. 分析当前任务类型和目标
2. 从 Blackboard 中选择最相关的上游输出
3. 使用 LLM 生成结构化上下文摘要
4. 限制总 token 预算 (如 2000 tokens)
```

#### 2.3 Auto-Review 集成到 DAG

```
当前: 任务完成后内联执行审查
目标: 审查任务作为 DAG 正式节点

改造:
1. Planner 在生成计划时就包含 review 任务
2. review 任务依赖对应的 code 任务
3. 通过 TaskScheduler 正常调度
```

#### 2.4 成本控制层

```typescript
// services/cost-tracker.ts
interface CostBudget {
  maxTokensPerRun: number       // 如 100,000
  maxTokensPerTask: number      // 如 10,000
  maxLlmCallsPerRun: number     // 如 50
  alertThreshold: number        // 如 80%
}

// 在 OrchestestratorEngine.startRun() 中检查
// 在每次 LLM 调用后更新预算
```

#### 2.5 Checkpoint/Resume 机制

```typescript
// 在 orchestrator_runs.plan JSON 中存储 checkpoint
interface RunCheckpoint {
  completedTaskIds: string[]
  blackboardSnapshot: Record<string, unknown>
  lastEventId: string
}

// 支持从 checkpoint 恢复执行
// 避免已完成任务被重复执行
```

### 8.3 Phase 3: Agent 能力提升（2-3 周）

**目标**: 更智能的 Agent 协作

#### 3.1 模型分层（Model Tiering）

```
当前: 所有 Agent 使用同一模型
目标: 按任务类型选择模型

Orchestrator (规划/综合): 强模型 (Claude Opus / GPT-4o)
Researcher (检索/分析): 快速模型 (Claude Haiku / GPT-4o-mini)
Coder (编码): Code 专用模型 (Claude Sonnet / Codex)
Reviewer (审查): 强模型 (同 Orchestrator)
```

#### 3.2 Agent 间直接通信

```
当前: 只通过 Blackboard 间接通信
目标: 支持 Agent 间消息传递

services/agent-messenger.ts (新文件):
- Agent 可以向其他 Agent 发送消息
- 消息经过 Orchestrator 审核
- 支持请求-响应模式
```

#### 3.3 Evaluator-Optimizer 循环

```
当前: Code → Review 单次审查
目标: Code → Review → Revise → Review 循环

Anthropic 的三 Agent 模式:
1. Planner: 生成任务计划
2. Generator: 执行代码
3. Evaluator: 评估质量，给出修改建议
4. 如果评估不通过: Generator 修订，循环
5. 最大循环次数: 3
```

### 8.4 Phase 4: 用户体验优化（1-2 周）

**目标**: 更好的可视化和交互

#### 4.1 实时编排可视化

```
当前: 任务状态通过 WebSocket 事件更新
目标: 可视化 DAG 执行进度

新增组件: OrchestratorDagView
- 节点 = 任务，边 = 依赖
- 颜色编码: pending(gray), running(blue), done(green), failed(red)
- 实时更新动画
```

#### 4.2 编排计划模板

```
目标: 用户可以保存和复用编排计划模板

templates/
  ├── web-app.yml        (前端应用模板)
  ├── api-service.yml    (后端 API 模板)
  ├── refactor.yml       (代码重构模板)
  └── data-pipeline.yml  (数据管道模板)
```

#### 4.3 任务级别的暂停/恢复

```
当前: 只能取消整个运行
目标: 可以暂停/恢复单个任务

POST /orchestrator-runs/:id/tasks/:taskId/pause
POST /orchestrator-runs/:id/tasks/:taskId/resume
```

### 8.5 Phase 5: 协议与生态（长期）

#### 5.1 MCP 服务器实现

将 AgentHub 的工具注册为标准 MCP 服务器，允许外部客户端（如 VS Code、Cursor）直接调用。

#### 5.2 A2A 协议兼容

实现 Google A2A 协议的 Agent Card 发现机制，允许不同系统的 Agent 互相发现和协作。

#### 5.3 多用户支持

将 `authMiddleware` 从硬编码单用户改为 JWT 认证，支持多用户工作区隔离。

---

## 附录 A: 关键文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `apps/server/src/routes/messages.ts` | ~1990 | 消息路由 + 编排计划 |
| `apps/server/src/services/code-agent-adapter.ts` | ~1540 | Code Agent CLI 适配 |
| `apps/server/src/services/orchestrator/orchestrator-engine.ts` | ~1370 | 编排引擎主类 |
| `apps/server/src/services/llm-client.ts` | ~664 | LLM 流式客户端 |
| `apps/server/src/services/agent-runner.ts` | ~500 | Agent 执行器 + WebSocket 管理 |
| `apps/server/src/services/orchestrator/planner.ts` | ~500 | LLM 计划生成 |
| `apps/server/src/services/blackboard.ts` | ~400 | 黑板 KV 存储 |
| `apps/server/src/services/git/branch-manager.ts` | ~350 | Git 分支隔离 |
| `apps/web/src/components/assistant-ui/Thread.tsx` | ~3290 | 聊天 UI 核心 |
| `apps/web/src/lib/api.ts` | ~1800 | HTTP API 客户端 |
| `apps/web/src/stores/chatStore.ts` | ~800 | 聊天状态管理 |
| `apps/web/src/pages/SettingsPage.tsx` | ~2311 | 设置页面 |
| `packages/db/src/schema.ts` | ~400 | 数据库 Schema |

## 附录 B: 环境变量清单

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 8000 | 服务端口 |
| `DATABASE_URL` | ./storage/agenthub.db | SQLite 路径 |
| `LLM_PROVIDER` | openai | 默认 LLM 提供商 |
| `LLM_API_KEY` | — | LLM API Key |
| `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION` | true | Code Agent 执行开关 |
| `AGENTHUB_CODE_AGENT_TIMEOUT_MS` | 120000 | Code Agent 超时 |
| `AGENTHUB_NATIVE_MAX_TOOL_ROUNDS` | 6 | 工具调用最大轮数 |
| `ENABLE_LOCAL_CLI_PROBES` | true | 探测本地 CLI 工具 |

## 附录 C: 参考文献

1. Microsoft Research. "AutoGen v0.4: Reimagining the Foundation of Agentic AI" (2025)
2. Anthropic. "Building Effective Agents" (2024) — https://www.anthropic.com/engineering/building-effective-agents
3. LangChain. "LangGraph Documentation" — https://docs.langchain.com/oss/python/langgraph/overview
4. MetaGPT Paper. arXiv:2308.00352 (2023)
5. Google. "Agent-to-Agent Protocol" (2025) — https://a2a-protocol.org
6. Princeton NLP. "SWE-Agent" (2024) — https://swe-agent.com
7. OpenAI. "Swarm" (2024) — https://github.com/openai/swarm
8. CrewAI Documentation — https://docs.crewai.com
9. OpenHands (formerly OpenDevin) — https://github.com/All-Hands-AI/OpenHands
10. Aider — https://aider.chat
