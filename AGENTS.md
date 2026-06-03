# AgentHub

本文档给 AI Coding Agent 阅读。人类开发者可以先看 `README.md`，再看 `docs/文档索引与权威口径.md`、`docs/当前状态与下一步路线.md`、`docs/AgentHub-HiClaw-lite开源内核重构方案.md`、`docs/HiClaw架构调研与AgentHub底层重构方案.md`、`docs/Coze新版本对标拆解与开源复刻路线.md` 和 `docs/使用指南.md`。
`docs/hiclaw-wiki.agent.final.md` 和本地 `hiclaw源码参考/` 是本轮 HiClaw-lite 内核重构的主要参考依据；`docs/Kimi-Claw群聊系统完整设计规格书(1).md`、`docs/Coze新版本对标拆解与开源复刻路线.md` 是重要产品参考。如果参考资料与当前工程口径冲突，以 `AGENTS.md`、`README.md`、`docs/文档索引与权威口径.md`、`docs/当前状态与下一步路线.md` 和 `docs/AgentHub-HiClaw-lite开源内核重构方案.md` 为准。

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
- 共享存储第一阶段使用本地 filesystem，但按 MinIO/S3-compatible 语义设计 ArtifactStore / SharedStorage。
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
- 编排层：Manager / Orchestrator、Manager actions、WorkLedger / Task graph、TaskScheduler、Synthesizer、人工确认和运行生命周期。
- 通信层：Matrix 负责 Room / timeline / participant / mention，是新内核的协作事实源。
- 协议投影层：AG-UI 负责运行事件到前端 UI 的桥接；A2A 只作为外部互操作或 Matrix event 中的可选任务语义 envelope，不再是内部主通信路径。
- 执行层：Codex CLI、Claude Code、OpenCode、Gemini CLI 是主要 Agent 基底；`llm` 只作为内部/兜底能力。
- 能力层：MCP、Skills、Rules、shell、文件系统、浏览器等是 Code Agent 能使用的工具能力，不是 Agent 类型。
- 工作区、存储与状态层：系统默认工作空间根、Worker workdirs、ArtifactStore / SharedStorage、本地 filesystem adapter、兼容旧 `.agenthub/handoff` 的只读读取、run/resource events。

配置真相也要分层：

- `模型管理`：模型目录、端点、密钥、模型测试。
- `Coding Tools`：CLI 安装状态、原生 auth/config、平台级诊断。
- `Agent 配置`：唯一允许选择 `code agent × model × skills × sandbox` 组合的地方。

`内部 LLM 默认模型` 必须保持可见，且只作用于欢迎页动态提示、Manager / Orchestrator、planning skill、Synthesizer 等内部模型链路。

AgentHub 不应该变成纯 CrewAI 式固定角色任务模板，也不应该直接变成只有后端图编排的 LangGraph wrapper。当前产品目标是：先用 IM 产品体验承载多 Coding Agent 协作，再把它升级成 Coze 风格的 AI 工作台；用 DAG/checkpoint/event trace 等工程能力保证它可信、可看、可控。

底层重构方向已经进一步明确：建设 AgentHub 自己的 HiClaw-lite Open Kernel，而不是继续手搓低配协作层。第一阶段不默认引入 Kubernetes、完整 MinIO 集群、完整 Higress 集群、企业多租户等重能力，但通信层明确采用 Matrix，存储层按 S3-compatible 设计，Gateway 保留 Higress/LiteLLM adapter 抽象。

四个最高优先级模块：

- Manager 协调器：对齐 HiClaw Manager 章节，Manager 要有 runtime、人格配置、skills、state、Worker registry、Room 通信和 heartbeat/patrol。
- Worker 运行时：对齐 HiClaw Worker 章节，Worker 是真实运行实体，有身份、状态、模型、skills/MCP、Room、heartbeat、sleep/wake/stop。
- Matrix 通信层：对齐 HiClaw Matrix/Tuwunel 章节，Room / timeline / participant / mention 是协作事实源。
- 共享存储层：对齐 HiClaw MinIO 章节，第一阶段用 filesystem，但语义按 MinIO/S3 设计，产物和 handoff ref 进入 ArtifactStore / SharedStorage。

目标资源：

- `Room`、`TimelineEvent`、`Run`、`Task`、`WorkerInstance`、`Artifact`、`RuntimeLease` 都应逐步成为一等资源。
- `messages.ts` 后续只应承担 chat ingress 和轻量路由，不再继续膨胀成创建 task/session/event 并启动执行的总控模块。
- 子对话、产物卡、任务看板和进度条应从 Matrix timeline、资源状态与 AG-UI 投影出来，不再靠多个旧 metadata 状态拼接。
- OpenClaw / CoPaw 应优先作为 Orchestrator / Team Leader / Manager 这类指挥型 runtime 候选；Codex / Claude Code / OpenCode / Gemini CLI 更偏执行型 Coding Worker。不要把 OpenClaw 简单硬塞成普通 `codeAgentType`，后续应拆出 `coordinator runtime` 与 `worker runtime`。
- 第一阶段优先做 `RoomService + Matrix Adapter`、`CoordinatorRuntime`、`WorkerRuntime`、`ArtifactStore` 和 Controller/Reconciler 资源化。

详细方案见 `docs/AgentHub-HiClaw-lite开源内核重构方案.md`。后续涉及多 Agent 底层执行、子对话、产物、运行事件、生命周期的改动，应优先向该方案收敛，而不是继续给旧流程链打补丁。

## 关键交互边界

### 单聊

`direct + metadata.kind === "agent-direct"` 是全局 Agent 私聊，只出现在左侧“Agent 私聊”区域。

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
用户在群聊发消息
  -> messages.ts 作为 ChatIngress 写入用户消息、鉴权和加载群聊上下文
  -> RunController / ManagerLoop 创建 run.started、manager.thinking，并调用 Manager runtime 决策下一步
  -> 简单聊天：Orchestrator 直接回复
  -> 能力不足：Orchestrator 返回结构化 memberProposals，主群聊展示补员卡，用户确认后才创建/加入真实 Agent
  -> 复杂任务：Manager 生成团队行动方案和任务看板
  -> 用户确认/分发
  -> 迁移期仍由 OrchestratorEngine.startRun() 作为执行兼容层
  -> Manager planning action 生成可执行 Worker 任务；旧 Planner 只保留为兼容校验/工具函数来源
  -> TaskScheduler 按依赖层调度
  -> 每个任务创建 TaskThread，并投影为 orchestrator-task 子对话
  -> Orchestrator 将任务封装为 A2A message/send envelope
  -> TaskExecutionService 准备工作目录并经 LocalA2ATransport 派发
  -> 本地执行宿主适配到 LLM fallback / Code Agent
  -> 子对话保存完整过程
  -> shared task directory / ArtifactStore / 黑板写入任务摘要、产物、决策和 handoff refs
  -> 主群聊广播成员汇报和产物卡
  -> Synthesizer 生成最终总结
```

迁移方向：`messages.ts` 不应继续扩展成编排主脑；新增 run 生命周期、Manager 决策、资源 reconcile 和恢复逻辑应优先进入 `RunController` / `ManagerLoop` / 后续 kernel controllers。`OrchestratorEngine` 不再被视为未来主脑，只能在迁移期作为执行兼容层逐步拆小。

## Matrix / A2A 通信边界

新内核以 Matrix 作为内部通信事实源：

- Human、Manager、Worker 都是 Matrix Room participant。
- Manager 分配任务、@ Worker、Worker 回复、澄清、进度、失败、产物引用，都应进入 Room timeline。
- 主群聊、任务子对话、Manager/Worker DM 都应逐步变成 RoomService / MatrixRoomAdapter 管理的真实 Room。
- AgentHub 前端继续自研，不使用 Element Web 作为默认 UI。

A2A 调整为外部互操作层，不再作为第一阶段内部主通信路径：

- A2A 是通信协议，不是 runtimeType；远程 A2A endpoint 应通过 `roleProfile.protocol = "a2a"` + `roleProfile.a2aEndpoint` 配置。
- 旧 A2A envelope 可以迁移为 Matrix event 的可选 `taskEnvelope` 字段。
- 远程 Agent、外部系统调用 AgentHub Agent、跨平台互操作时再启用 A2A。
- 不允许恢复 `runtimeType = "a2a"`，也不能把 A2A 作为可创建的 Agent 类型展示给用户。

当前代码仍有“内部 A2A envelope + AgentHub local transport”的迁移期实现，但它不是新内核目标。后续通信改造应把 `LocalA2ATransport` 降级为兼容/外部互操作适配，不再继续扩展为内部主干。

相关文件：

- `apps/server/src/services/protocols/a2a-internal.ts`: 内部 A2A envelope、message 和 task 映射。
- `apps/server/src/services/execution/local-a2a-transport.ts`: 本地 A2A transport，负责把 `message/send` 派发到本地 runtime。
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
- `messages`: 聊天消息、任务结果消息、产物 metadata。
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
- 对复杂目标的意图判断、分工、追加任务和最终内容生成必须来自 Manager / Orchestrator / Synthesizer 的模型输出；系统代码只做 schema 校验、权限校验、状态记录和透明错误呈现。
- Manager / Orchestrator 决策输出解析失败时要透明报错或提示检查模型配置，不允许用关键词启发式兜底成 `plan/reply/clarify`。
- 运行中补员只能来自 Orchestrator 明确输出的 `memberProposals`；前端只展示确认卡，后端只按用户确认创建/加入真实 workspace agent。
- 不要恢复静态兜底提示词或固定模板计划。快速提示、任务拆解、协作计划都应由模型动态生成；失败时可以提示用户重试或检查模型配置。
- 不要恢复静态 Agent 路由、关键词分工、自动 Researcher 注入、自动 QA/review/follow-up 任务注入。系统只能校验 Manager / Orchestrator 的显式选择，不能偷偷改派或追加任务。
- 不要恢复内置 `.agenthub/specs/*.spec.yml` 场景模板，也不要让 `ensureHarnessPresets()` 把 specs 自动复制到新工作区。Spec 后续只可作为用户显式创建的协作契约。
- 不要把旧 `GroupChatManager` 作为新路径入口。群聊统一从 `messages.ts` 进入 Orchestrator 路由。
- 不要把旧 Git 分支隔离写成当前默认事实。当前默认是项目工作区 + `.agenthub/workdirs` + `.agenthub/shared/tasks`，`.agenthub/handoff` 只是兼容旧路径。
- 修改 UI 时要保持 IM 产品感：左侧树清晰、主群聊和子对话不重复、运行状态可见、产物入口明确。

## 重要文件

- `apps/server/src/routes/messages.ts`: 消息入口、意图判断、计划生成和分发入口。
- `apps/server/src/services/orchestrator/manager-planner.ts`: Manager-first 团队行动方案生成。
- `apps/server/src/services/orchestrator/orchestrator-engine.ts`: 迁移期执行兼容层，后续继续拆小。
- `apps/server/src/services/orchestrator/planner.ts`: 旧 Planner 兼容与计划校验工具来源，不是主脑。
- `apps/server/src/services/orchestrator/task-scheduler.ts`: DAG 调度。
- `apps/server/src/services/execution/task-execution-service.ts`: 任务执行服务。
- `apps/server/src/services/execution/agent-workdir.ts`: Agent 工作目录。
- `apps/server/src/services/blackboard.ts`: 黑板。
- `apps/server/src/services/code-agent-adapter.ts`: CLI 适配。
- `apps/web/src/components/chat/TaskBoard.tsx`: 任务看板。
- `apps/web/src/components/chat/SessionList.tsx`: 左侧会话树。
- `apps/web/src/stores/chatStore.ts`: 聊天状态和 WS 事件消费。

<br />
