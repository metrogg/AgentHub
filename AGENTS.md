# AgentHub

本文档给 AI Coding Agent 阅读。人类开发者可以先看 `README.md`，再看 `docs/文档索引与权威口径.md`、`docs/当前状态与下一步路线.md`、`docs/AgentHub-HiClaw-lite开源内核重构方案.md`、`docs/HiClaw架构调研与AgentHub底层重构方案.md`、`docs/Coze新版本对标拆解与开源复刻路线.md` 和 `docs/使用指南.md`。
`docs/hiclaw-wiki.agent.final.md` 和本地 `hiclaw源码参考/` 是本轮 HiClaw-lite 内核重构的主要架构参考；本地 `clawteam源码/ClawTeam/` 是轻量落地参考，重点学习 CLI adapter、git worktree、task lock、LeaderWatcher、profile doctor/test、board snapshot。`docs/Kimi-Claw群聊系统完整设计规格书(1).md`、`docs/Coze新版本对标拆解与开源复刻路线.md` 是重要产品参考。如果参考资料与当前工程口径冲突，以 `AGENTS.md`、`README.md`、`docs/文档索引与权威口径.md`、`docs/当前状态与下一步路线.md` 和 `docs/AgentHub-HiClaw-lite开源内核重构方案.md` 为准。

## 当前目标

AgentHub 是字节跳动 AI 全栈挑战赛项目。当前产品北极星已经进一步明确为：

- 近期运行时主路径：IM 式多 Agent 协作。
- 中期产品目标：`Coze 风格的开源 AI 工作平台`。
- 底层重构目标：`AgentHub Product Shell + HiClaw-lite Open Kernel`。

也就是说，群聊、私聊、任务子对话不是终点，而是我们当前承载复杂协作的交互外壳。核心体验不是“一个模型假装多人说话”，而是：

- 用户在群聊里提出目标。
- Manager / Orchestrator 像团队负责人一样理解目标，决定回复、追问、补员、组队、派活或总结。
- Planner 不再是主脑；结构化拆解只作为 Manager 可调用的 planning skill / action。
- 多个 Agent 在各自的任务子对话里真实执行。
- 主群聊只展示计划、进度、成员汇报、产物和最终综合结果。
- 用户可以进入任一子对话查看该 Agent 的完整执行过程。

新的内核方向不是继续修补旧 DAG-first 流程，而是：

- 前端产品壳保留 AgentHub 自己的 Coze / Kimi 风格界面。
- 通信层采用 Matrix：Room / timeline / participant / mention 是协作事实源。
- Manager Runtime 学 OpenClaw / QwenPaw：Manager 是真实协调器，不是一次性 Planner。
- Worker Runtime 学 HiClaw，但保留 AgentHub 的 Coding Agent 优势：Claude Code / OpenCode / Codex / Gemini 是核心 Worker 基底。
- 共享存储默认采用本地 filesystem，但必须按 MinIO/S3-compatible object key 语义设计；MinIO/S3 只是后续可替换 adapter，不是第一阶段默认主路径。
- AI Gateway 抽象化：短期 Local/LiteLLM，长期 Higress；不要让 Worker 到处拿真实 key。
- A2A 暂不作为内部主通信路径，只保留为外部互操作或 Matrix event 中的可选任务语义 envelope。
- 当前仍处开发阶段，旧会话、旧任务、旧数据库和旧 workspace/storage 数据不是架构约束；必要时可以清库重建，不能为了旧数据保留旧路径。

后续产品层必须逐步补齐 Coze 风格的：

- Space
- Task Center
- Asset / Library Center
- Expert / Skill Center
- Eval / Trace
- Coding / Deploy / Long-running Work

不要再引入固定场景模板，例如“网站建设 Team 模板”。当前优先做通用多 Agent 协作能力，场景增强放到后续。

角色预设可以作为“创建 Agent 时的参考库”存在，但不能作为默认团队、默认关系或执行模板自动驱动运行。新工作区默认不自动注入 Orchestrator/Researcher/Designer/Builder/QA，也不支持 `classic` 团队模板或 `create-from-template` 入口。

角色设计按“公共协作协议 + 角色背景 + 专属 Skill 包 + 任务上下文 + 输出契约”的组合模型推进。群聊目标可以用于智能推荐成员，但不能变成固定模板；已有群聊能力不足时，Orchestrator 可以提出补员申请，默认必须用户确认，不能静默拉新 Agent。

预装 Agent 模板和轻量专家团只作为 Agent 配置资产，不作为固定执行模板。可以借鉴 Claude Code subagents、BMAD、SuperClaude、awesome-cursor-skills、MCP server 生态等开源资产，但必须经过许可证、安全边界、质量和 AgentHub schema 适配；近期不做“我的专家”或完整专家市场，不要直接复制未审计 prompt 或默认启用第三方 MCP。

## 分层架构判断

修改代码前先确认自己正在改的是哪一层，不要把不同层的概念混用：

- 产品交互层：IM 群聊、Agent 私聊、任务子对话、任务看板、产物卡。
- 编排层：Manager / Orchestrator、Manager actions、WorkLedger / dependency 校验、Manager final review、人工确认和运行生命周期。
- 通信层：Matrix 负责 Room / timeline / participant / mention，是新内核的协作事实源。
- 协议投影层：AG-UI 负责运行事件到前端 UI 的桥接；A2A 只作为外部互操作或 Matrix event 中的可选任务语义 envelope，不再是内部主通信路径。
- 执行层：OpenClaw / QwenPaw 是 Manager / Team Leader 优先基底；Codex CLI、Claude Code、OpenCode、Gemini CLI 是主要 Worker Agent 基底。不要把普通内部 LLM 当作产品主路径 Agent runtime。
- 能力层：MCP、Skills、Rules、shell、文件系统、浏览器等是 Code Agent 能使用的工具能力，不是 Agent 类型。
- 工作区、存储与状态层：系统默认工作空间根、Worker workdirs、ArtifactStore / SharedStorage、本地 filesystem object store、可选 MinIO/S3 adapter、兼容旧 `.agenthub/handoff` 的只读读取、run/resource events。

配置真相也要分层：

- `模型管理`：模型目录、端点、密钥、模型测试。
- `Agent Runtimes / Agent Bases`：Claude Code、OpenCode、Codex、Gemini、OpenClaw、QwenPaw 等基底的安装状态、原生 auth/config、平台级诊断。旧 UI 里仍可能显示 `Coding Tools`，但架构口径不再把它当作 Agent 类型。
- `Agent 配置`：唯一允许选择 `code agent × model × skills × sandbox` 组合的地方。

`内部 LLM 默认模型` 只允许作为非核心体验的辅助/兜底链路，例如欢迎页动态提示或临时诊断。Manager / Orchestrator 的目标主路径必须接 OpenClaw / QwenPaw 这类真实 Agent runtime，不能默认回退到内部 LLM 主脑。

AgentHub 不应该变成纯 CrewAI 式固定角色任务模板，也不应该直接变成只有后端图编排的 LangGraph wrapper。当前产品目标是：先用 IM 产品体验承载多 Coding Agent 协作，再把它升级成 Coze 风格的 AI 工作台；用 DAG/checkpoint/event trace 等工程能力保证它可信、可看、可控。

底层重构方向已经进一步明确：建设 AgentHub 自己的轻量版 HiClaw Open Kernel，而不是继续手搓低配协作层，也不是照搬 HiClaw 的企业部署栈。HiClaw 给出 Room / Manager / Worker / Human / Storage 的正确协作范式；ClawTeam 给出更适合本地第一阶段的轻量实现技巧，例如 CLI profile、worktree 隔离、任务 claim lock、watcher 和服务端 snapshot。第一阶段产品形态是嵌入式本地控制器：AgentHub Server 仍在本机作为 Controller API / UI backend / Room adapter 运行；Tuwunel、MinIO、OpenClaw Manager、OpenClaw Worker 可通过 Docker resident runtime 承载。自研 UI 替代 Element Web，本地 filesystem 仍是默认 SharedStorage，MinIO/S3-compatible 是可切换 adapter。通信层以 Matrix Room/timeline/participant/mention 语义作为协作事实源，本地真实 Matrix 默认采用 Tuwunel，兼容连接已有 Synapse/Conduit；`TestRoomAdapter` 只允许自动化测试使用，不能作为开发/产品通信层或故障降级路径，也不能用 ClawTeam 的 file inbox 替代内部主通信。Gateway 保留 Higress/LiteLLM adapter 抽象。

四个最高优先级模块：

- Manager 协调器：对齐 HiClaw Manager 章节，Manager 要有 runtime、人格配置、skills、state、Worker registry、Room 通信和 heartbeat/patrol。
- Worker 运行时：对齐 HiClaw Worker 章节，Worker 是真实运行实体，有身份、状态、模型、skills/MCP、Room、heartbeat、sleep/wake/stop。
- Matrix 通信层：对齐 HiClaw Matrix/Tuwunel 章节，Room / timeline / participant / mention 是协作事实源；本地真实 homeserver 默认用 Tuwunel；开发和产品路径必须连接真实 Matrix homeserver，`TestRoomAdapter` 只允许自动化测试使用。
- 共享存储层：对齐 HiClaw MinIO 章节的“共享任务树/产物引用”思想，但第一阶段默认由本地 filesystem object store 实现；产物、任务契约和 handoff ref 进入 ArtifactStore / SharedStorage，object key 语义保持 S3-compatible，后续可切 MinIO/S3 adapter。
- 轻量执行可靠性：参考 ClawTeam 的 `FileTaskStore`、`WorkspaceManager`、`NativeCliAdapter`、`LeaderWatcher` 和 `Board`，补齐 Worker claim/lock、git worktree 模式、profile doctor/test、ManagerPatrol snapshot diff、服务端 run/team snapshot；这些只能作为轻量实现手段，不能替代真实 Matrix Room 通信。

目标资源：

- `Room`、`TimelineEvent`、`Run`、`Task`、`WorkerInstance`、`Artifact`、`RuntimeLease` 都应逐步成为一等资源。
- `messages.ts` 后续只应承担 chat ingress 和轻量路由，不再继续膨胀成创建 task/session/event 并启动执行的总控模块。
- 子对话、产物卡、任务看板和进度条应从 Matrix timeline、资源状态与 AG-UI 投影出来，不再靠多个旧 metadata 状态拼接。
- OpenClaw / QwenPaw 应优先作为 Orchestrator / Team Leader / Manager 这类指挥型 runtime 候选；Codex / Claude Code / OpenCode / Gemini CLI 更偏执行型 Coding Worker。不要把 OpenClaw 简单硬塞成普通 `codeAgentType`，后续应拆出 `coordinator runtime` 与 `worker runtime`。
- 第一阶段优先做 `RoomService + Matrix Adapter`、`CoordinatorRuntime`、`WorkerRuntime`、`ArtifactStore` 和 Controller/Reconciler 资源化。

详细方案见 `docs/AgentHub-HiClaw-lite开源内核重构方案.md`，三方取舍见 `docs/AgentHub-vs-HiClaw-vs-ClawTeam-对比分析报告.md`。后续涉及多 Agent 底层执行、子对话、产物、运行事件、生命周期的改动，应优先向这些方案收敛，而不是继续给旧流程链打补丁。

## 关键交互边界

### 单聊

`direct + metadata.kind === "agent-direct"` 是全局 Agent 私聊，只出现在左侧“Agent 私聊”区域。

私聊执行已完全 HiClaw 化：
- 用户消息通过 `appendHumanMessageRoomFirst` 写入 direct room timeline
- `appendHumanMessageRoomFirst` 自动调用 `MatrixEventDispatcher.dispatchTimelineEvent()`
- `MatrixEventDispatcher` 统一处理所有 room 类型，direct room human message → `WorkerRuntimeService.runDirectRoom()`
- Worker 从 room timeline 读取历史，执行 Code Agent runtime，结果写回 room timeline
- `messages` 表仅作为 UI 兼容投影，不再作为执行事实源

### 群聊

`group` 是用户和 Orchestrator/成员的主对话。主对话负责：

- 接收用户目标。
- 展示 Orchestrator 的思考、计划和调度状态。
- 展示成员任务结果汇报。
- 展示产物卡、任务看板、最终总结。

### 任务子对话

`direct + metadata.kind === "orchestrator-task"` 是群聊下的真实任务子对话。它必须：

- 绑定 `workspaceId`、`orchestratorRunId`、`orchestratorTaskId`、`taskThreadId`。
- `prepared` 阶段可以暂时没有 `workspaceAgentId`；正式分配给 Worker 后必须回填 `workspaceAgentId` / `workerInstanceId`，并同步更新对应 session metadata。
- 在左侧群聊展开后作为子项显示。
- 不出现在全局“Agent 私聊”里。
- 保存 Orchestrator 发给该 Agent 的任务提示和 Agent 真实输出。

### 已废弃入口

旧的 `workspace-agent-child`、`workspace / Agent` 历史子会话、自动补齐“未开始子会话”的 UI 都不再作为当前设计入口。不要恢复这类占位子会话，否则会造成左侧重复和真假执行混乱。

## 当前执行路径

```text
用户发消息（群聊/私聊/任务子对话统一路径）
  -> messages.ts 作为 ChatIngress 只做鉴权和写 Room timeline
  -> appendHumanMessageRoomFirst() 写入 timeline 后自动 dispatchTimelineEvent()
  -> MatrixEventDispatcher 是唯一处理入口，根据 room kind 路由：

    group room human message:
      -> MatrixEventDispatcher 检查活跃 run 并写入 human_interrupt 黑板
      -> stepManagerRoom() → ManagerLoop 判断下一步：回复、追问、补员、派活或总结
      -> 简单聊天：Manager 直接写回 group room timeline
      -> 能力不足：Manager 输出结构化 memberProposals，用户确认后才创建/加入真实 Agent
      -> 复杂任务：Manager 生成 assign actions，RunController 创建 run 生命周期
      -> dispatchCoordinatorAssignBatch() 创建 workspace_tasks / TaskThread / task room
      -> RoomController 确保 task room 和 Worker participant
      -> WorkerController 确保 WorkerInstance ready / wake / reconcile
      -> RuntimeLeaseController 创建并推进 RuntimeLease
      -> WorkerRuntimeService.runTaskRoom() 从 task room 接单并执行
      -> Worker 结果写回 task room timeline
      -> ArtifactController / ArtifactStore 登记产物
      -> RunController 同步状态并发 RunEvent / AG-UI 投影
      -> ManagerLoop 基于 timeline/ArtifactStore 做最终复盘

    direct room human message:
      -> MatrixEventDispatcher → WorkerRuntimeService.runDirectRoom()
      -> Worker 从 direct room timeline 读取历史，执行 Code Agent runtime
      -> Agent 响应写回 direct room timeline

    task room human message:
      -> MatrixEventDispatcher → WorkerRuntimeService.resumeTaskRoomAfterHumanAnswer()
      -> Worker 继续执行并写回 task room timeline

  -> messages 表仅作为 UI 兼容投影，不再作为执行事实源
```

`OrchestratorEngine`、`TaskExecutionService`、`LocalA2ATransport` 已删除。所有任务执行通过 `RunController` / `RoomController` / `WorkerController` / `RuntimeLeaseController` / `ManagerLoop` / `WorkerRuntimeService`。`messages.ts` 不应继续扩展成编排主脑。

`apps/server/src/services/controller-plane/` 是轻量 Controller Plane 第一版：`ControllerApi` 是 Manager skill / 后续 CLI/API 应调用的统一控制面门面，`ReconcileQueue` 是资源 reconcile 请求入口，`WorkerBackend` 是 Local CLI、OpenClaw/QwenPaw resident Worker、Docker runtime Worker 等 Worker backend 的 seam。Manager Runtime 不应直接 import `roomService`、`runController`、`workerController` 或 `runtimeLeaseController`。

### Docker Resident Runtime

当前已经开始把 HiClaw 式常驻 Manager / Worker 接入 Docker，但不要把它理解成“把整个 AgentHub Server 容器化”：

- AgentHub Server 仍在本机运行，负责 Controller API、Room adapter、设置页诊断和前端数据接口。
- `infra/docker-compose.hiclaw-lite.yml` 提供本地 Tuwunel 和 MinIO。
- `infra/openclaw-runtime/Dockerfile` 构建统一 OpenClaw runtime 镜像，默认 tag 是 `agenthub/openclaw-runtime:local`。
- `AGENTHUB_CONTAINER_RUNTIME=docker` 会同时启用 Manager / Worker Docker 后端；也可以分别用 `AGENTHUB_MANAGER_BACKEND=docker`、`AGENTHUB_WORKER_BACKEND=docker`。
- 容器内访问本机 Controller / Matrix / LLM gateway 默认使用 `host.docker.internal`：`AGENTHUB_CONTAINER_CONTROLLER_URL`、`AGENTHUB_CONTAINER_MATRIX_URL`、`AGENTHUB_CONTAINER_LLM_BASE_URL` 可覆盖。
- 设置页“控制台 / 本机诊断”已经能查看容器 runtime 状态、OpenClaw 镜像、Manager/Worker 容器和日志。
- Matrix server name 默认统一为 `agenthub.local`，必须和 Tuwunel compose、Manager identity、Worker identity 保持一致。

### Worker Runtime 状态机

WorkerInstance.observedState 已扩展为 HiClaw 风格状态机：

```
provisioning -> ready -> listening -> assigned -> busy -> waiting_for_human -> resuming -> idle -> sleeping -> stopped / failed
```

- `listening`：Worker Matrix listener 已启动，等待被 @ 接单。
- `assigned`：Worker 在 task room 中被 @ 后自己 claim 任务，尚未启动 CLI。
- `busy`：CLI 子进程正在执行。
- `resuming`：人类回答澄清后，Worker 恢复执行前的过渡状态。

Worker 本地 workspace 目录位于 `{agentHubUserDataRoot()}/workers/{workerInstanceId}/`，包含 `profile.json`、`SOUL.md`、`AGENTS.md`、`skills/`、`state.json`、`rooms.json`。`WorkerController.ensureReady()` 会在 reconcile 时自动创建该目录并从 DB 同步技能和配置。

### Worker Runtime Phase 2 能力

- **AbortController / 进程清理做实**：`Bun.spawn` 已绑定 `AbortSignal`；`killProcessTree()` 增强为 async，具备进程存活检测、优雅终止（SIGTERM / `taskkill /t`）、5 秒超时等待、强制终止（SIGKILL / `taskkill /t /f`）和二次等待。`WorkerRuntimeService` 维护 `runningControllers` Map，每个 task room 有独立的 `AbortController`；`/stop` 或 `cancelTaskRoom` 时调用 `stopTaskRoom()` 真正终止 CLI 子进程。
- **per-agent config/cache/session 隔离**：`RuntimeLease` 的 `homeDir/configDir/cacheDir/tmpDir/dataDir` 通过 `sandboxEnv` 注入 CLI 子进程环境变量（`HOME`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME`、`XDG_DATA_HOME`、`TMPDIR`、`TEMP`、`TMP`、`CODEX_HOME`），确保不同 Worker 的 CLI 配置和缓存互不干扰。
- **Clarification resume 原生化 + 多轮澄清链**：`runCodeAgentCommand` 支持 `continueSession` / `sessionId` 参数，Claude Code 可利用 `--session-id` / `--continue` 保持同一 CLI context。首次运行后 `sessionId` 保存到 `runtimeLeases.metadata`；resume 时从 lease 读取并传入，实现真正的会话恢复而非重启新进程。`taskClarifications` 表天然支持多轮澄清链，timeline 历史在 resume 时完整保留。

## Matrix / A2A 通信边界

新内核以 Matrix 作为内部通信事实源：

- Human、Manager、Worker 都是 Matrix Room participant。
- Manager 分配任务、@ Worker、Worker 回复、澄清、进度、失败、产物引用，都应进入 Room timeline。
- 主群聊、任务子对话、Manager/Worker DM 都应逐步变成 RoomService / MatrixRoomAdapter 管理的真实 Room。
- AgentHub 前端继续自研，不使用 Element Web 作为默认 UI。
- 当前 `MatrixRoomAdapter` 已拆出 `MatrixClient` / `MatrixIdentityService`：Controller 会为 Human、Manager、Worker 确保真实 Matrix account，持久化 `matrix_identities`，邀请/加入真实 room，并在写 timeline 时优先使用 sender participant 自己的 Matrix access token 发送 `m.room.message`。SQLite 只作为 AgentHub UI 索引和资源投影，不再被称为 Matrix 实现。
- 当前还新增了 `MatrixRuntimeListener`、`MatrixRuntimeSupervisor` 和 `MatrixRoomEventDispatcher`：可以用真实 Matrix identity token 调 `/sync`，把真实 room event 导入 AgentHub timeline，解析 `m.mentions` / 可见 `matrix.to` mention 和 `m.file/m.image/...` 文件引用，并把人类群聊消息调给 Manager、把 task room 中 @ Worker 的消息调给 WorkerRuntime。`MatrixRuntimeSupervisor` 会在 Room participant reconcile、TaskThread room reconcile、Worker ready 和 server startup recovery 时托管 Manager / Worker listener；Worker stopped / stale-failed 时会停掉对应 listener。`/sync` 临时失败会记录到 `matrix_identities.metadata.matrixSync` 并退避重试，不会让常驻 listener 直接退出。
- Matrix Room 内的基础控制消息已经接入控制面：task room 中 `/stop` / `/cancel` 会取消对应 task、释放 RuntimeLease 并写回 timeline；`/approve` / `/deny` 会作为人工控制事件进入 timeline 并触发 Manager 重新观察；`m.file/m.image/m.video/m.audio` 文件事件会优先通过 Matrix media API 下载真实 `mxc://` 内容，并物化到 ArtifactStore / MinIO/S3-compatible object store，失败时才透明降级为保留文件引用和下载错误的 `partial` artifact。下一步通信层继续补 typing/presence、人工确认与 pending proposal 的强绑定、OpenClaw/QwenPaw 原生 Matrix runtime 进程化、TokenVault，以及前端更 Matrix-sync-native 的投影；不能退回后端函数直接写伪 timeline 事件来假装 Agent 交流。
- 本地开发如需真实基础设施，先用 `infra/docker-compose.hiclaw-lite.yml` 启动 Tuwunel 和 MinIO，或在设置页点击“应用本地配置 / 启动 Tuwunel”；Matrix 配置使用 `AGENTHUB_ROOM_PROVIDER=matrix`、`AGENTHUB_MATRIX_HOMESERVER_URL`、`AGENTHUB_MATRIX_REGISTRATION_TOKEN` 等环境变量，S3/MinIO 存储使用 `AGENTHUB_OBJECT_STORE_PROVIDER=s3` 等配置。

A2A 调整为外部互操作层，不再作为第一阶段内部主通信路径：

- A2A 是通信协议，不是 runtimeType；远程 A2A endpoint 应通过 `roleProfile.protocol = "a2a"` + `roleProfile.a2aEndpoint` 配置。
- 旧 A2A envelope 可以迁移为 Matrix event 的可选 `taskEnvelope` 字段。
- 远程 Agent、外部系统调用 AgentHub Agent、跨平台互操作时再启用 A2A。
- 不允许恢复 `runtimeType = "a2a"`，也不能把 A2A 作为可创建的 Agent 类型展示给用户。

旧 `LocalA2ATransport` 和 `TaskExecutionService` 已删除。`a2a-internal.ts` 仅保留为可选 taskEnvelope 序列化工具，不再作为内部通信路径。

相关文件：

- `apps/server/src/services/protocols/a2a-internal.ts`: 可选 A2A envelope 序列化（仅外部互操作）。
- `apps/server/src/services/protocols/a2a-adapter.ts`: 对外 A2A AgentCard / Task / Artifact 映射。

## 工作目录与产物交接

当前不追求复杂 Git worktree 隔离，先保证“能干活、能看见产物、能接力”。

- 如果用户选择了项目工作区，AgentHub 使用该目录作为项目根。
- 写入型 Agent 会在项目根下创建 `.agenthub/workdirs/{runId}/{agentName}/{taskId}`。
- 每个 Agent 在自己的任务目录中执行，避免互相踩文件。
- 如果用户没有选择项目工作区，自动工作空间默认创建在系统用户数据目录下，例如 `%LOCALAPPDATA%\AgentHub\workspaces`，不能回落到 AgentHub 源码目录。
- 每个任务还会有自己的本地 sandbox root，位于系统缓存目录下的 `AgentHub/sandboxes/{runId}/{agentName-agentId}/{taskId}`，用于隔离 CLI 的 temp/cache/config 目录。
- 执行隔离通过 `SandboxProvider` 抽象承载；当前默认 provider 是 `local-workdir`，因为它最贴近本地 Coding Agent 的轻量体验。`local-workdir` 会硬化本地 workdir、temp/cache/config env 和进程生命周期，但不会提供真正的 OS 网络或文件权限沙箱。`docker-sandbox` 是可选隔离层，只有在用户/策略明确启用且 `sandboxRunnable=true` 时才作为执行 provider。
- 当前新任务会创建 `.agenthub/shared/tasks/{taskId}/`，其中 `meta.json`、`spec.md`、`plan.md`、`result.md` 和 `artifacts/` 构成本次任务的共享协作空间。
- 上游可交接文件优先复制到 `.agenthub/shared/tasks/{taskId}/artifacts/...`，`.agenthub/handoff/{runId}/{taskId}/...` 只作为旧历史路径或兼容别名处理。
- 下游 Agent 只能优先读取黑板中明确给出的 `handoffPath`。
- 如果黑板只有 `filePath/path`，那只是上游记录，不能假设它存在于当前执行目录。

不要让下游 Agent 读取自己目录里臆造的相对路径，例如 `design/website-design-spec.md`，除非该文件真实存在或黑板给出 `handoffPath`。

## Code Agent 适配

统一入口在 `apps/server/src/services/code-agent-adapter.ts` 和 `apps/server/src/services/runtime/code-agent-runtime.ts`。

支持的本地 CLI：

- Codex CLI
- Claude Code
- OpenCode
- Gemini CLI

注意：

- 失败提示必须使用实际 adapter 名称，不要把 OpenCode 的错误写成 Codex CLI。
- CLI 可能已经生成了部分文件，但最后因为构建、验证、模型或 Base URL 失败而返回失败状态。此时要显示“部分产物已保留”，不要说“没有任何产物”。
- `AGENTHUB_CODE_AGENT_TIMEOUT_MS` 默认建议为 `600000`，即十分钟。
- MCP、Skills、Rules 是 Code Agent 的能力层，不是独立 runtimeType。
- Code Agent 的用户可选沙箱只保留 `workspace-write` 和 `danger-full-access`；不要再恢复 `read-only` 作为公开 code-agent 配置项。

“支持用户自建 Agent”指的是用户在这些 Coding Agent 基底上创建专家角色：设置名称、角色说明、系统提示词、工具权限、Skills/MCP 能力、沙箱策略和上下文策略。不要把它理解成新增一个普通 LLM 类型的聊天机器人。

## 数据模型要点

主要表：

- `sessions`: `direct` / `group` 会话，依赖 `metadata.kind` 区分私聊、群聊任务子对话和旧会话。
- `messages`: 迁移期 UI projection/cache。新发送主路径先写 `timeline_events`，再生成 `room:{timelineEventId}` 兼容消息；不要把它当通信事实源。
- `workspaces`: 项目工作区。
- `workspace_agents`: 工作区成员。
- `workspace_tasks`: DAG 任务、状态、进度、子会话、产物。
- `orchestrator_runs`: Orchestrator 调度生命周期。
- `blackboard_entries`: Agent 之间共享的结构化黑板。
- `execution_logs`: 执行追踪、工具调用、错误和 token 记录。

## 前端会话树规则

相关文件：

- `apps/web/src/lib/sessionTree.ts`
- `apps/web/src/components/chat/SessionList.tsx`
- `apps/web/src/stores/chatStore.ts`
- `apps/web/src/lib/ws.ts`

规则：

- “Agent 私聊”只显示 `agent-direct`。
- “群聊”显示 group parent。
- 群聊展开后只显示真实 `orchestrator-task` 子对话。
- 不再自动补齐 workspace member 占位入口。
- 不再显示 `workspace-agent-child` 旧设计入口。
- WebSocket 需要同时订阅主群聊和当前子对话，避免进度丢失。

## 常用命令

```bash
bun install
bun run dev
bun run dev:server
bun run dev:web
bun run typecheck
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck
bun test
bun test tests/orchestrator-routing.test.ts
```

## 开发约束

- 新增路由使用 `AppError`，不要继续新增裸 `HTTPException`。
- 日志使用 `apps/server/src/lib/logger.ts`，不要新增 `console.log`。
- 对复杂目标的意图判断、分工、追加任务和最终内容生成必须来自 Manager / Orchestrator / final-review skill 的模型输出；系统代码只做 schema 校验、权限校验、状态记录和透明错误呈现。
- Manager / Orchestrator 决策输出解析失败时要透明报错或提示检查模型配置，不允许用关键词启发式兜底成 `plan/reply/clarify`。
- 运行中补员只能来自 Orchestrator 明确输出的 `memberProposals`；前端只展示确认卡，后端只按用户确认创建/加入真实 workspace agent。
- 不要恢复静态兜底提示词或固定模板计划。快速提示、任务拆解、协作计划都应由模型动态生成；失败时可以提示用户重试或检查模型配置。
- 不要恢复静态 Agent 路由、关键词分工、自动 Researcher 注入、自动 QA/review/follow-up 任务注入。系统只能校验 Manager / Orchestrator 的显式选择，不能偷偷改派或追加任务。
- 不要恢复内置 `.agenthub/specs/*.spec.yml` 场景模板，也不要让 `ensureHarnessPresets()` 把 specs 自动复制到新工作区。Spec 后续只可作为用户显式创建的协作契约。
- 不要把旧 `GroupChatManager` 作为新路径入口。群聊统一从 `messages.ts` 作为 ChatIngress 进入 Room-first / Manager / Run 主线。
- 不要把旧 Git 分支隔离写成当前默认事实。当前默认是项目工作区 + `.agenthub/workdirs` + `.agenthub/shared/tasks`，`.agenthub/handoff` 只是兼容旧路径。
- 修改 UI 时要保持 IM 产品感：左侧树清晰、主群聊和子对话不重复、运行状态可见、产物入口明确。

## 重要文件

- `apps/server/src/routes/messages.ts`: ChatIngress，负责鉴权、Room-first 写入入口、`messages` 兼容投影读取和进入 Manager/Run 主线；不要继续扩成编排主脑。
- `apps/server/src/services/orchestrator/manager-loop.ts`: Manager observe/act/review loop。
- `apps/server/src/services/controller-plane/controller-api.ts`: Manager skill 和后续 Controller API 的统一控制面门面。
- `apps/server/src/services/controller-plane/reconcile-queue.ts`: 轻量资源 reconcile queue，当前为内存实现。
- `apps/server/src/services/controller-plane/worker-backend.ts`: WorkerBackend seam，当前默认 Local CLI backend。
- `apps/server/src/services/coordinator-runtime/assign-dispatcher.ts`: Coordinator assign 到 Run/TaskThread/task room/WorkerRuntime 的派发入口。
- `apps/server/src/services/orchestrator/run-controller.ts`: Run 与 task 生命周期控制面。
- `apps/server/src/services/rooms/room-controller.ts`: group/task room 与 participant reconcile 控制面。
- `apps/server/src/services/rooms/matrix-runtime-supervisor.ts`: Manager / Worker Matrix listener 生命周期托管；Room participant reconcile、TaskThread room reconcile、Worker ready 和服务启动恢复会通过它启动监听。
- `apps/server/src/services/rooms/matrix-event-dispatcher.ts`: 真实 Matrix `/sync` 导入事件的调度入口；处理群聊人类消息、task room @ Worker、`/stop`、`/approve` / `/deny` 和 Matrix 文件引用。
- `apps/server/src/services/orchestrator/worker-controller.ts`: WorkerInstance reconcile 与 lease 分配控制面。
- `apps/server/src/services/orchestrator/runtime-lease-controller.ts`: RuntimeLease 生命周期控制面。
- `apps/server/src/services/worker-runtime/worker-runtime-service.ts`: 当前 Worker task room 执行入口。
- `apps/server/src/services/worker-runtime/worker-workspace.ts`: Worker 本地 workspace 目录管理（profile/SOUL/skills）。
- `apps/server/src/services/orchestrator/manager-planner.ts`: Manager-first 团队行动方案生成。
- `apps/server/src/services/orchestrator/planner.ts`: 旧 Planner 兼容与计划校验工具来源，不是主脑。
- `apps/server/src/services/execution/agent-workdir.ts`: Agent 工作目录。
- `apps/server/src/services/blackboard.ts`: 黑板。
- `apps/server/src/services/code-agent-adapter.ts`: CLI 适配。
- `apps/web/src/components/chat/TaskBoard.tsx`: 任务看板。
- `apps/web/src/components/chat/SessionList.tsx`: 左侧会话树。
- `apps/web/src/stores/chatStore.ts`: 聊天状态和 WS 事件消费。

<br />
