# AgentHub

AgentHub 当前的明确产品目标，不再只是“IM 式多 Agent 协作平台”，而是朝着一套 `Coze / Kimi 风格的开源 AI 工作平台` 演进。新的底层目标是 `AgentHub Product Shell + HiClaw-lite Open Kernel`：前端保留 AgentHub 自己的产品壳，底层协作内核学习 HiClaw，并尽量采用成熟开源组件。

现阶段的主交互仍然是群聊、私聊和任务子对话，但这些只是工作台的承载外壳。我们真正要做的是：

- 用户围绕一个工作目标发起协作，而不是只发起一段对话。
- Manager / Orchestrator 像团队负责人一样理解目标，决定回复、追问、补员、派活、验收和总结。
- 多个 Agent 在真实子对话里执行，并交付网页、文档、报告、代码、应用等结果资产。
- 平台逐步形成 `Space / Task Center / Asset Center / Expert Center / Eval & Trace` 的完整结构。

当前项目仍处于快速迭代阶段，近期优先目标已经从“继续补旧 A2A/DAG 流程”转向 HiClaw-lite 内核换血：先接入真实 Matrix / Tuwunel Room 通信、OpenClaw / QwenPaw Manager Runtime、Worker Runtime、MinIO/S3-compatible SharedStorage 和本地轻量 Controller/Reconciler，再逐步把产品壳、资产层和长期任务能力对齐 Coze。

如果你是第一次接手项目，先读 [docs/文档索引与权威口径.md](docs/文档索引与权威口径.md)、[docs/当前状态与下一步路线.md](docs/当前状态与下一步路线.md) 和 [docs/AgentHub-HiClaw-lite开源内核重构方案.md](docs/AgentHub-HiClaw-lite开源内核重构方案.md)。它们是当前事实总览，用来区分新主线、后续路线和历史遗留设计。Coze 对标拆解见 [docs/Coze新版本对标拆解与开源复刻路线.md](docs/Coze新版本对标拆解与开源复刻路线.md)。HiClaw 参考依据见 [docs/hiclaw-wiki.agent.final.md](docs/hiclaw-wiki.agent.final.md) 和本地 `hiclaw源码参考/`。

## 核心体验

从当前版本到目标版本，AgentHub 的体验会分两层理解：

- 当前主路径：IM 风格的多 Agent 协作工作流。
- 目标产品形态：Coze 风格的 AI 工作台与 AI 空间。

- **Agent 私聊**：用户与单个 Agent 一对一对话。
- **Agent 群聊 / 工作会话**：用户围绕目标发起协作，Manager / Orchestrator 负责理解、协调、分工、验收和总结。
- **任务子对话**：每个成员在自己的子对话里真实接收任务并执行，主群聊只展示进度和汇报。
- **Manager 行动方案**：由 Manager 模型生成团队行动方案和任务账本；DAG 只是恢复、依赖和看板视图，不是主脑。
- **Matrix 通信主线**：新内核以 Matrix Room / timeline / participant / mention 作为协作事实源。Manager 怎么 @ Worker、Worker 怎么回应、用户怎么插话，都应该在 Room 中可见。
- **A2A 外部互操作**：A2A 暂不作为内部主通信路径，只保留为外部互操作或 Matrix event 中的可选任务语义 envelope；A2A 是协议，不是 Agent 类型。
- **显式分工**：执行任务只接受 Manager / Orchestrator 的模型选择，系统不再用关键词路由、默认团队或自动 follow-up 改写分工。
- **Agent Runtime / Agent Base 执行**：OpenClaw / QwenPaw 优先作为 Manager / Team Leader 基底；Codex CLI、Claude Code、OpenCode、Gemini CLI 是主要 Worker 基底。自建 Agent 是在这些基底上配置角色、提示词、Skills/MCP 能力和权限。
- **工作目录与共享存储**：每个 Worker 有自己的工作目录和 RuntimeLease；任务契约优先发布为 `shared/tasks/{taskId}/meta.json|spec.md|plan.md|result.md` 对象引用，MinIO/S3-compatible SharedStorage 是目标主路径，本地 filesystem 只作为开发 fallback 和项目镜像。
- **产物可见**：文件、网页、diff、诊断产物进入 ArtifactStore，并从主群聊、任务 Room 和产物卡稳定投影。
- **Coze 对标方向**：后续产品层要逐步补齐 Space、Task Center、Asset Center、Expert Center、Eval / Trace、部署与长期主动任务能力。

## 当前协作路径

```text
用户在群聊发起任务
  -> Manager / Orchestrator 理解目标并决定下一步
  -> Matrix Room 记录 Human / Manager / Worker 的可见交流
  -> 复杂任务由 Manager 创建任务账本和 Task Room
  -> Manager 在 Room 中 @ Worker 分配任务
  -> WorkerRuntime 调用 Claude Code / OpenCode / Codex / Gemini 等真实执行
  -> Worker 在 Task Room 汇报进度、错误、澄清请求和 artifact refs
  -> ArtifactStore 登记产物
  -> 主群聊展示成员汇报、产物和最终总结
```

左侧会话树规则：

- “Agent 私聊”只显示真正的全局私聊。
- “群聊”显示主群聊。
- 展开群聊后只显示真实任务子对话。
- 旧的 `workspace-agent-child` 和历史占位入口不再作为当前 UI。

当前权威文档索引见 [docs/文档索引与权威口径.md](docs/文档索引与权威口径.md)。底层重构方向见 [docs/HiClaw架构调研与AgentHub底层重构方案.md](docs/HiClaw架构调研与AgentHub底层重构方案.md)。

当前主路径已经开始资源化：群聊消息先进入 Room timeline，复杂任务通过 CoordinatorRuntime / RunController 创建 run 与任务账本，RoomController 确保 group/task room，WorkerController 与 RuntimeLeaseController 管 Worker 和执行租约，WorkerRuntime 从 task room 接单并写回过程。`MatrixRoomAdapter` 已开始使用 Matrix Client-Server API 创建真实 room、发送 `m.room.message` 并记录 Matrix participant id；`LocalMatrixCompatibleRoomAdapter` 只允许作为测试/开发 fallback。后续还要继续把旧 snapshot/messages/AG-UI cache 降级为投影和兼容读取，让任务看板、进度条、子对话入口和产物卡稳定来自 Matrix timeline、资源状态与 ArtifactStore。这个方向不是照搬 HiClaw 的企业重栈，而是重点吸收 Manager、Worker、Matrix/Tuwunel、共享存储/MinIO 这四个内核模块。

## 分层定位

AgentHub 的目标不是做一个固定角色模板系统，也不只是做一个聊天壳上的编排器，而是把多 Coding Agent 协作做成可见、可控、可追踪、可交付的 AI 工作平台：

| 层 | 当前定位 |
| --- | --- |
| 产品交互层 | 群聊、私聊、任务子对话、任务看板、产物卡，并逐步进化为 Space / Task / Asset 工作台 |
| 编排层 | Manager / Orchestrator 生成团队行动方案，通过任务账本调度、取消、重试、验收和汇总 |
| 通信层 | Matrix 承载 Room / timeline / participant / mention，A2A 只保留为外部互操作或可选任务语义 envelope |
| 执行层 | OpenClaw / QwenPaw 为 Manager / Team Leader 优先基底；Codex CLI / Claude Code / OpenCode / Gemini CLI 为主要 Worker 基底；普通内部 LLM 只作非核心 fallback |
| 能力层 | MCP、Skills、Rules、shell、文件、浏览器等作为 Code Agent 能力 |
| 协作契约层 | 用户显式 Spec/Contract 描述范围、产出、验收和路径边界，不做固定场景模板 |
| 工作区与存储层 | 系统默认工作空间根 + Worker workdirs + RuntimeLease + MinIO/S3-compatible ArtifactStore / SharedStorage；本地 filesystem 只作开发 fallback |

产品北极星与 Coze 对标判断见 [docs/Coze新版本对标拆解与开源复刻路线.md](docs/Coze新版本对标拆解与开源复刻路线.md)。HiClaw-lite Kernel 方向见 [docs/HiClaw架构调研与AgentHub底层重构方案.md](docs/HiClaw架构调研与AgentHub底层重构方案.md)。

当前配置真相也分三层：

- `模型管理`：模型目录、双端点、密钥、模型测试。
- `Agent Runtimes / Agent Bases`：Claude Code、OpenCode、Codex、Gemini、OpenClaw、QwenPaw 等基底的安装状态、原生 auth/config、平台级诊断。旧界面里若仍出现 `Coding Tools`，它只是历史命名，不是架构概念。
- `Agent 配置`：唯一允许选择 `code agent × model × skills × sandbox` 组合的地方。

另有单独可见的 `内部 LLM 默认模型`，只用于欢迎页动态提示、临时诊断或非核心 fallback。Manager / Orchestrator 的目标主路径必须接 OpenClaw / QwenPaw 这类真实 Agent runtime，不能默认回退到内部 LLM 主脑。

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
| LLM | OpenAI-compatible + Anthropic-compatible streaming client，仅用于动态提示、临时诊断和非核心 fallback |
| Agent Runtime / Agent Base | Manager: OpenClaw / QwenPaw；Worker: Codex CLI / Claude Code / OpenCode / Gemini CLI，后续可补 OpenClaw / QwenPaw Worker |
| Agent 通信 | 真实 Matrix / Tuwunel Room timeline 是目标内部事实源；本地 Matrix-compatible adapter 只作测试/开发 fallback；A2A 降为外部互操作 |

## 项目结构

```text
apps/
  server/
    src/
      routes/                 HTTP API
      services/
        orchestrator/         Manager-first planning、Run/Worker 控制面、final review
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
| `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | 内部 LLM fallback 配置，不是 Manager 主路径 |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | OpenAI-compatible 配置 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` | Anthropic 配置 |
| `ENABLE_LOCAL_CLI_PROBES` | 是否探测本机 CLI |
| `AGENTHUB_ENABLE_CODE_AGENT_EXECUTION` | 是否允许 Code Agent 执行 |
| `AGENTHUB_CODE_AGENT_TIMEOUT_MS` | Code Agent 超时，建议开发期 `600000` |
| `AGENTHUB_ENABLE_DYNAMIC_QUICK_PROMPTS` | 是否启用模型动态生成快捷问题 |
| `AGENTHUB_ROOM_PROVIDER` | `matrix` 使用真实 Matrix homeserver；`local-matrix-compatible` 仅用于测试/开发 fallback |
| `AGENTHUB_MATRIX_HOMESERVER_URL` / `AGENTHUB_MATRIX_ACCESS_TOKEN` / `AGENTHUB_MATRIX_SERVER_NAME` | Matrix / Tuwunel homeserver 连接配置 |
| `AGENTHUB_OBJECT_STORE_PROVIDER` / `AGENTHUB_S3_ENDPOINT` / `AGENTHUB_S3_ACCESS_KEY_ID` / `AGENTHUB_S3_SECRET_ACCESS_KEY` / `AGENTHUB_S3_BUCKET` | MinIO/S3-compatible SharedStorage 配置 |

## 工作区与产物

如果用户选择了本地工作区，AgentHub 会在该目录下写入：

```text
.agenthub/
  workdirs/{runId}/{agentName}/{taskId}/   每个 Agent 的执行目录
  shared/tasks/{taskId}/                   spec.md / meta.json / plan.md / result.md / artifacts 协作契约镜像
  handoff/{runId}/{taskId}/                旧历史兼容路径
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
- [docs/文档索引与权威口径.md](docs/文档索引与权威口径.md)
- [docs/AgentHub-HiClaw-lite开源内核重构方案.md](docs/AgentHub-HiClaw-lite开源内核重构方案.md)
- [docs/HiClaw架构调研与AgentHub底层重构方案.md](docs/HiClaw架构调研与AgentHub底层重构方案.md)
- [docs/Coze新版本对标拆解与开源复刻路线.md](docs/Coze新版本对标拆解与开源复刻路线.md)
- [docs/使用指南.md](docs/使用指南.md)
- [docs/hiclaw-wiki.agent.final.md](docs/hiclaw-wiki.agent.final.md)
- `hiclaw源码参考/`
- [docs/Kimi-Claw群聊系统完整设计规格书(1).md](docs/Kimi-Claw群聊系统完整设计规格书%281%29.md)

`docs/archive/` 和 `docs/old/` 中的内容只作为历史参考，不作为当前工程事实。凡是与上面几份权威文档冲突的，以权威文档为准。

## 开发注意

- 不要恢复静态快捷提示词或固定任务模板，用户明确要求动态模型生成。
- 不要恢复 `classic` 工作区、默认代码团队、`create-from-template`、关键词 Agent 路由或自动 QA/review/follow-up 任务注入。
- 不要恢复旧的 `workspace-agent-child` 群聊入口。
- 不要把“任务失败但已有部分产物”显示成完全无产物。
- 不要让下游 Agent 假设上游相对路径存在；优先使用黑板中的 `handoffPath`。
- 不要把 `llm` 当作产品主路径 Agent runtime；A2A/MCP/Skills 都不是 Agent 类型。后续公开心智应收敛到 Agent Runtime / Agent Base。
- UI 改动要保持主群聊、私聊、任务子对话的边界清晰。
