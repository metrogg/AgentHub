# AgentHub

AgentHub 当前的明确产品目标，不再只是“IM 式多 Agent 协作平台”，而是朝着一套 `Coze 风格的开源 AI 工作平台` 演进。

现阶段的主交互仍然是群聊、私聊和任务子对话，但这些只是工作台的承载外壳。我们真正要做的是：

- 用户围绕一个工作目标发起协作，而不是只发起一段对话。
- Orchestrator 动态理解目标、规划任务、调度多个 Coding Agent。
- 多个 Agent 在真实子对话里执行，并交付网页、文档、报告、代码、应用等结果资产。
- 平台逐步形成 `Space / Task Center / Asset Center / Expert Center / Eval & Trace` 的完整结构。

当前项目仍处于快速迭代阶段，近期优先目标是先把“群聊主线 + A2A 任务分发 + 多 Agent 任务子对话 + 本地工作目录 + 产物交接”闭环跑稳，再逐步把产品壳、资产层和长期任务能力对齐 Coze。

如果你是第一次接手项目，先读 [docs/当前状态与下一步路线.md](docs/当前状态与下一步路线.md)。它是当前事实总览，用来区分主路径、后续路线和历史遗留设计。Coze 对标拆解见 [docs/Coze新版本对标拆解与开源复刻路线.md](docs/Coze新版本对标拆解与开源复刻路线.md)。底层重构方向见 [docs/HiClaw架构调研与AgentHub底层重构方案.md](docs/HiClaw架构调研与AgentHub底层重构方案.md)。

## 核心体验

从当前版本到目标版本，AgentHub 的体验会分两层理解：

- 当前主路径：IM 风格的多 Agent 协作工作流。
- 目标产品形态：Coze 风格的 AI 工作台与 AI 空间。

- **Agent 私聊**：用户与单个 Agent 一对一对话。
- **Agent 群聊 / 工作会话**：用户围绕目标发起协作，Orchestrator 负责理解、规划、分工和总结。
- **任务子对话**：每个成员在自己的子对话里真实接收任务并执行，主群聊只展示进度和汇报。
- **动态任务 DAG**：由模型生成计划，按依赖顺序执行，不使用固定场景模板。
- **A2A 通信标准**：Orchestrator 给成员分发任务时统一生成 A2A v0.3 `message/send`，A2A 是通信协议，不是 Agent 类型。
- **显式分工**：执行任务只接受 Orchestrator/Planner 的模型指派，系统不再用关键词路由、默认团队或自动 follow-up 改写分工。
- **Code Agent 执行**：统一适配 Codex CLI、Claude Code、OpenCode、Gemini CLI；自建 Agent 是在这些 Coding Agent 基底上配置角色、提示词、Skills/MCP 能力和权限。
- **工作目录与共享任务目录**：每个 Agent 有自己的工作目录，每个任务有 `.agenthub/shared/tasks/{taskId}` 协作空间，上游产物优先通过 `artifacts/` 交给下游；`.agenthub/handoff` 仅保留兼容旧路径。
- **产物可见**：文件、网页、diff、诊断产物会进入消息 metadata 和任务看板。
- **Coze 对标方向**：后续产品层要逐步补齐 Space、Task Center、Asset Center、Expert Center、Eval / Trace、部署与长期主动任务能力。

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

更详细的当前架构见 [docs/当前多Agent协作架构.md](docs/当前多Agent协作架构.md)，分层和业内对比见 [docs/多Agent协作分层架构与业内对比.md](docs/多Agent协作分层架构与业内对比.md)，Spec Kit 契约化与 AG-UI 收敛路线见 [docs/SpecKit契约与AGUI事件落地路线.md](docs/SpecKit契约与AGUI事件落地路线.md)。

当前路径仍然偏过程式：消息入口会创建 run/task/session 并启动编排器。后续底层要向 HiClaw-lite Kernel 收敛：`Run`、`Task`、`TaskThread`、`WorkerInstance`、`Artifact`、`RuntimeLease`、`RunEvent` 都成为一等资源；任务看板、进度条、子对话入口和产物卡从资源状态与 AG-UI / RunEvent 投影出来。这个方向不是照搬 HiClaw 的 Matrix / MinIO / Kubernetes 重栈，而是吸收它的资源控制平面和生命周期设计。

## 分层定位

AgentHub 的目标不是做一个固定角色模板系统，也不只是做一个聊天壳上的编排器，而是把多 Coding Agent 协作做成可见、可控、可追踪、可交付的 AI 工作平台：

| 层 | 当前定位 |
| --- | --- |
| 产品交互层 | 群聊、私聊、任务子对话、任务看板、产物卡，并逐步进化为 Space / Task / Asset 工作台 |
| 编排层 | Orchestrator 动态规划 DAG，调度、取消、重试、汇总 |
| 通信协议层 | A2A 承载 Agent 间 message/task/artifact，AG-UI 承载运行事件到 UI |
| 执行层 | Codex CLI / Claude Code / OpenCode / Gemini CLI 为主要 Agent 基底，LLM 为内部/兜底 |
| 能力层 | MCP、Skills、Rules、shell、文件、浏览器等作为 Code Agent 能力 |
| 协作契约层 | 用户显式 Spec/Contract 描述范围、产出、验收和路径边界，不做固定场景模板 |
| 工作区层 | 系统默认工作空间根 + 项目根 + `.agenthub/workdirs` + `.agenthub/shared/tasks` + 兼容 `.agenthub/handoff` + blackboard |

完整分层和业内方案对比见 [docs/多Agent协作分层架构与业内对比.md](docs/多Agent协作分层架构与业内对比.md)。产品北极星与 Coze 对标判断见 [docs/Coze新版本对标拆解与开源复刻路线.md](docs/Coze新版本对标拆解与开源复刻路线.md)。

当前配置真相也分三层：

- `模型管理`：模型目录、双端点、密钥、模型测试。
- `Coding Tools`：CLI 安装状态、原生 auth/config、平台级诊断。
- `Agent 配置`：唯一允许选择 `code agent × model × skills × sandbox` 组合的地方。

另有单独可见的 `内部 LLM 默认模型`，只用于欢迎页动态提示、Orchestrator / Planner / Synthesizer 等内部模型调用。

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

当前默认不再把 Git 分支隔离作为主路径，也不把本地 workdir 伪装成容器沙箱。执行层已经抽出 `SandboxProvider` 边界，当前默认 provider 是 `local-workdir`；Docker Sandboxes 作为可选增强隔离路径，需要在设置中显式切换并完成初始化。

对于 Code Agent，当前用户可选沙箱只保留 `workspace-write` 和 `danger-full-access`。不要再把 `read-only` 当作公开的 code-agent 配置选项。

如需临时回退到本地工作目录隔离，可显式设置：

```env
AGENTHUB_SANDBOX_PROVIDER=local-workdir
```

`local-workdir` 会给每次任务创建系统缓存目录下的 sandbox root，并向 Code Agent 子进程注入独立 temp/cache/config 目录，用于减少 CLI 运行时污染。它不是 OS 级安全边界，不能真正限制网络或阻止进程读取任意本机路径。

## 数据清理

开发阶段可以使用应用内“清除所有数据”能力恢复到近似首次启动状态。执行前请确认不需要保留旧会话、旧任务和旧产物索引。

## 重要文档

- [docs/当前状态与下一步路线.md](docs/当前状态与下一步路线.md)
- [docs/当前多Agent协作架构.md](docs/当前多Agent协作架构.md)
- [docs/多Agent协作分层架构与业内对比.md](docs/多Agent协作分层架构与业内对比.md)
- [docs/使用指南.md](docs/使用指南.md)
- [docs/SpecKit契约与AGUI事件落地路线.md](docs/SpecKit契约与AGUI事件落地路线.md)
- [docs/功能设计文档.md](docs/功能设计文档.md)
- [docs/技术实现补充文档.md](docs/技术实现补充文档.md)
- [docs/一些资料/minimax一个agent不够.md](docs/一些资料/minimax一个agent不够.md)
- [docs/一些资料/讯飞agent_team.md](docs/一些资料/讯飞agent_team.md)

`docs/archive/` 和 `docs/old/` 中的内容只作为历史参考，不作为当前工程事实。凡是与上面几份权威文档冲突的，以权威文档为准。

## 开发注意

- 不要恢复静态快捷提示词或固定任务模板，用户明确要求动态模型生成。
- 不要恢复 `classic` 工作区、默认代码团队、`create-from-template`、关键词 Agent 路由或自动 QA/review/follow-up 任务注入。
- 不要恢复旧的 `workspace-agent-child` 群聊入口。
- 不要把“任务失败但已有部分产物”显示成完全无产物。
- 不要让下游 Agent 假设上游相对路径存在；优先使用黑板中的 `handoffPath`。
- `runtimeType` 只应为 `code-agent` 或 `llm`；A2A/MCP/Skills 都不是 Agent 类型。
- UI 改动要保持主群聊、私聊、任务子对话的边界清晰。
