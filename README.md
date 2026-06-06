# AgentHub

AgentHub 当前的明确产品目标，不再只是“IM 式多 Agent 协作平台”，而是朝着一套 `Coze / Kimi 风格的开源 AI 工作平台` 演进。新的底层目标是 `AgentHub Product Shell + HiClaw-lite Open Kernel`：前端保留 AgentHub 自己的产品壳，底层协作内核学习 HiClaw，并尽量采用成熟开源组件。

现阶段的主交互仍然是群聊、私聊和任务子对话，但这些只是工作台的承载外壳。我们真正要做的是：

- 用户围绕一个工作目标发起协作，而不是只发起一段对话。
- Manager / Orchestrator 像团队负责人一样理解目标，决定回复、追问、补员、派活、验收和总结。
- 多个 Agent 在真实子对话里执行，并交付网页、文档、报告、代码、应用等结果资产。
- 平台逐步形成 `Space / Task Center / Asset Center / Expert Center / Eval & Trace` 的完整结构。

当前项目仍处于快速迭代阶段，近期优先目标已经从“继续补旧 A2A/DAG 流程”转向轻量版 HiClaw 内核换血：保留 HiClaw 的 Room / Manager / Worker / HITL 架构范式，但产品形态采用嵌入式本地控制器：AgentHub Server 仍在本机作为 Controller API / UI backend / Room adapter 运行，Tuwunel、MinIO、OpenClaw Manager、OpenClaw Worker 可通过 Docker resident runtime 承载。自研 UI 替代 Element Web，本地 filesystem SharedStorage 仍是默认产物存储，MinIO/S3-compatible 是可切换 adapter。ClawTeam 作为轻量实现参考，用来学习 CLI adapter/profile、git worktree、task lock、LeaderWatcher 和 board snapshot 这些更适合本地第一阶段落地的做法，但不替代真实 Matrix 主通信层。产品壳、资产层和长期任务能力继续对齐 Coze。

如果你是第一次接手项目，先读 [docs/文档索引与权威口径.md](docs/文档索引与权威口径.md)、[docs/当前状态与下一步路线.md](docs/当前状态与下一步路线.md) 和 [docs/AgentHub-HiClaw-lite开源内核重构方案.md](docs/AgentHub-HiClaw-lite开源内核重构方案.md)。它们是当前事实总览，用来区分新主线、后续路线和历史遗留设计。Coze 对标拆解见 [docs/Coze新版本对标拆解与开源复刻路线.md](docs/Coze新版本对标拆解与开源复刻路线.md)。HiClaw 参考依据见 [docs/hiclaw-wiki.agent.final.md](docs/hiclaw-wiki.agent.final.md) 和本地 `hiclaw源码参考/`；HiClaw / ClawTeam / AgentHub 的三方取舍见 [docs/AgentHub-vs-HiClaw-vs-ClawTeam-对比分析报告.md](docs/AgentHub-vs-HiClaw-vs-ClawTeam-对比分析报告.md) 和本地 `clawteam源码/ClawTeam/`。

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
- **Agent Runtime / Agent Base 执行**：OpenClaw / QwenPaw 优先作为 Manager / Team Leader 基底；OpenClaw 也可以作为 resident Worker 基底；Codex CLI、Claude Code、OpenCode、Gemini CLI 是主要 Worker bridge 基底。自建 Agent 是在这些基底上配置角色、提示词、模型绑定、Skills/MCP 能力和权限。
- **工作目录与共享存储**：每个 Worker 有自己的工作目录和 RuntimeLease；任务契约优先发布为 `shared/tasks/{taskId}/meta.json|spec.md|plan.md|result.md` 对象引用。默认 SharedStorage 是本地 filesystem object store，但 object key 语义保持 S3-compatible，后续可替换为 MinIO/S3。
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

当前主路径已经开始资源化：群聊/私聊/任务子对话的新消息先进入 Room timeline / Matrix，API 和前端再从 timeline 投影出可见消息；`messages` 只保留旧会话历史只读兼容，不再为新消息写投影缓存。复杂任务通过 ManagerRuntime / RunController 创建 run 与任务账本，RoomController 确保 group/task room，WorkerController 与 RuntimeLeaseController 管 Worker 和执行租约，WorkerRuntime 从 task room 接单并写回过程。`MatrixRoomAdapter` 已接入 Matrix Client-Server API，并新增 `matrix_identities`：Human、Manager、Worker 会被确保为真实 Matrix account，Controller 负责 invite/join，timeline 发送会优先使用 sender participant 自己的 Matrix access token，而不是由后端统一 app token 假装所有人发言。`MatrixRuntimeListener` 现在可以用真实 identity token 调 `/sync`，导入真实 room event、解析 `m.mentions` / `matrix.to` mention 和 Matrix 文件引用，并提供可 start/stop 的最小轮询 lifecycle；`MatrixRoomEventDispatcher` 会把人类群聊消息调给 Manager，把 task room 中 @ Worker 的消息调给 WorkerRuntime。自动化测试使用独立的 test room adapter，但开发和产品路径必须连接真实 Matrix homeserver。编辑、清空、撤回、重发关联撤回、重新生成关联撤回和 pin/unpin 已先写入 Room timeline 的 append-only `message.*` 控制事件，再由投影层解释当前显示状态。后续要继续把旧 snapshot/AG-UI cache 降级为历史/调试页读取，让任务看板、进度条、子对话入口和产物卡稳定来自 Matrix timeline、资源状态与 ArtifactStore。这个方向不是照搬 HiClaw 的企业重栈，而是重点吸收 Manager、Worker、Matrix/Tuwunel、共享存储/MinIO 这四个内核模块。

## 分层定位

AgentHub 的目标不是做一个固定角色模板系统，也不只是做一个聊天壳上的编排器，而是把多 Coding Agent 协作做成可见、可控、可追踪、可交付的 AI 工作平台：

| 层 | 当前定位 |
| --- | --- |
| 产品交互层 | 群聊、私聊、任务子对话、任务看板、产物卡，并逐步进化为 Space / Task / Asset 工作台 |
| 编排层 | Manager / Orchestrator 生成团队行动方案，通过任务账本调度、取消、重试、验收和汇总 |
| 通信层 | Matrix 承载 Room / timeline / participant / mention，A2A 只保留为外部互操作或可选任务语义 envelope |
| 执行层 | OpenClaw / QwenPaw 为 Manager / Team Leader 优先基底；OpenClaw 可作为 resident Worker；Codex CLI / Claude Code / OpenCode / Gemini CLI 为主要 Worker bridge 基底；普通内部 LLM 只作非核心 fallback |
| 能力层 | MCP、Skills、Rules、shell、文件、浏览器等作为 Code Agent 能力 |
| 协作契约层 | 用户显式 Spec/Contract 描述范围、产出、验收和路径边界，不做固定场景模板 |
| 工作区与存储层 | 系统默认工作空间根 + Worker workdirs + RuntimeLease + filesystem-first ArtifactStore / SharedStorage；MinIO/S3-compatible adapter 后续可替换接入 |

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
| Agent Runtime / Agent Base | Manager: OpenClaw / QwenPaw；Worker: OpenClaw resident Worker、Codex CLI / Claude Code / OpenCode / Gemini CLI bridge，后续可补 QwenPaw Worker |
| Agent 通信 | 真实 Matrix / Tuwunel Room timeline 是目标内部事实源；test room adapter 只用于自动化测试；A2A 降为外部互操作 |

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

### 推荐运行模式

**默认轻量开发模式**

适合先打开 UI、调前端、检查基础群聊和设置页。需要 Docker Desktop，因为当前通信层默认连接真实 Tuwunel：

```bash
bun install
bun run infra:up
bun run dev
```

打开 `http://localhost:5173` 后，进入“设置 -> 控制台”，检查 Matrix、Controller Plane、Manager Runtime、容器运行时和执行隔离状态。

当前操作流程不应该比普通本地开发更复杂：先启动 `bun run infra:up`，再启动 `bun run dev`，随后在 AgentHub UI 里创建群聊、加入 Manager / Worker，并在房间里直接 @ 他们。后端会负责确保 Matrix 身份、Room membership、OpenClaw 配置、listener 或 resident 进程。所谓 resident runtime 指 Manager / Worker 各自有长期运行的 OpenClaw gateway 进程或容器，用自己的 Matrix account 监听房间；不是每次收到消息才临时启动一次 CLI。OpenClaw Manager / Worker 生成的 `openclaw.json` 会显式声明 `agents.list` 默认身份，避免 OpenClaw 落到默认 `main` agent 导致头像、名字和责任串台。

创建 Worker 时必须显式绑定模型，或在环境变量中提供 `AGENTHUB_WORKER_LLM_MODEL` / `LLM_MODEL`。`runtimeBase=opencode`、`runtimeBase=claude-code`、`runtimeBase=codex`、`runtimeBase=gemini` 这类 Worker 当前仍是 AgentHub-managed bridge；`runtimeBase=openclaw` 才是 resident Worker 方向。设置页“控制台”里的 Manager Runtime、Matrix、Controller Plane、Worker runtime 和容器诊断是当前排查入口。

**HiClaw-lite 容器 resident runtime 模式**

适合验证 OpenClaw Manager / Worker 作为常驻容器运行。AgentHub Server 仍在本机跑，Docker 只承载 Tuwunel、MinIO、OpenClaw Manager 和 OpenClaw Worker：

```bash
bun run infra:up
docker build -t agenthub/openclaw-runtime:local -f infra/openclaw-runtime/Dockerfile .
```

然后在 `.env` 中设置：

```env
AGENTHUB_ROOM_PROVIDER=matrix
AGENTHUB_MATRIX_HOMESERVER_URL=http://127.0.0.1:6167
AGENTHUB_MATRIX_SERVER_NAME=agenthub.local
AGENTHUB_MATRIX_REGISTRATION_TOKEN=agenthub-dev-registration-token

AGENTHUB_CONTAINER_RUNTIME=docker
AGENTHUB_CONTAINER_MATRIX_URL=http://host.docker.internal:6167
AGENTHUB_OPENCLAW_RUNTIME_IMAGE=agenthub/openclaw-runtime:local
```

`AGENTHUB_CONTAINER_CONTROLLER_URL` 和 `AGENTHUB_CONTAINER_LLM_BASE_URL` 可以留空；AgentHub 会按当前实际 Server 端口生成 `host.docker.internal` URL。如果你固定了端口或反向代理，再显式填写。重启 `bun run dev`。环境变量不会在已启动的 Server 进程里自动生效。

也可以在设置页“控制台 -> 容器运行时控制面”点击“准备本地容器运行时”，它会启动 Tuwunel / MinIO 并确保 OpenClaw runtime 镜像可用；随后复制页面给出的环境变量，写入 `.env` 后重启 Server。

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
| `AGENTHUB_ROOM_PROVIDER` | 固定使用 `matrix`；开发和产品路径都连接真实 Matrix homeserver |
| `AGENTHUB_MATRIX_HOMESERVER_URL` / `AGENTHUB_MATRIX_ACCESS_TOKEN` / `AGENTHUB_MATRIX_SERVER_NAME` | Matrix / Tuwunel homeserver 连接配置 |
| `AGENTHUB_MATRIX_LISTENER_POLL_INTERVAL_MS` / `AGENTHUB_MATRIX_LISTENER_TIMEOUT_MS` | Manager / Worker Matrix listener 轮询与 long-poll 超时配置 |
| `AGENTHUB_OBJECT_STORE_PROVIDER` / `AGENTHUB_S3_ENDPOINT` / `AGENTHUB_S3_ACCESS_KEY_ID` / `AGENTHUB_S3_SECRET_ACCESS_KEY` / `AGENTHUB_S3_BUCKET` | MinIO/S3-compatible SharedStorage 配置 |
| `AGENTHUB_CONTAINER_RUNTIME=docker` | 同时启用 Manager / Worker Docker resident runtime 后端 |
| `AGENTHUB_MANAGER_BACKEND=docker` / `AGENTHUB_WORKER_BACKEND=docker` | 分别启用 Manager 或 Worker 容器后端 |
| `AGENTHUB_CONTAINER_CONTROLLER_URL` / `AGENTHUB_CONTAINER_MATRIX_URL` / `AGENTHUB_CONTAINER_LLM_BASE_URL` | 容器内访问 AgentHub Controller、Matrix homeserver 和 LLM gateway 的 URL，默认使用 `host.docker.internal` |
| `AGENTHUB_OPENCLAW_RUNTIME_IMAGE` | OpenClaw runtime 镜像名，默认 `agenthub/openclaw-runtime:local` |

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
- [docs/AgentHub-vs-HiClaw-vs-ClawTeam-对比分析报告.md](docs/AgentHub-vs-HiClaw-vs-ClawTeam-对比分析报告.md)
- [docs/Coze新版本对标拆解与开源复刻路线.md](docs/Coze新版本对标拆解与开源复刻路线.md)
- [docs/使用指南.md](docs/使用指南.md)
- [docs/hiclaw-wiki.agent.final.md](docs/hiclaw-wiki.agent.final.md)
- `hiclaw源码参考/`
- `clawteam源码/ClawTeam/`
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
