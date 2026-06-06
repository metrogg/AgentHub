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
   - 状态：第一刀已落地。
   - Worker contract 已统一生成 `profile.json`、`runtime.json`、`SOUL.md`、`AGENTS.md`、`skills/`、`state.json`、`rooms.json`、`tasks.json`，并在 `AGENTS.md` 中幂等注入协作上下文。
   - Manager contract 已统一生成 `runtime.json`、`SOUL.md`、`AGENTS.md`、`TOOLS.md`、`HEARTBEAT.md`、`skills/`、`workers-registry.json`、`teams-registry.json`、`humans-registry.json`、`state.json`、`rooms.json`、`logs/`，并镜像到 OpenClaw `agentDir`。
   - `manager-runtime/manager-config.ts` 已降级为兼容外壳，正式生成逻辑归口到 `apps/server/src/services/agent-contract/manager-contract.ts`。
   - Manager skills 目录已补齐统一 `Decision Pattern`，示例不再默认使用 Codex，缺 runtime/model 必须请求确认或报错。
2. **Runtime adapter parity**
   - 为 OpenClaw、OpenCode、Claude Code、Codex、Gemini 建立同一组 `inspect / prepare / start / stop / syncConfig / health` 能力。
   - Bridge Worker 执行前已开始投影标准 contract：`EphemeralCodeAgentWorkerRuntime` 会确保 Worker contract 最新，并把 `AGENTS.md`、`SOUL.md`、`profile.json`、`runtime.json`、`state.json`、`rooms.json`、`tasks.json` 和 `skills/` 投影到本次 CLI cwd 的 `.agenthub/worker-contract/`，同时在 cwd 根 `AGENTS.md` 注入 `AGENTHUB:BRIDGE-RUNTIME-CONTEXT`。
3. **Member Reconcile**
   - 状态：第一刀已落地。
   - 新增 `apps/server/src/services/controller-plane/member-reconciler.ts`，`ControllerApi.createWorker()` 已委托它执行 `ResolveMemberSpec -> ApplyWorkspaceAgent -> ApplyWorkerInstance -> JoinRooms -> AnnounceAndObserve`。
   - `POST /api/workspaces/:id/workers` 现在把 `ownerId / createDirectSession / joinGroupRoom / announce` 传给 Controller API，由 MemberReconciler 创建/更新 direct room、group room participant，并返回 `stages / runtimeBase / groupRoom / directRoom / participants / announcements`。
   - Manager Runtime 的 `create_worker` action 已接入同一条 Controller API / MemberReconcile 路径：从 action metadata / `memberProposal` 规范化 member spec，创建 Worker、加入当前 group room、创建 direct room，并写入 `manager.action.create_worker.applied` 阶段结果。
   - OpenClaw Manager workspace 内的 `agenthub` CLI 已修正：`worker create/apply` 必须显式 `--runtime-base <openclaw|opencode|claude-code|codex|gemini>`，不再隐式 `codex`。
   - Manager 补员确认卡已接入同一条 Member Reconcile 路径：确认卡会把 Manager proposal / 专家预设中的 `description`、`systemPrompt`、`roleProfile`、`capabilityTags`、`skillIds`、`toolPermissions`、`sandboxPolicy`、`contextPolicy` 带入 `ControllerApi.createWorker()`，并在卡片 metadata 中记录 `workerInstanceIds`、`runtimeBases` 和各阶段结果。
   - 缺 runtime base 或 model 仍 fail-loudly，不默认 Codex，不创建注定 failed 的 Worker。
4. **Manager skill migration**
   - 以 HiClaw 16 skill 为模板，改写成 AgentHub Controller API 版本。
5. **Resident Worker e2e**
   - OpenClaw Worker 用自己的 Matrix `/sync` 接 @mention，自主回复和执行。
6. **Bridge hardening**
   - 状态：第一刀已落地。
   - OpenCode / Claude / Codex / Gemini bridge 执行目录现在能看到同一套规范 workspace、SOUL/AGENTS、skills 和 runtime/profile/state 文件；prompt 也会显式指向本次投影 contract 和 Controller 标准 contract。
   - 后端 Worker 创建、workspace 查询、room bridge 和 profile builder 已加护栏：缺 `codeAgentType / workerRuntimeBase` 不再静默改成 Codex。
   - 前端 Agent 配置、本地 Agent library、专家模板导入和启动修复逻辑也已收紧：新建 Worker 默认是“未选择 Worker 基座”，只有用户、模板或 Manager proposal 明确选择时才会写入 Codex / OpenCode / Claude Code / Gemini / OpenClaw。
   - 剩余：把 bridge `inspect / health` 诊断前端化，并继续把 heartbeat / artifact contract 和长期 session bridge 做到各基座能力对等。
