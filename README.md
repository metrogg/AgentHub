# AgentHub

AgentHub 是一个 IM 式多 Agent 协作平台。用户可以和单个 Agent 私聊，也可以在群聊中交给 Orchestrator 自动拆解任务、调度多个 Agent、收集产物并汇总结果。

当前项目处于快速迭代阶段，优先目标是跑通通用的“群聊主线 + A2A 任务分发 + 多 Agent 任务子对话 + 本地工作目录 + 产物交接”闭环。

## 核心体验

- **Agent 私聊**：用户与单个 Agent 一对一对话。
- **Agent 群聊**：用户在群聊里提出目标，Orchestrator 负责理解、规划、分工和总结。
- **任务子对话**：每个成员在自己的子对话里真实接收任务并执行，主群聊只展示进度和汇报。
- **动态任务 DAG**：由模型生成计划，按依赖顺序执行，不使用固定场景模板。
- **A2A 通信标准**：Orchestrator 给成员分发任务时统一生成 A2A v0.3 `message/send`，A2A 是通信协议，不是 Agent 类型。
- **显式分工**：执行任务只接受 Orchestrator/Planner 的模型指派，系统不再用关键词路由、默认团队或自动 follow-up 改写分工。
- **Code Agent 执行**：统一适配 Codex CLI、Claude Code、OpenCode、Gemini CLI；自建 Agent 是在这些 Coding Agent 基底上配置角色、提示词、Skills/MCP 能力和权限。
- **工作目录与 handoff**：每个 Agent 有自己的工作目录，上游产物通过 `.agenthub/handoff` 交给下游。
- **产物可见**：文件、网页、diff、诊断产物会进入消息 metadata 和任务看板。

## 当前协作路径

```text
用户在群聊发起任务
  -> Orchestrator 判断复杂度
  -> 复杂任务生成动态 DAG 和任务看板
  -> 用户分发执行
  -> 为每个任务创建 orchestrator-task 子对话
  -> Orchestrator 生成 A2A message/send envelope
  -> LocalA2ATransport 分发给本地执行宿主
  -> Agent 在子对话里执行并输出
  -> 产出以 A2A responseTask / artifact metadata 写入消息、黑板和 handoff 目录
  -> 主群聊展示成员汇报、产物和最终总结
```

左侧会话树规则：

- “Agent 私聊”只显示真正的全局私聊。
- “群聊”显示主群聊。
- 展开群聊后只显示真实任务子对话。
- 旧的 `workspace-agent-child` 和历史占位入口不再作为当前 UI。

更详细的当前架构见 [docs/当前多Agent协作架构.md](docs/当前多Agent协作架构.md)。

## 分层定位

AgentHub 的目标不是做一个固定角色模板系统，而是把多 Coding Agent 协作做成可见、可控、可追踪的 IM 产品：

| 层 | 当前定位 |
| --- | --- |
| 产品交互层 | 群聊、私聊、任务子对话、任务看板、产物卡 |
| 编排层 | Orchestrator 动态规划 DAG，调度、取消、重试、汇总 |
| 通信协议层 | A2A 承载 Agent 间 message/task/artifact，AG-UI 承载运行事件到 UI |
| 执行层 | Codex CLI / Claude Code / OpenCode / Gemini CLI 为主要 Agent 基底，LLM 为内部/兜底 |
| 能力层 | MCP、Skills、Rules、shell、文件、浏览器等作为 Code Agent 能力 |
| 工作区层 | 系统默认工作空间根 + 项目根 + `.agenthub/workdirs` + `.agenthub/handoff` + blackboard |

完整分层和业内方案对比见 [docs/多Agent协作分层架构与业内对比.md](docs/多Agent协作分层架构与业内对比.md)。

## 技术栈

| 层面 | 技术 |
| --- | --- |
| 运行时 | Bun >= 1.1.0 |
| Monorepo | Bun workspaces |
| 后端 | Hono + Bun.serve + WebSocket |
| 前端 | React 18 + Vite + TypeScript |
| UI | Tailwind CSS + Radix UI + assistant-ui |
| 状态 | Zustand |
| 数据库 | SQLite + Drizzle ORM |
| LLM | OpenAI-compatible + Anthropic-compatible streaming client，用于 Orchestrator/Planner/Synthesizer 和 fallback |
| Code Agent | Codex CLI / Claude Code / OpenCode / Gemini CLI |
| Agent 通信 | A2A v0.3 message/send + AgentHub local/remote transport |

## 项目结构

```text
apps/
  server/
    src/
      routes/                 HTTP API
      services/
        orchestrator/         Orchestrator、Planner、Scheduler、Synthesizer
        execution/            任务执行、工作目录、执行信封
        runtime/              AgentRuntime 统一接口
        workspace/            工作区和任务子会话管理
        code-agent-adapter.ts CLI 适配
        blackboard.ts         Agent 间黑板
  web/
    src/
      components/chat/        Thread、TaskBoard、SessionList
      stores/                 Zustand store
      lib/                    API、WebSocket、会话树
packages/
  db/                         Drizzle schema 和 SQLite 连接
  shared/                     共享 Zod schema、常量、类型
docs/                         产品、架构、调研和使用说明
tests/                        bun:test 测试
```

## 快速开始

```bash
bun install
bun run dev
```

开发服务会同时启动：

- Server: 默认从 `http://localhost:8000` 开始，端口占用时自动递增。
- Web: Vite 默认从 `http://localhost:5173` 开始，端口占用时自动递增。

单独启动：

```bash
bun run dev:server
bun run dev:web
```

检查：

```bash
bun run typecheck
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck
bun test
```

## 环境变量

复制 `.env.example` 到 `.env`。常用项：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | SQLite 文件路径，默认 `./storage/agenthub.db` |
| `PORT` | Server 起始端口，默认 `8000` |
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 默认模型配置 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | OpenAI-compatible 配置 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` | Anthropic 配置 |
| `ENABLE_LOCAL_CLI_PROBES` | 是否探测本机 CLI |
| `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION` | 是否允许 Code Agent 执行 |
| `AGENTHUB_CODE_AGENT_TIMEOUT_MS` | Code Agent 超时，建议开发期 `600000` |
| `AGENTHUB_ENABLE_DYNAMIC_QUICK_PROMPTS` | 是否启用模型动态生成快捷问题 |

## 工作区与产物

如果用户选择了本地工作区，AgentHub 会在该目录下写入：

```text
.agenthub/
  workdirs/{runId}/{agentName}/{taskId}/   每个 Agent 的执行目录
  handoff/{runId}/{taskId}/                可交接给下游的上游产物
```

如果没有选择工作区，系统会自动在默认工作空间存储路径下创建一个可写工作区。默认位置使用系统用户数据目录，例如 Windows 的 `%LOCALAPPDATA%\AgentHub\workspaces`，避免写进 AgentHub 源码目录。可在设置里调整默认工作区存储路径。

当前默认不再把 Git 分支隔离作为主路径，也不把本地 workdir 伪装成容器沙箱。执行层已经抽出 `SandboxProvider` 边界，当前稳定 provider 是 `local-workdir`；Docker/云沙箱可以后续接入。

`local-workdir` 会给每次任务创建系统缓存目录下的 sandbox root，并向 Code Agent 子进程注入独立 temp/cache/config 目录，用于减少 CLI 运行时污染。它不是 OS 级安全边界，不能真正限制网络或阻止进程读取任意本机路径。

需要容器隔离时可启用 Docker provider：

```env
AGENTHUB_SANDBOX_PROVIDER=docker
AGENTHUB_DOCKER_SANDBOX_IMAGE=your-code-agent-image:latest
```

Docker 镜像必须包含要运行的 Code Agent CLI。AgentHub 会把任务工作目录挂载到 `/workspace`，并把 temp/cache/config 目录单独挂载进容器。

## 数据清理

开发阶段可以使用应用内“清除所有数据”能力恢复到近似首次启动状态。执行前请确认不需要保留旧会话、旧任务和旧产物索引。

## 重要文档

- [docs/当前多Agent协作架构.md](docs/当前多Agent协作架构.md)
- [docs/多Agent协作分层架构与业内对比.md](docs/多Agent协作分层架构与业内对比.md)
- [docs/使用指南.md](docs/使用指南.md)
- [docs/AgentHub-项目全景与多Agent协作重构指南.md](docs/AgentHub-项目全景与多Agent协作重构指南.md)
- [docs/多Agent协作设计调研与优化方案.md](docs/多Agent协作设计调研与优化方案.md)
- [docs/一些资料/minimax一个agent不够.md](docs/一些资料/minimax一个agent不够.md)
- [docs/一些资料/讯飞agent_team.md](docs/一些资料/讯飞agent_team.md)

## 开发注意

- 不要恢复静态快捷提示词或固定任务模板，用户明确要求动态模型生成。
- 不要恢复 `classic` 工作区、默认代码团队、`create-from-template`、关键词 Agent 路由或自动 QA/review/follow-up 任务注入。
- 不要恢复旧的 `workspace-agent-child` 群聊入口。
- 不要把“任务失败但已有部分产物”显示成完全无产物。
- 不要让下游 Agent 假设上游相对路径存在；优先使用黑板中的 `handoffPath`。
- `runtimeType` 只应为 `code-agent` 或 `llm`；A2A/MCP/Skills 都不是 Agent 类型。
- UI 改动要保持主群聊、私聊、任务子对话的边界清晰。
