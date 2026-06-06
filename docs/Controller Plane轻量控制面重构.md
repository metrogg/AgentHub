# Controller Plane 轻量控制面重构

最后更新：2026-06-07

这份文档记录 AgentHub Controller 层向 HiClaw-lite 控制面收敛的当前事实、边界和下一步。它不是完整 Kubernetes CRD 方案，也不是照搬 HiClaw Controller；当前目标是用单进程 AgentHub 服务、SQLite 资源表和本地 Worker backend，先把 Manager / Worker / Room / Run / RuntimeLease / Artifact 的生命周期入口收束起来。

## 为什么要做这一层

HiClaw 的底层核心不是“后端函数串起来执行任务”，而是：

- Manager 通过 skill 调 Controller API。
- Controller 维护 Worker / Team / Human / Room / Task 等资源。
- Reconciler 比较 desired state 和 observed state，幂等地创建、恢复、停止、清理。
- WorkerBackend 负责把资源期望落到真实运行时，例如容器、OpenClaw、QwenPaw 或本地进程。

AgentHub 之前虽然已经拆出了 `RunController`、`WorkerController`、`RoomController`、`RuntimeLeaseController` 和 `ArtifactController`，但 Manager skill 仍容易直接 import 底层 service。这样会导致控制逻辑继续散落，后续接 OpenClaw、真实 Matrix、长期 Worker 和 Gateway 时又会出现多条入口。

因此本轮先补一个轻量 Controller Plane：统一资源模型、统一 reconcile request、统一 Manager skill 门面和 WorkerBackend seam。

## 当前已落地

新增模块：

- `apps/server/src/services/controller-plane/resource-types.ts`
  - 定义 `ControllerResourceKind`、`ControllerResourceRef`、`ControllerResource`、`ControllerCondition`、`ReconcileRequest`、`ReconcileResult`。
  - 资源 kind 包括 `Manager / Worker / Team / Human / Room / Run / Task / TaskThread / RuntimeLease / Artifact`。
  - 采用 `generation / observedGeneration / desiredState / observedState / conditions` 的控制面形态。
- `apps/server/src/services/controller-plane/reconcile-queue.ts`
  - 提供内存版 `ReconcileQueue`。
  - 支持按 `{workspaceId}:{kind}:{id}` 去重、延迟 requeue、batch drain、start/stop。
  - 提供 `describe()`，用于设置页和诊断接口展示 `running / size / pendingKeys / registeredKinds`。
  - 当前是开发期轻量队列，不是 durable queue。
- `apps/server/src/services/controller-plane/worker-backend.ts`
  - 定义 `WorkerBackend` 接口：`ensureRuntime / start / stop / inspect / syncConfig`。
  - `LocalCliWorkerBackend` 适配现有 `WorkerController` 和 `WorkerRuntimeService`；遇到 `runtimeBase=openclaw` 时会创建或复用 Worker / Manager Matrix identity，生成带真实 token 的 `openclaw.json`，启动本地 OpenClaw gateway 并等待 health，成功后把 WorkerInstance 标记为 `listening`。
  - `DockerWorkerBackend` 已作为 resident OpenClaw Worker 路径接入：设置 `AGENTHUB_WORKER_BACKEND=docker` 或 `AGENTHUB_CONTAINER_RUNTIME=docker` 后，会启动 `agenthub-worker-*` 容器，并复用同一套 identity/config/room membership 语义。
  - Worker runtime 准备现在会刷新统一 Agent contract：`profile.json / runtime.json / SOUL.md / AGENTS.md / skills / state.json / rooms.json / tasks.json`，OpenClaw、OpenCode、Claude Code、Codex、Gemini 后续都应通过这套 contract 对齐能力。
  - 后续仍可补 `QwenPawWorkerBackend`、更完整的 Docker sandbox backend 和 durable backend health reconcile。
- `apps/server/src/services/controller-plane/controller-api.ts`
  - 提供 Manager skill 应该调用的统一门面。
  - 当前封装 Worker apply/reconcile/wake/stop/idle-stop、Run create/list/reconcile/cancel、Task assign/list/status/complete/fail、Room create/reconcile/event/mention/participant、RuntimeLease summary、Artifact register/list。
  - `assignTask()` 已成为 Manager skill 派活入口：它会创建或复用 group session，启动 Run，创建 WorkspaceTask / TaskThread / task room / RuntimeLease，写入共享任务契约，并向 task room 写 Matrix @mention-first `task.assigned` 事件；route 层不再构造 fake message 或直接拼调度上下文。
  - 内部仍会调用现有 `RunController / WorkerController / RoomController / RuntimeLeaseController / ArtifactController`，但外部不再直接依赖这些底层控制器。
- `apps/server/src/routes/controller.ts`
  - 提供受 Manager Matrix token 保护的 `/api/controller/*` HTTP API 第一版。
  - 已覆盖 `schema`、`workers`、`runs`、`tasks`、`rooms`、`runtime-leases/reconcile`、`artifacts`、`teams`、`humans`、`workspace-state`、`status`、`heartbeat` 和通用 `reconcile`。
  - `rooms` 现在支持创建、列表、详情、participants、events timeline、append event、@mention participant 和 reconcile；OpenClaw/QwenPaw Manager skills 不再需要绕到产品态 `/api/rooms`。
  - 通用 `POST /api/controller/reconcile` 支持直接执行或 `enqueue=true` 进入 `controllerReconcileQueue`。
- `apps/server/src/services/controller-plane/controller-api-schema.ts`
  - 提供 `agenthub.controller-api.v1alpha1` 机器可读控制面 schema，列出 Manager skill 可调用的 operation、method、path、required fields、runtime enum、danger level、approval 和 audit 字段。
  - `GET /api/controller/schema` 和 `agenthub schema` 已可读取这份 schema；它不是完整 OpenAPI，但已经让 OpenClaw/QwenPaw skill 不必靠散落示例猜路径。
  - Worker runtime enum 已统一导出给 schema 和 apply 使用，包含 `openclaw / qwenpaw / copaw / opencode / claude-code / codex / gemini`；`copaw` 是 QwenPaw 的兼容 alias。
- `apps/server/src/services/controller-plane/controller-apply.ts`
  - 提供 `POST /api/controller/apply` 第一版 manifest apply。
  - 支持 JSON object/list，也支持轻量 YAML manifest；当前可 apply `Manager`、`Worker`、`Room`、`Task`、`Team`、`Human` 六类资源，分别进入 `ControllerApi.reconcileManager()`、`ControllerApi.createWorker()`、`ControllerApi.createRoom()`、`ControllerApi.assignTask()`、`ControllerApi.createTeam()` 和 `ControllerApi.createHuman()`。
  - Manager manifest 只负责幂等刷新 Manager 标准合约：`runtime.json / SOUL.md / AGENTS.md / TOOLS.md / HEARTBEAT.md / skills / workers-registry.json / teams-registry.json / humans-registry.json / rooms.json / state.json`，不负责启动或停止 resident OpenClaw/QwenPaw 进程。
  - 第一轮严格校验已接入：Worker manifest 必须显式提供 `spec.runtimeBase` 和 `spec.modelId`，runtime base 和 Room kind 必须匹配 Controller schema enum，`skillIds/dependsOn` 必须是字符串数组，`sandboxPolicy` 支持字符串或 `{ mode: ... }` 对象。
  - Manager manifest 必须使用 `spec.runtimeType=openclaw|qwenpaw`。
  - Team manifest 只引用已有 WorkspaceAgent ids/names，不再隐式创建缺 runtime/model 的 Worker；需要新增成员时必须先 apply Worker manifest。
  - 这一步对齐 HiClaw 的 `hiclaw apply` 心智：Manager skill 或人工可以提交资源声明，由 Controller 负责真实 reconcile，而不是在 skill 里直接调用底层 service。
- `apps/server/src/services/controller-plane/member-reconciler.ts`
  - 新增 HiClaw-lite `Member Reconcile` 第一版。
  - `ControllerApi.createWorker()` 已委托它执行 5 阶段：`ResolveMemberSpec`、`ApplyWorkspaceAgent`、`ApplyWorkerInstance`、`JoinRooms`、`AnnounceAndObserve`。
  - 该流程会创建/复用 `workspace_agents`、创建/准备 `worker_instances`、加入 group/direct Matrix room、刷新 Worker contract、可选写入 Manager 入群公告，并把阶段结果返回给 UI / Manager skill。
- `apps/server/src/services/controller-plane/controller-reconciler.ts`
  - 注册默认 `controllerReconcileQueue`。
  - 已接 `Worker / Run / Room / RuntimeLease` 到 `ControllerApi.handleReconcileRequest()`。
- `apps/server/src/services/controller-plane/diagnostics.ts`
  - 提供 `describeControllerPlane()`，聚合 Controller Plane API version、队列状态、资源计数、职责边界和 Worker runtime 明细。
  - `workerRuntimes[]` 会逐个暴露 WorkerInstance 的 runtime mode（resident OpenClaw / resident QwenPaw / bridge）、runtime base、observed/desired state、Matrix identity、Room participant、listener owner、heartbeat、last error 和标准 contract 文件完整性。
  - 对 OpenCode / Claude Code / Codex / Gemini 这类 bridge Worker，诊断会调用 `inspectCodeAgentRuntime()`，检查 CLI 安装、模型凭据、执行开关、cwd 和 blockers，避免只用文件存在性假装 runtime healthy。
  - 该接口只描述 AgentHub 内部资源调和层，不做 Manager 智能决策，也不读取或暴露敏感 token。
- `apps/server/src/services/controller-plane/resident-worker-self-test.ts`
  - 提供 resident Worker 自检入口，用于验证 OpenClaw/QwenPaw Worker 是否真的具备常驻运行条件。
  - dry-run 检查 WorkerInstance、runtime base、WorkspaceAgent、标准 Worker contract、Matrix identity、Room participant 和 WorkerBackend health。
  - 显式 `dispatch=true` 时会通过真实 Room timeline 写入 @mention probe，并等待 Worker 以 `TASK_COMPLETED / QUESTION / BLOCKED / PHASE_DONE` 协议回复；这用于现场验证 resident Worker 是否真的通过自己的 Matrix `/sync` 接单，而不是被 AgentHub bridge 代跑。

运行与诊断入口：

- 服务启动时 `apps/server/src/index.ts` 会启动 `controllerReconcileQueue`，并记录队列状态。
- 后端暴露 `GET /api/settings/controller-plane/status`，返回 `describeControllerPlane()`。
- 后端暴露 `POST /api/settings/controller-plane/workers/:workerInstanceId/resident-self-test`，返回 resident Worker readiness / probe 结果。
- 后端暴露受 Manager Matrix token 保护的 `/api/controller/*`，供 OpenClaw/QwenPaw skills 和 `agenthub` CLI 操作真实 Controller 资源。
- 设置页已经展示 `Controller Plane` 诊断卡，显示队列是否运行、注册的 resource kinds、Worker/Room/Run/RuntimeLease/Artifact 等资源计数，并展示每个 Worker 的 resident/bridge 模式、Matrix listener owner、contract ready/missing、bridge runtime ready/blocked、heartbeat 和错误状态。resident Worker 行提供 `Resident 自检`，默认 dry-run，不污染 Room timeline。

2026-06-07 现场补充：

- `ControllerApi.createWorker()` 现在要求 Worker 必须有显式模型绑定，或存在 `AGENTHUB_WORKER_LLM_MODEL / LLM_MODEL` 作为 Worker 模型来源；否则直接失败，不创建必然进入 failed 的 WorkerInstance。
- `ControllerApi.createWorker()` 不再把缺失的 Worker runtime base 静默默认成 Codex。解析顺序是：显式 `runtimeBase / workerRuntimeBase / codeAgentType` → `AGENTHUB_WORKER_RUNTIME_BASE` → 当前 workspace 已有 Worker 基座 → 报错要求补齐。
- `POST /api/workspaces/:id/workers` 已接入 Member Reconcile：添加 Worker 时由 Controller 统一负责 direct/group room reconcile、Worker participant、contract refresh 和 Manager announcement，不再由 route 自己散写 direct session。
- `ManagerRuntimeService` 的 `create_worker` action 已接入 Member Reconcile：Manager 运行时输出显式 member spec 后，会调用 `ControllerApi.createWorker()` 创建 Worker、加入当前 group room、创建 direct room，并写回 `manager.action.create_worker.applied / failed`。
- Manager 补员确认卡也已接入 Member Reconcile：确认后不再直接 insert `workspace_agents` 或手动 add participant，而是把 proposal / 专家预设中的角色说明、系统提示、skills、工具权限、上下文策略和 `roleProfile` 交给 `ControllerApi.createWorker()`；卡片 metadata 会记录 `workerInstanceIds / runtimeBases / memberReconcileResults`，便于 UI 和诊断展示真实阶段。
- 后端创建默认值继续收紧：工作区创建 Worker 和聊天 Agent 草案 normalize 都不会再把缺失的 `codeAgentType` 静默改成 `codex`；缺 Worker runtime base 会交给 Controller 显式报错或使用用户配置的 `AGENTHUB_WORKER_RUNTIME_BASE`。
- 前端配置默认值也已收紧：Agent 配置页、本地 Agent library、专家模板导入和 Coding Tools 启动修复都不再为缺失 Worker 基座补 Codex；未配置基座会保留为未配置态，等待用户、模板或 Manager proposal 明确选择。
- `infra/agenthub-cli/agenthub.ts` 的 `worker create/apply` 已取消 Codex 默认值，必须显式传 `--runtime-base`；OpenClaw Manager skill 示例也已更新为 `--runtime-base ... --model ...`。
- OpenClaw Worker 的 `roleProfile.workerRuntimeBase=openclaw` 会保持为 resident Worker 语义，`workspace_agents.codeAgentType` 不再写成 `codex`。
- QwenPaw / CoPaw Worker runtime base 已进入统一口径：Manager proposal、Controller normalize、WorkerController 校验、前端配置和 shared preset type 都能识别 `qwenpaw`，并保持 resident Worker 的 `codeAgentType=null`。当前 QwenPaw WorkerBackend 尚未实现，创建时会明确失败并提示 backend 未接入，不会降级成 Codex 或 bridge。
- `WorkerRuntimeService.runGroupMentionRoom()` 会把真实 runtime result status 返回给 dispatcher；Worker 执行失败时保持 `failed`，不再被旧 group mention bridge 覆盖成 `idle`。
- OpenCode / Claude Code / Codex / Gemini 当前仍是 AgentHub-managed Worker bridge；OpenClaw Worker 是 resident Worker 目标形态，需要独立 Matrix identity、room membership、openclaw config 和长期 gateway/listener。
- 新增 `apps/server/src/services/agent-contract/`：Manager 和 Worker 的 SOUL/AGENTS/Skills/registry/state 生成逻辑归口到这里。Manager contract 会生成 `runtime.json / SOUL.md / AGENTS.md / TOOLS.md / HEARTBEAT.md / skills / workers-registry.json / teams-registry.json / humans-registry.json / state.json / rooms.json / logs`，并镜像到 OpenClaw `agentDir`；`manager-runtime/manager-config.ts` 只保留兼容外壳。
- 新增 bridge contract projection：`EphemeralCodeAgentWorkerRuntime` 在调用 OpenCode / Claude Code / Codex / Gemini CLI 前，会把标准 Worker contract 投影到本次执行 cwd 的 `AGENTS.md` 和 `.agenthub/worker-contract/`，让 bridge Worker 和 resident Worker 共享 SOUL/AGENTS/Skills/registry/state 语义。
- Controller Plane 诊断已补上 Worker runtime 明细：设置页现在可以直接看出某个 Worker 是 `resident-openclaw`、`resident-qwenpaw` 还是 `bridge`，是否拥有 Matrix identity/participant，SOUL/AGENTS/skills/state/rooms/tasks 是否齐全，以及最近 heartbeat/error。bridge Worker 还会展示 `inspectCodeAgentRuntime()` 的结果，例如 CLI 未安装、模型凭据缺失、执行开关关闭或 cwd 无效。
- Resident Worker 自检已接入 Controller Plane：设置页可对 OpenClaw/QwenPaw resident worker 做 dry-run readiness 检查；自动化测试覆盖 `dispatch=true` 的 Matrix probe，确保 self-test request 写入 Room timeline 后能观察到 Worker 协议回复。
- `/api/controller/*` 第一版已可用：Manager token 鉴权、Room 创建/事件读取/事件写入、通用 reconcile 已有路由级测试覆盖；`agenthub room create/events/mention` 也改为走 `/api/controller/rooms*`，不再绕过控制面。
- `POST /api/controller/tasks` 已切到 `ControllerApi.assignTask()`：受 Manager token 保护的 HTTP 入口会创建真实 Run / Task / TaskThread / task room / RuntimeLease，并在 task room 生成 Matrix mention-first assignment。测试已覆盖该入口不会停留在路由层 fake message，而是能从 DB 观察到 `workspace_tasks`、`task_threads`、`rooms`、`room_participants` 和 `timeline_events(metadata.matrixExecutionBus=true)`。
- `GET /api/controller/schema` 已接入：schema 覆盖 Worker 创建、Task 派发、Room 创建/事件/mention、Artifact 注册、资源 reconcile、平台状态、workspace-state 和 heartbeat，并带上 danger/approval/audit 元数据。`agenthub schema` 会读取同一份 schema，供 Manager skills 和人工调试使用。
- `POST /api/controller/apply` 已不再是 stub：第一版支持 JSON / 轻量 YAML manifest，能创建 Worker、Room、Team、Human 或派发 Task。`agenthub apply -f <file>` 现在会进入这条真实控制面路径；Worker apply 仍遵守显式 runtime base、显式模型和 Member Reconcile 约束，并会在 apply 层提前拦截缺模型、非法 runtime、非法 Room kind 等 manifest 错误。Team apply 只引用已有 Worker，避免用 Team 创建绕过 Worker runtime/model 校验。
- Manager skill bundle 第一轮已对齐这条控制面：`agenthub-controller`、`worker-management`、`task-management`、`channel-management`、`project-management` 会先读取 `agenthub schema`，再通过 `agenthub apply -f ...` 或 Controller CLI 操作 Worker / Room / Task；边界测试禁止重新出现 `/api/internal/manager/actions` 和硬编码 `localhost:8000/api/rooms`。

Manager Runtime 已调整：

- `apps/server/src/services/manager-runtime/tool-registry.ts` 不再直接 import `roomService`、`workerController`、`runController`、`runtimeLeaseController`。
- Manager tool executor 统一通过 `controllerApi` 进入控制面。

测试：

- `tests/controller-plane.test.ts`
  - 验证 resource ref / condition 形态。
  - 验证 reconcile queue 去重和 delayed requeue。
  - 验证 reconcile queue `describe()` 的诊断结构。
  - 验证 workspace agent 可 apply 成 Worker resource。
  - 验证 Worker manifest apply 支持 `sandboxPolicy.mode` 对象形态，并会提前拒绝缺 `spec.modelId` 或非法 `spec.runtimeBase`。
  - 验证 Room manifest apply 会按 Controller schema 拒绝非法 `spec.kind`。
  - 验证 Team manifest apply 只能引用已有 Worker member，缺失成员会提示先 apply Worker manifest。
  - 验证 Human manifest apply 会进入 Controller human identity 创建流程。
  - 验证 `createWorker()` 走 Member Reconcile 5 阶段，并能加入 group/direct room、写入 Manager announcement。
  - 验证 Manager Runtime `create_worker` action 会真正创建 Worker、加入当前 group room，并写入 applied 阶段结果。
  - 验证默认 reconcile queue 能 dispatch Worker request。
  - 验证 `describeControllerPlane()` 返回控制面边界、资源计数和 Worker runtime 明细，并检查标准 Worker contract 文件已生成、bridge runtime inspection 已执行。
  - 验证 resident Worker self-test 能检查 readiness，并能通过 Matrix probe 观察到 Worker 协议回复。
- `tests/manager-runtime.test.ts`
  - 验证 Manager tools 仍可执行。
- `tests/controller-routes.test.ts`
  - 验证 Manager Matrix token 鉴权。
  - 验证 `/api/controller/rooms` 能创建 Room、写入/读取 timeline event，并通过通用 reconcile 观察 Room。
  - 验证 `/api/controller/schema` 暴露 Manager skill 可调用的 schema，并包含 `workers.create / tasks.assign / rooms.mention_worker / teams.create / humans.create`，且 Worker runtime enum 包含 `qwenpaw / copaw`。
  - 验证 `/api/controller/apply` 可以通过 YAML manifest 创建真实 Room。
  - 验证 `/api/controller/tasks` 能通过 `ControllerApi.assignTask()` 创建真实任务资源和 Matrix @mention-first task room。

## 当前不是完整 HiClaw Controller

这次只是 Controller Plane Phase 1，明确不是完整 HiClaw Controller。还缺：

- durable resource store：目前 resource shape 是 TypeScript 层投影，真实状态仍主要在现有 SQLite 表中。
- durable reconcile queue：当前队列是内存队列，服务重启不会保留未处理 request。
- Controller API HTTP/CLI：HiClaw 有 `hiclaw` CLI 调 controller API；AgentHub 已有 `/api/controller/*` 第一版、`agenthub` CLI、`agenthub.controller-api.v1alpha1` schema 和 Manager/Worker/Room/Task/Team/Human manifest apply，但完整 OpenAPI、危险操作 approval 和持久审计还不完整。
- ConfigVersionManager / hot reload：Worker 配置更新后还没有统一的 generation bump 和自动 rolling reconcile。
- Backend 抽象完整实现：当前已有 Local CLI bridge、本地 OpenClaw resident process 和 Docker OpenClaw resident Worker 的第一版；QwenPaw、Docker sandbox、runtime reconfigure、restart/backoff 和 durable health reconcile 还没完整接。
- Team/Human/Manager 资源 controller：Manager 已接 contract reconcile，Team/Human 已有 create/apply 第一版；Team Leader、权限策略、声明式 lifecycle reconcile 仍未完整实现。
- 权限和审计策略：Manager tool 调 Controller API 还缺更细的权限校验、dangerous action approval、审计字段。

## 和 HiClaw 的映射

| HiClaw | AgentHub 当前 |
|---|---|
| CRD / resource | SQLite 表 + `ControllerResource` 投影 |
| Go Reconciler | TypeScript Controller + `ReconcileQueue` |
| WorkerBackend | `WorkerBackend` seam + `LocalCliWorkerBackend` |
| `hiclaw` CLI 调 Controller API | `/api/controller/*` 第一版 + `agenthub` CLI + `agenthub.controller-api.v1alpha1` schema + Manager/Worker/Room/Task/Team/Human apply；完整 OpenAPI / audit 仍待补 |
| Manager skill 调 controller | `manager-runtime/tool-registry.ts -> controllerApi` |
| Worker/Manager/Team/Human controller | 第一版重点 Worker/Run/Room/RuntimeLease，其他预留 |
| ConfigVersionManager | 暂缺 |

## 下一步

1. 继续把 `agenthub.controller-api.v1alpha1` 从轻量 operation schema 收敛到完整 OpenAPI/JSON schema：补错误码、危险操作 approval、审计字段、Manager runtime lifecycle schema 和更完整的 apply 校验。
2. 增加 durable reconcile request 表，替代纯内存队列，服务重启后可恢复未完成 request。
3. 给 `workspace_agents` / `worker_instances` 引入 generation 语义：Agent 配置变化后自动 enqueue Worker reconcile。
4. 把 `ManagerRuntime` tools 从“字符串工具名 + executor map”进一步收敛到 Controller API schema，方便 OpenClaw/QwenPaw 直接调用；Manager skill 示例已经第一轮迁到 `agenthub schema/apply`，下一步是让 runtime 自动消费 schema，而不是只靠 Markdown 说明。
5. 实现 `OpenClawWorkerBackend`：resident Worker 通过 Matrix listener 自主接单，而不是 service dispatch 启动。
6. 补 Team/Human/Manager controller 后续阶段：Human 权限、Team Leader 作为可 reconcile 的 Manager/Worker 复合资源、Manager runtime 进程 lifecycle 和 hot reload。
7. 把启动恢复、patrol、stale lease recovery 都改成 enqueue reconcile request，而不是各处直接调用 controller 方法。

## 约束

- 不要把 `OrchestratorEngine`、`TaskExecutionService`、`LocalA2ATransport` 作为 Controller Plane 的兼容入口恢复。
- Manager skill 需要改资源时，应走 `controllerApi` 或后续 `/api/controller/*`，不要直接 import 底层 controller/service。
- `ReconcileQueue` 只做资源收敛，不做智能决策；回复、追问、派活、补员、返工策略仍来自 Manager Runtime / skills。
- 本地 `LocalCliWorkerBackend` 是第一阶段默认 backend，不代表长期 Worker 架构已经完成。
