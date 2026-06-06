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
  - 当前封装 Worker apply/reconcile/wake/stop/idle-stop、Run create/list/reconcile/cancel、Task list/status/complete/fail、Room create/reconcile/event/mention/participant、RuntimeLease summary、Artifact register/list。
  - 内部仍会调用现有 `RunController / WorkerController / RoomController / RuntimeLeaseController / ArtifactController`，但外部不再直接依赖这些底层控制器。
- `apps/server/src/services/controller-plane/controller-reconciler.ts`
  - 注册默认 `controllerReconcileQueue`。
  - 已接 `Worker / Run / Room / RuntimeLease` 到 `ControllerApi.handleReconcileRequest()`。
- `apps/server/src/services/controller-plane/diagnostics.ts`
  - 提供 `describeControllerPlane()`，聚合 Controller Plane API version、队列状态、资源计数和职责边界。
  - 该接口只描述 AgentHub 内部资源调和层，不做 Manager 智能决策，也不读取或暴露敏感 token。

运行与诊断入口：

- 服务启动时 `apps/server/src/index.ts` 会启动 `controllerReconcileQueue`，并记录队列状态。
- 后端暴露 `GET /api/settings/controller-plane/status`，返回 `describeControllerPlane()`。
- 设置页已经展示 `Controller Plane` 诊断卡，显示队列是否运行、注册的 resource kinds、Worker/Room/Run/RuntimeLease/Artifact 等资源计数。

2026-06-07 现场补充：

- `ControllerApi.createWorker()` 现在要求 Worker 必须有显式模型绑定，或存在 `AGENTHUB_WORKER_LLM_MODEL / LLM_MODEL` 作为 Worker 模型来源；否则直接失败，不创建必然进入 failed 的 WorkerInstance。
- `ControllerApi.createWorker()` 不再把缺失的 Worker runtime base 静默默认成 Codex。解析顺序是：显式 `runtimeBase / workerRuntimeBase / codeAgentType` → `AGENTHUB_WORKER_RUNTIME_BASE` → 当前 workspace 已有 Worker 基座 → 报错要求补齐。
- OpenClaw Worker 的 `roleProfile.workerRuntimeBase=openclaw` 会保持为 resident Worker 语义，`workspace_agents.codeAgentType` 不再写成 `codex`。
- `WorkerRuntimeService.runGroupMentionRoom()` 会把真实 runtime result status 返回给 dispatcher；Worker 执行失败时保持 `failed`，不再被旧 group mention bridge 覆盖成 `idle`。
- OpenCode / Claude Code / Codex / Gemini 当前仍是 AgentHub-managed Worker bridge；OpenClaw Worker 是 resident Worker 目标形态，需要独立 Matrix identity、room membership、openclaw config 和长期 gateway/listener。
- 新增 `apps/server/src/services/agent-contract/`：Manager 和 Worker 的 SOUL/AGENTS/Skills/registry/state 生成逻辑归口到这里。Manager contract 会生成 `runtime.json / SOUL.md / AGENTS.md / TOOLS.md / HEARTBEAT.md / skills / workers-registry.json / teams-registry.json / humans-registry.json / state.json / rooms.json / logs`，并镜像到 OpenClaw `agentDir`；`manager-runtime/manager-config.ts` 只保留兼容外壳。

Manager Runtime 已调整：

- `apps/server/src/services/manager-runtime/tool-registry.ts` 不再直接 import `roomService`、`workerController`、`runController`、`runtimeLeaseController`。
- Manager tool executor 统一通过 `controllerApi` 进入控制面。

测试：

- `tests/controller-plane.test.ts`
  - 验证 resource ref / condition 形态。
  - 验证 reconcile queue 去重和 delayed requeue。
  - 验证 reconcile queue `describe()` 的诊断结构。
  - 验证 workspace agent 可 apply 成 Worker resource。
  - 验证默认 reconcile queue 能 dispatch Worker request。
  - 验证 `describeControllerPlane()` 返回控制面边界和资源计数。
- `tests/manager-runtime.test.ts`
  - 验证 Manager tools 仍可执行。

## 当前不是完整 HiClaw Controller

这次只是 Controller Plane Phase 1，明确不是完整 HiClaw Controller。还缺：

- durable resource store：目前 resource shape 是 TypeScript 层投影，真实状态仍主要在现有 SQLite 表中。
- durable reconcile queue：当前队列是内存队列，服务重启不会保留未处理 request。
- Controller API HTTP/CLI：HiClaw 有 `hiclaw` CLI 调 controller API；AgentHub 目前只有 service facade，尚未提供完整 `/api/controller/*` 或 CLI。
- ConfigVersionManager / hot reload：Worker 配置更新后还没有统一的 generation bump 和自动 rolling reconcile。
- Backend 抽象完整实现：当前已有 Local CLI bridge、本地 OpenClaw resident process 和 Docker OpenClaw resident Worker 的第一版；QwenPaw、Docker sandbox、runtime reconfigure、restart/backoff 和 durable health reconcile 还没完整接。
- Team/Human/Manager 资源 controller：kind 已预留，但第一版只真正接了 Worker/Run/Room/RuntimeLease。
- 权限和审计策略：Manager tool 调 Controller API 还缺更细的权限校验、dangerous action approval、审计字段。

## 和 HiClaw 的映射

| HiClaw | AgentHub 当前 |
|---|---|
| CRD / resource | SQLite 表 + `ControllerResource` 投影 |
| Go Reconciler | TypeScript Controller + `ReconcileQueue` |
| WorkerBackend | `WorkerBackend` seam + `LocalCliWorkerBackend` |
| `hiclaw` CLI 调 Controller API | 设置页诊断已接 `/api/settings/controller-plane/status`；完整 `/api/controller/*` 和 CLI 仍待补 |
| Manager skill 调 controller | `manager-runtime/tool-registry.ts -> controllerApi` |
| Worker/Manager/Team/Human controller | 第一版重点 Worker/Run/Room/RuntimeLease，其他预留 |
| ConfigVersionManager | 暂缺 |

## 下一步

1. 把 `controllerApi` 暴露为受控 HTTP API：`/api/controller/workers`、`/api/controller/runs`、`/api/controller/rooms`、`/api/controller/reconcile`，供 OpenClaw/QwenPaw skills 和后续 CLI 调用。
2. 增加 durable reconcile request 表，替代纯内存队列，服务重启后可恢复未完成 request。
3. 给 `workspace_agents` / `worker_instances` 引入 generation 语义：Agent 配置变化后自动 enqueue Worker reconcile。
4. 把 `ManagerRuntime` tools 从“字符串工具名 + executor map”进一步收敛到 Controller API schema，方便 OpenClaw/QwenPaw 直接调用。
5. 实现 `OpenClawWorkerBackend`：resident Worker 通过 Matrix listener 自主接单，而不是 service dispatch 启动。
6. 补 Team/Human/Manager controller：Human 作为一等 participant，Team Leader 作为可 reconcile 的 Manager/Worker 复合资源。
7. 把启动恢复、patrol、stale lease recovery 都改成 enqueue reconcile request，而不是各处直接调用 controller 方法。

## 约束

- 不要把 `OrchestratorEngine`、`TaskExecutionService`、`LocalA2ATransport` 作为 Controller Plane 的兼容入口恢复。
- Manager skill 需要改资源时，应走 `controllerApi` 或后续 `/api/controller/*`，不要直接 import 底层 controller/service。
- `ReconcileQueue` 只做资源收敛，不做智能决策；回复、追问、派活、补员、返工策略仍来自 Manager Runtime / skills。
- 本地 `LocalCliWorkerBackend` 是第一阶段默认 backend，不代表长期 Worker 架构已经完成。
