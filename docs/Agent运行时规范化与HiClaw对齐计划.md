# Agent 运行时规范化与 HiClaw 对齐计划

最后更新：2026-06-07

这份文档把 HiClaw 的 `SOUL.md / AGENTS.md / skills / registry / state / workspace / heartbeat / reconcile` 思想正式纳入 AgentHub 的 HiClaw-lite 内核目标。它不是另起一条新路线，而是对 `ManagerRuntime`、`WorkerRuntime`、Controller Plane 和 Matrix Room 主线的进一步收口。

## 一句话目标

AgentHub 里的 OpenClaw、QwenPaw、Claude Code、OpenCode、Codex、Gemini 不能再只是“几种命令行工具”或“几种模型入口”。它们应该成为对等的 Agent Runtime Base：

```text
Human / Manager / Worker 都是 Room participant
  -> Matrix Room 是通信事实源
  -> Controller 管账号、Room、Worker、Lease、Workspace、Artifact
  -> Runtime Adapter 只负责把同一份 Agent contract 落到不同基座
```

换句话说：不同基座实现不同，但能力契约要尽量一致。OpenClaw 可以走 resident gateway；Claude Code / OpenCode / Codex / Gemini 可以先走 AgentHub-managed bridge，再逐步升级到长期 worker process。上层 Manager 不应该关心“这个 Worker 背后是哪种 CLI”，只关心它是否具备 identity、skills、workspace、heartbeat、Room listener 和任务契约。

## Runtime 对等矩阵

| 维度 | OpenClaw Manager / Worker | QwenPaw / CoPaw | Claude Code Worker | OpenCode Worker | Codex Worker | Gemini Worker |
| --- | --- | --- | --- | --- | --- | --- |
| 基础语言/形态 | Node.js 22 / gateway mode | Python / workspace mode | 本机 CLI / bridge 起步 | 本机 CLI / bridge 起步 | 本机 CLI / bridge 起步 | 本机 CLI / bridge 起步 |
| 目标运行形态 | resident process / Docker container | resident process / Docker container | long-running bridge 或 session bridge | long-running bridge 或 session bridge | long-running bridge 或 session bridge | long-running bridge 或 session bridge |
| Matrix 集成 | 原生 `/sync` 或 OpenClaw channel | CoPaw channel | AgentHub listener + bridge，后续可进程化 | AgentHub listener + bridge，后续可进程化 | AgentHub listener + bridge，后续可进程化 | AgentHub listener + bridge，后续可进程化 |
| Skill 加载 | `skills/*/SKILL.md` | 同一 skill schema | Controller 注入 AGENTS/SKILL context | Controller 注入 AGENTS/SKILL context | Controller 注入 AGENTS/SKILL context | Controller 注入 AGENTS/SKILL context |
| 工具调用 | OpenClaw tools / MCP / exec | QwenPaw tools / MCP / exec | CLI 原生工具 + MCP 注入 | CLI 原生工具 + MCP 注入 | CLI 原生工具 + MCP 注入 | CLI 原生工具 + MCP 注入 |
| 共享存储 | filesystem object store / MinIO adapter | 同左 | 同左 | 同左 | 同左 | 同左 |
| 适用场景 | 复杂交互、Manager、Team Leader、通用 Worker | 轻量常驻、资源受限、确定性任务 | 强代码能力、项目修改 | 强工程执行、本机模型生态 | Codex 生态任务 | Gemini 生态任务 |

目标不是让每个基座内部完全一样，而是让它们对 AgentHub 暴露同一组能力：

- `identity`: Matrix identity / displayName / participant binding。
- `workspace`: 规范化工作目录。
- `persona`: `SOUL.md`。
- `operating rules`: `AGENTS.md`。
- `skills`: `skills/*/SKILL.md`。
- `state`: `state.json`。
- `registry`: Manager 的 `workers-registry.json`；Worker 的 `rooms.json / tasks.json`。
- `heartbeat`: runtime 心跳和健康状态。
- `contract`: `shared/tasks/{taskId}/spec.md / plan.md / result.md / artifacts/`。

落地原则：

- Manager runtime 和 Worker runtime 都是 `Agent Runtime Base`，不是“模型类型”。OpenClaw / QwenPaw 可以作为 Manager / Team Leader，也可以作为 resident Worker；Claude Code / OpenCode / Codex / Gemini 当前主要作为 Worker bridge，后续可以升级为长期 bridge process。
- 上层 Controller / Room / Manager 只依赖统一 contract，不直接依赖某个 CLI 的私有参数。不同基座的差异只留在 adapter：OpenClaw 是 gateway mode，QwenPaw 是 workspace mode，OpenCode/Claude/Codex/Gemini 是 CLI bridge mode。
- Bridge mode 不是低一等的逻辑旁路。它必须读取同一份 `SOUL.md / AGENTS.md / skills / runtime.json / rooms.json / tasks.json`，必须通过 Matrix timeline 输入输出，必须创建 `WorkerInstance / RuntimeLease / Artifact`，只是监听和执行由 AgentHub 托管。
- Controller 每次 reconcile 都要向 `AGENTS.md` 注入当前协作上下文，包括 Room、Controller API、SharedStorage、任务契约、mention/澄清/停止规则、runtime base、model binding、sandbox 和 output rules。不能只在一次性 prompt 里塞这些信息。

## 标准 Workspace 结构

Manager workspace：

```text
{AgentHubUserData}/manager/{managerId}/
  openclaw.json 或 qwenpaw.yaml
  SOUL.md
  AGENTS.md
  TOOLS.md
  skills/
    worker-management/SKILL.md
    task-management/SKILL.md
    team-management/SKILL.md
    human-management/SKILL.md
    channel-management/SKILL.md
    file-sync-management/SKILL.md
    project-management/SKILL.md
    model-switch/SKILL.md
    worker-model-switch/SKILL.md
    mcp-server-management/SKILL.md
    matrix-server-management/SKILL.md
    service-publishing/SKILL.md
    git-delegation-management/SKILL.md
    hiclaw-find-worker/SKILL.md
    task-coordination/SKILL.md
    review-and-synthesis/SKILL.md
  workers-registry.json
  teams-registry.json
  humans-registry.json
  state.json
  rooms.json
  logs/
```

Worker workspace：

```text
{AgentHubUserData}/workers/{workerInstanceId}/
  profile.json
  runtime.json
  openclaw.json / qwenpaw.yaml / claude.json / opencode.json / codex.json / gemini.json
  SOUL.md
  AGENTS.md
  skills/
  state.json
  rooms.json
  tasks.json
  leases/
  cache/
  tmp/
  logs/
```

Shared task workspace：

```text
{workspaceRoot}/.agenthub/shared/tasks/{taskId}/
  meta.json
  spec.md
  plan.md
  result.md
  artifacts/
```

规则：

- `SOUL.md` 是人格和长期行为边界，首次创建时由 Controller seed，之后可由用户/Manager 显式更新。
- `AGENTS.md` 是工作协议，Controller 每次 reconcile 都可以注入最新协作上下文块。
- `skills/` 由 Controller 同步，不能靠 Worker 自己随意生成系统内置 skill。
- `state.json` 是 runtime 本地状态镜像，DB/Controller 仍是控制面事实源。
- `rooms.json` 记录该 Agent 加入的 Matrix room、room kind、participant id、最近同步位置。
- `runtime.json` 必须写清 runtime family、runtime base/type、resident/bridge mode、监听所有者、Controller/Matrix/SharedStorage 注入点、模型绑定和 sandbox。

## SOUL / AGENTS / Skills 规范

### SOUL.md

每个 Manager / Worker 都必须有 `SOUL.md`。内容至少包括：

- 自我身份：我是 Manager、Team Leader、Worker 还是 Human proxy。
- 职责边界：我负责什么，不负责什么。
- 沟通风格：自然、可信、像团队成员，不输出机械 JSON 给人类。
- 透明原则：重要判断、任务分配、澄清、失败和产物都回到 Room timeline。
- 人机协作原则：遇到不确定、危险操作、补员、权限变化时请求人类确认。
- 质量原则：按 `spec.md / result.md` 交付，不把“执行过”当作“完成”。

### AGENTS.md

每个 Agent workspace 的 `AGENTS.md` 必须由 Controller 注入协作上下文：

```text
## AgentHub Collaboration Context

- Agent identity: ...
- Runtime base: ...
- Matrix user id: ...
- Current rooms: ...
- Current task: ...
- Shared task dir: ...
- Artifact output rules: ...
- Mention / clarification rules: ...
- Stop / approve / deny control rules: ...
- Security and sandbox boundary: ...
```

这个注入块应该可重复生成、可 diff、可审计。不同基座的 adapter 把它翻译成各自最有效的提示/配置方式：

- OpenClaw / QwenPaw：进入 runtime workspace，作为原生文件参与上下文。
- Claude Code / Codex：放入 CLI 工作目录和 `AGENTS.md`，让 CLI 原生读取。
- OpenCode / Gemini：写入工作目录规则文件，并在 bridge prompt 中引用。

### Skills

HiClaw 的 16 项 Manager skill 应作为 AgentHub 的第一批 skill schema 参考。可以迁移结构和操作语义，但需要改写为 AgentHub Controller API：

- `worker-management`
- `task-management`
- `team-management`
- `human-management`
- `channel-management`
- `file-sync-management`
- `project-management`
- `task-coordination`
- `review-and-synthesis`
- `error-recovery`
- `capacity-management`
- `artifact-management`
- `heartbeat`
- `memory-management`
- `model-switch`
- `worker-model-switch`

其中企业级/暂不做的技能只保留 stub 和明确不可用诊断，不要假装已经支持：

- `mcp-server-management`
- `matrix-server-management`
- `service-publishing`
- `git-delegation-management`
- `hiclaw-find-worker`

## Reconcile 阶段

### Worker Reconcile 5 阶段

目标对齐 HiClaw 的 WorkerReconciler，但保持 AgentHub 单进程轻量形态：

1. `EnsureIdentityAndWorkspace`
   - 确保 Matrix identity、Room participant、workspace 目录、SOUL/AGENTS/skills/state。
2. `EnsureRuntimeConfig`
   - 生成对应基座配置：OpenClaw/QwenPaw/Claude/OpenCode/Codex/Gemini。
   - 注入 Controller API、Matrix、SharedStorage、model binding、sandbox。
3. `EnsureRuntimeReady`
   - resident runtime：启动或确认 gateway/listener。
   - bridge runtime：确认 CLI 安装、模型绑定、auth/config 和可执行性。
4. `ObserveHealthAndHeartbeat`
   - 读取 runtime health、heartbeat、lastSync、lastTask、lastError。
5. `RecoverOrRetire`
   - stale lease 标记、重启、sleep、stop、failed、用户可见诊断。

### Member Reconcile 5 阶段

用于“创建员工并入群”和“补员确认”：

1. `ResolveMemberSpec`
   - 从 Manager proposal、专家模板、用户选择中得到 name/role/runtime/model/skills/sandbox。
   - 缺 runtime 或 model 时必须请求确认，不能默认 Codex。
2. `ApplyWorkspaceAgent`
   - 创建或更新 `workspace_agents`。
3. `ApplyWorkerInstance`
   - 创建或更新 `worker_instances`，绑定 runtime base 和 model。
4. `JoinRooms`
   - 加入 group room、direct room、必要 task room，确保 Matrix membership。
5. `AnnounceAndObserve`
   - Manager 在 room 中自然介绍成员已加入，Worker 进入 listening/ready 后可自我介绍。

### Manager Reconcile 5 阶段

1. `EnsureManagerIdentity`
2. `EnsureManagerWorkspace`
3. `SyncSkillsAndRegistries`
4. `EnsureRuntimeProcess`
5. `ObserveRoomBindingsAndHeartbeat`

## Bridge 模式

Bridge 模式是过渡形态，不是终点，但它必须遵守同一套 Room contract。

```text
Matrix Room @mention
  -> AgentHub listener imports event
  -> WorkerRuntime bridge claims task
  -> CLI runs in normalized workspace
  -> result / progress / artifact refs written back to Room timeline
```

Bridge 模式要求：

- 不绕过 Matrix timeline。
- 不绕过 WorkerInstance / RuntimeLease。
- 不把 CLI 输出伪装成 Manager 输出。
- 失败要保留真实 runtime base、model、command、cwd、stderr 摘要。
- 后续可以替换为 resident runtime，而不改变上层 Manager/Room/Task 语义。

当前 bridge projection 的规范路径：

```text
Worker contract root
  -> SOUL.md / AGENTS.md / skills / profile.json / runtime.json / state.json / rooms.json / tasks.json
  -> projection
  -> execution cwd/.agenthub/worker-contract/*
  -> execution cwd/AGENTS.md 注入 AGENTHUB:BRIDGE-RUNTIME-CONTEXT
```

这样即使是 OpenCode / Claude Code / Codex / Gemini，本次执行也能“像一个 AgentHub Worker”一样知道自己是谁、在哪个 Room、接了哪个 task、产物写到哪里、如何澄清和如何停止。

## Controller Skill 调用路径

Manager skill 的目标形态是：

```text
自然语言意图
  -> Manager 选择 skill
  -> skill 调 /api/controller/*
  -> Controller 创建/调和真实资源
  -> Matrix Room timeline 写入过程、@mention、结果和诊断
```

当前已收口的关键入口：

- `create_worker`: 进入 `ControllerApi.createWorker()`，走 Member Reconcile 5 阶段。
- `assign_task`: 进入 `ControllerApi.assignTask()`，创建 Run / WorkspaceTask / TaskThread / task room / RuntimeLease，并向 task room 写 Matrix @mention-first `task.assigned` 事件。
- `room create/events/mention`: 进入 `/api/controller/rooms*`，不再绕到产品态 `/api/rooms`。
- `schema`: 进入 `GET /api/controller/schema` 或 `agenthub schema`，读取 `agenthub.controller-api.v1alpha1` operation schema，包含 method、path、required fields、runtime enum、danger、approval 和 audit 元数据。
- `apply`: 进入 `POST /api/controller/apply` 或 `agenthub apply -f <file>`，第一版支持 JSON / 轻量 YAML manifest，能 apply `Worker`、`Room`、`Task`、`Team` 和 `Human`，并开始按 Controller schema 的必填字段和 enum 做提前校验。

仍需补强：

- Controller API schema 继续升级为完整 OpenAPI / JSON schema，并让 apply 校验覆盖 Manager 资源、错误码和审计字段。
- 危险操作 approval 和审计字段。
- Team / Human / Manager controller 的完整资源化。
- durable reconcile queue 和 config generation bump。

## Heartbeat 与 Patrol

所有 runtime base 都要有统一健康语义：

- `lastHeartbeatAt`
- `lastMatrixSyncAt`
- `lastRuntimeReadyAt`
- `lastTaskStartedAt`
- `lastTaskCompletedAt`
- `lastError`
- `queueDepth`
- `observedState`

OpenClaw/QwenPaw resident runtime 从 gateway health 和 Matrix sync 得到心跳；Claude/OpenCode/Codex/Gemini bridge runtime 从 CLI 子进程、session bridge 和 WorkerRuntime heartbeat 得到心跳。ManagerPatrol 只消费这些统一字段，不直接猜某个 CLI 的内部状态。

## 与 HiClaw 的取舍

直接学习：

- Matrix Room 透明通信。
- Manager / Worker / Human 都是一等 participant。
- `SOUL.md / AGENTS.md / skills` 文件化配置。
- Manager 通过 skill 调 Controller API。
- Worker registry / state / heartbeat。
- Room 中 @mention 作为执行总线。
- 共享任务目录和 artifact refs。

轻量化处理：

- 不先引入 Kubernetes CRD。
- 不先完整引入 Higress consumer / enterprise RBAC。
- MinIO/S3-compatible 作为 adapter，本地 filesystem 仍是默认。
- Element Web 只作为调试工具，产品 UI 仍用 AgentHub。

不能再做：

- 缺 runtime 时默认 Codex。
- 缺模型时创建必然 failed 的 Worker。
- Manager/Worker 共用同一个 OpenClaw `main` identity。
- 用旧 `messages` 或本地假 adapter 假装 Agent 通信。
- 让 Manager 输出一段“我已经邀请了”但 Controller 没有真实创建资源。

## 下一步实施切片

1. **Agent contract generator**
   - 状态：第二刀已落地。
   - Worker contract 已统一生成 `profile.json`、`runtime.json`、`SOUL.md`、`AGENTS.md`、`skills/`、`state.json`、`rooms.json`、`tasks.json`，并在 `AGENTS.md` 中幂等注入协作上下文。
   - Worker `SOUL.md` 已写入 runtime adapter identity：OpenClaw/QwenPaw resident、Claude Code/OpenCode/Codex/Gemini bridge 的运行差异会被描述清楚，但都遵守同一 Room/Task/Artifact/Heartbeat contract。
   - Worker `runtime.json` 已写入 `runtimeMode` 和 `adapterContract`，包括 listener owner、workspace contract、task contract 和 heartbeat 字段，便于诊断页和后续 runtime adapter 统一消费。
   - 进展：`adapterContract.baseProfile` 已细分每个 Worker 基座：OpenClaw 是 Node/gateway/resident、QwenPaw 是 Python/workspace/resident，Claude Code / OpenCode / Codex / Gemini 是 AgentHub-managed CLI bridge。每个 profile 都记录 role eligibility、process model、Matrix integration owner、config strategy、health source、session strategy、current limits，并共享 `matrix_identity / room_timeline_io / mention_dispatch / SOUL.md / AGENTS.md / skills / workspace_contract / shared_task_contract / artifact_refs / heartbeat / stop_or_cancel / clarification_resume / transparent_blockers` 能力清单。
   - 进展：`adapterContract.diagnosticContract` 已写入每个 Worker 基座的标准诊断契约：readiness source、blocking signals、informational signals、probe 列表和 expected native capabilities。resident OpenClaw/QwenPaw 侧重 `WorkerBackend.inspect / Matrix sync / resident self-test`；bridge Claude Code/OpenCode/Codex/Gemini 侧重 `command-installed / native-version-probe / doctor-probe / capability-probe / model-binding / cwd`。这让 Worker 自己、Manager registry、设置页和后续 adapter 对“什么算 ready / 什么只是画像”有同一份文件化依据。
   - Manager contract 已统一生成 `runtime.json`、`SOUL.md`、`AGENTS.md`、`TOOLS.md`、`HEARTBEAT.md`、`skills/`、`workers-registry.json`、`teams-registry.json`、`humans-registry.json`、`state.json`、`rooms.json`、`logs/`，并镜像到 OpenClaw `agentDir`。
   - 新增 `ensureManagerAgentContractFromController()`：Manager 启动前会从 Controller/DB 同步 active rooms、WorkerInstance、WorkspaceAgent、Matrix identity、Room participant、RuntimeLease、Human participant 和 active runs，刷新 `workers-registry.json / humans-registry.json / rooms.json / state.json`，不再只是空 registry 文件。
   - 进展：`workers-registry.json` 现在会为每个 Worker 镜像 `runtimeContract`，包含 runtime mode、base profile、Matrix listener owner、workspace/task contract、heartbeat 字段、parity capabilities 和 current limits。Manager 读 registry 时不再只看到 `runtimeBase=opencode/openclaw` 这种裸字符串，而能按统一能力契约选择、观察和恢复 Worker。
   - `manager-runtime/manager-config.ts` 已降级为兼容外壳，正式生成逻辑归口到 `apps/server/src/services/agent-contract/manager-contract.ts`。
   - `infra/manager-agent` 模板已补强 Runtime Architecture、Manager/Member/Worker 五阶段 reconcile、Bridge 规则、heartbeat patrol、显式 runtime/model 约束。
   - Manager skills 目录已补齐统一 `Decision Pattern`，示例不再默认使用 Codex，缺 runtime/model 必须请求确认或报错；新增轻量 `review-and-synthesis`、`error-recovery`、`capacity-management`、`artifact-management`、`heartbeat`、`memory-management` skill 作为 HiClaw skill 面的 AgentHub 版本。
2. **Runtime adapter parity**
   - 为 OpenClaw、OpenCode、Claude Code、Codex、Gemini 建立同一组 `inspect / prepare / start / stop / syncConfig / health` 能力。
   - Bridge Worker 执行前已开始投影标准 contract：`EphemeralCodeAgentWorkerRuntime` 会确保 Worker contract 最新，并把 `AGENTS.md`、`SOUL.md`、`profile.json`、`runtime.json`、`state.json`、`rooms.json`、`tasks.json` 和 `skills/` 投影到本次 CLI cwd 的 `.agenthub/worker-contract/`，同时在 cwd 根 `AGENTS.md` 注入 `AGENTHUB:BRIDGE-RUNTIME-CONTEXT`。
   - Controller Plane 诊断已开始暴露每个 Worker 的 runtime mode、runtime base、Matrix identity、Room participant、listener owner、heartbeat、last error 和标准 contract 文件完整性。设置页“控制台 / AgentHub 内部 Controller Plane”可以直接看到 resident OpenClaw/QwenPaw 与 AgentHub-managed bridge 的区别。
   - Bridge Worker 诊断已接入 `inspectCodeAgentRuntime()`：OpenCode / Claude Code / Codex / Gemini 会检查 CLI 是否在 PATH、原生 `--version` probe 是否能真正启动、模型凭据是否可用、执行开关是否开启、cwd 是否有效、当前 blocker 是什么。它不再只是看 SOUL/AGENTS 文件是否存在。
   - 进展：Bridge Worker 诊断新增 `doctorProbe`。已安装的 Claude Code / OpenCode / Codex / Gemini 会尝试各自的 `doctor` 轻量原生命令，返回 `supported / ok / exitCode / timedOut / output`；不支持 doctor 的 CLI 不会被误判为不可执行，但支持且失败的 doctor/test 会进入 blocker。
   - 进展：Bridge Worker 诊断新增 `capabilityProbe`。已安装的 Claude Code / OpenCode / Codex / Gemini 会读取原生 `--help` 输出，解析该基座是否暴露 `auth / models / mcp / server / nonInteractive / jsonOutput / sessionResume / agents / project / doctor` 等能力。这个 probe 只作为能力画像和设置页诊断，不作为执行 blocker，避免不同 CLI help 输出差异误杀 Worker。
   - 进展：Bridge Worker 的 probe 不再只是散落在设置页。`runtime.json.adapterContract.diagnosticContract` 会声明哪些 probe 是 readiness 来源、哪些信号会阻断、哪些能力只是 expected native capabilities；Manager 的 `workers-registry.json` 也会镜像这份 contract，后续恢复、改派和补员可以按契约判断，而不是靠 `runtimeBase` 字符串猜。
   - 进展：Controller Plane 诊断新增统一 `runtimeHealth`。Bridge Worker 的健康来自 `inspectCodeAgentRuntime()`，resident OpenClaw/QwenPaw 的健康来自 `WorkerBackend.inspect()`；二者都会合并标准 contract、Matrix identity、WorkerInstance failed state 和 blocker 列表。设置页 Worker runtime 行不再只显示 bridge 的 CLI probe 或 resident 的零散状态，而是按同一组 `ready/status/inspectedBy/state/message/blockers` 展示。
   - 进展：Worker contract 的 `AGENTS.md` 注入块现在会展示 base profile、architecture mode、process model、Matrix pattern、runtime readiness、parity capabilities 和 current limits。这样 Manager、Worker 自己、设置页和后续 runtime adapter 都能读同一份 contract，而不是靠 UI 文案猜“OpenClaw/Claude/OpenCode/Codex/Gemini 到底是什么”。
   - 进展：设置页 resident Worker 行新增 `Resident 自检`。它调用 `POST /api/settings/controller-plane/workers/:workerInstanceId/resident-self-test` 做 dry-run 检查，逐项验证 WorkerInstance、runtime base、WorkspaceAgent、`SOUL.md / AGENTS.md / profile.json / runtime.json / state.json / rooms.json / tasks.json / skills/`、Matrix identity、Room participant 和 resident backend health。接口也支持显式 `dispatch=true`，通过真实 Room @mention 发送 probe，并等待 Worker 在 Matrix timeline 中回复 `TASK_COMPLETED / QUESTION / BLOCKED / PHASE_DONE`；默认 UI 不发 probe，避免污染房间。
3. **Member Reconcile**
   - 状态：第一刀已落地。
   - 新增 `apps/server/src/services/controller-plane/member-reconciler.ts`，`ControllerApi.createWorker()` 已委托它执行 `ResolveMemberSpec -> ApplyWorkspaceAgent -> ApplyWorkerInstance -> JoinRooms -> AnnounceAndObserve`。
   - `POST /api/workspaces/:id/workers` 现在把 `ownerId / createDirectSession / joinGroupRoom / announce` 传给 Controller API，由 MemberReconciler 创建/更新 direct room、group room participant，并返回 `stages / runtimeBase / groupRoom / directRoom / participants / announcements`。
   - Manager Runtime 的 `create_worker` action 已接入同一条 Controller API / MemberReconcile 路径：从 action metadata / `memberProposal` 规范化 member spec，创建 Worker、加入当前 group room、创建 direct room，并写入 `manager.action.create_worker.applied` 阶段结果。
   - OpenClaw Manager workspace 内的 `agenthub` CLI 已修正：`worker create/apply` 必须显式 `--runtime-base <openclaw|qwenpaw|copaw|opencode|claude-code|codex|gemini>`，不再隐式 `codex`。
   - Manager 补员确认卡已接入同一条 Member Reconcile 路径：确认卡会把 Manager proposal / 专家预设中的 `description`、`systemPrompt`、`roleProfile`、`capabilityTags`、`skillIds`、`toolPermissions`、`sandboxPolicy`、`contextPolicy` 带入 `ControllerApi.createWorker()`，并在卡片 metadata 中记录 `workerInstanceIds`、`runtimeBases` 和各阶段结果。
   - 缺 runtime base 或 model 仍 fail-loudly，不默认 Codex，不创建注定 failed 的 Worker。
4. **Manager skill migration**
   - 以 HiClaw 16 skill 为模板，改写成 AgentHub Controller API 版本。
   - 进展：`/api/controller/*` 第一版已从内部 service facade 扩展为受 Manager Matrix token 保护的 HTTP Controller 面。当前覆盖 Worker、Run、Task、Room、RuntimeLease reconcile、Artifact、Team、Human、Workspace state、Status、Heartbeat 和通用 `reconcile`；Room 端点支持 create/list/detail/participants/events/append/mention/reconcile。OpenClaw/QwenPaw Manager skill 和 `agenthub` CLI 可以走这条路径改真实资源，不需要直接 import AgentHub service，也不需要绕到产品态 `/api/rooms`。
   - 进展：`agenthub room create/events/mention` 已改为调用 `/api/controller/rooms*`。这让 Manager 的 channel/worker/task skill 更接近 HiClaw 的“自然语言 -> skill -> Controller API -> Matrix Room timeline”链路。
   - 进展：新增 `agenthub.controller-api.v1alpha1` 轻量 operation schema，并通过 `GET /api/controller/schema` 和 `agenthub schema` 暴露。第一版覆盖 Worker 创建、Task 派发、Room 创建/事件/mention、Artifact 注册、资源 reconcile、平台状态、workspace-state 和 heartbeat，附带必填字段、runtime enum、danger、approval 和 audit 元数据。
   - 进展：`POST /api/controller/apply` 已从 stub 变成真实 manifest apply；`agenthub apply -f <file>` 可以提交 JSON / 轻量 YAML，当前支持 `Manager`、`Worker`、`Room`、`Task`、`Team` 和 `Human`。Manager manifest 会刷新 Manager contract workspace、Matrix identity mirror、`SOUL.md / AGENTS.md / TOOLS.md / HEARTBEAT.md / skills / workers-registry.json / humans-registry.json / teams-registry.json / rooms.json / state.json`；默认是 contract-only，显式 `spec.desiredState: running|stopped|observed` 时才会调 OpenClaw/QwenPaw provider lifecycle，并把 status/health 写回 result snapshot。Worker 进入 Member Reconcile，Room 进入 Matrix-backed Room 创建，Task 进入 task room / RuntimeLease / Matrix @mention 派发链路，Team 会组已有 Worker 并确保团队 room participant，Human 会进入一等 human identity 创建流程。第一轮严格校验已接入：Manager 只允许 `openclaw/qwenpaw`，Worker 必须有显式 `runtimeBase` 和 `modelId`，runtime enum 包含 `qwenpaw/copaw`，Room kind 必须属于 Controller schema enum，`sandboxPolicy.mode` 对象形态会被正确投影。
   - 进展：`agenthub-controller`、`worker-management`、`task-management`、`channel-management`、`project-management` skill 第一轮已改成先读 `agenthub schema`，再用 `agenthub apply -f ...` 或最小 Controller CLI 命令操作真实资源；旧 `/api/internal/manager/actions` 和硬编码产品态 `/api/rooms` 已被边界测试禁止。
   - 进展：`reconcile.resource` 和 `managers.reconcile` 已能处理 `kind: Manager`，默认 Controller reconcile queue 也注册了 Manager；它用于幂等刷新 Manager 合约目录、registry 和 state，让 OpenClaw/QwenPaw Manager skills 看到最新 Controller 世界观。显式 `desiredState` 已接入 Manager runtime 进程生命周期声明式 reconcile：`running` 调 `ensureStarted()`，`stopped` 调 `stop()`，`observed` 只读取 status/health。
   - 剩余：补危险操作 approval、持久审计字段、完整 OpenAPI/JSON schema，以及 Team Leader 这类复合 Manager/Worker 资源。
5. **Resident Worker e2e**
   - OpenClaw / QwenPaw Worker 用自己的 Matrix `/sync` 接 @mention，自主回复和执行。
   - 进展：OpenClaw Worker config 生成已开始 room-aware。`deployWorkerConfig()` 会接收 Controller 查到的 Worker room bindings，把实际 `providerRoomId` 写入 `channels.matrix.groups`，并把同房间 human / manager Matrix user id 加入 `groupAllowFrom`；本地进程和 Docker resident backend 都走同一份 room binding。Worker contract 也会同步当前 rooms，避免 OpenClaw config 知道房间但 `AGENTS.md / rooms.json` 不知道。
   - 进展：QwenPaw / CoPaw 已被纳入 Worker runtime base 口径：Manager proposal、shared preset type、Controller runtime normalize、WorkerController 校验、前端 Agent 配置和 run snapshot 类型都能识别 `qwenpaw`，并保持 `codeAgentType=null` 的 resident 语义。由于 QwenPaw WorkerBackend 尚未实现，`ControllerApi.createWorker(runtimeBase=qwenpaw)` 会明确失败并提示 backend 未接入，而不是降级成 Codex 或 bridge。
   - 进展：resident Worker 通过 Matrix 发回 HiClaw 风格协议消息时，Controller 已不再只打日志。`TASK_COMPLETED` 会按 `Room -> TaskThread -> Task -> RuntimeLease -> WorkerInstance` 解析上下文，同步 `workspace_tasks=done`、`TaskThread=completed`、释放 `RuntimeLease`，并让 resident Worker 回到 `listening`；`QUESTION` 会创建 `task_clarifications`、写 `approval.requested` timeline event，并同步进入 `waiting_for_human`；`BLOCKED` 会把任务置为 blocked/failed-thread 并释放 lease；`PHASE{N}_DONE` 会进入 RunController 进度事件。这个切片让“Worker 在 Room 里说完了/卡住了/要澄清”开始成为真正的资源 reconcile，而不是纯聊天文本。
   - 进展：resident Worker e2e 现在有可操作验收入口。自动化测试覆盖 dry-run readiness 和 Matrix probe reply：Controller 先写 `worker-runtime.resident-self-test.request` mention event，再观察 Worker reply；这保护了“Room mention -> resident worker 回复 -> Controller 识别协议结果”的最小链路。现场验证时应先在设置页跑 dry-run，通过后再用显式 probe 或真实群聊 @mention 验证 OpenClaw/QwenPaw 进程自己的 `/sync`。
   - 剩余：用真实 Tuwunel + 真实 OpenClaw Worker 做现场 e2e，确认 OpenClaw 自己的 `/sync` 能稳定接 @mention、执行、发 `TASK_COMPLETED / QUESTION / BLOCKED`，并由 AgentHub 导入后完成上述资源闭环；随后实现 QwenPaw WorkerBackend，把当前“可识别但阻塞”的 QwenPaw resident Worker 变成可运行 backend。
6. **Bridge hardening**
   - 状态：第一刀已落地。
   - OpenCode / Claude / Codex / Gemini bridge 执行目录现在能看到同一套规范 workspace、SOUL/AGENTS、skills 和 runtime/profile/state 文件；prompt 也会显式指向本次投影 contract 和 Controller 标准 contract。
   - 后端 Worker 创建、workspace 查询、room bridge 和 profile builder 已加护栏：缺 `codeAgentType / workerRuntimeBase` 不再静默改成 Codex。
   - 前端 Agent 配置、本地 Agent library、专家模板导入和启动修复逻辑也已收紧：新建 Worker 默认是“未选择 Worker 基座”，只有用户、模板或 Manager proposal 明确选择时才会写入 Codex / OpenCode / Claude Code / Gemini / OpenClaw。
   - `describeControllerPlane()` 和设置页已经能显示 bridge/resident、contract ready/missing、listener owner、Matrix participant、heartbeat/error，以及 bridge CLI readiness probe。
   - 剩余：继续把 bridge `inspect / health` 从通用 `doctor` probe 推进到各 CLI 更完整的原生 profile/test/auth 检查，并继续把 heartbeat / artifact contract 和长期 session bridge 做到各基座能力对等。
