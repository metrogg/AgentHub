# Manager / Worker Runtime 三线并行重构协作计划

最后更新：2026-06-04

本文档用于三个人并行推进 Manager Runtime、OpenClaw 接入和 Worker Runtime 双模式重构。所有参与者改代码前必须先读本文，并在完成任一切片后同步更新本文的“进度同步区”。

## 目标

本轮目标不是继续修补旧流程，而是把 AgentHub 从“服务端编排任务系统”推进到更接近 HiClaw 的运行时结构：

- Manager 是真实协调器，观察 Room timeline，通过 skill / tool 调 Controller API，最后把决策写回 Room。
- Worker 是真实执行资源，既支持当前轻量的一次性 Code Agent 执行，也支持 OpenClaw / QwenPaw 常驻 Room Worker。
- Matrix Room / timeline / participant / mention 是协作事实源。
- `messages`、旧 snapshot、AG-UI cache 只做迁移期投影和兼容，不再承担事实源。
- 不恢复 `OrchestratorEngine`、`TaskExecutionService`、`LocalA2ATransport`、关键词路由、固定团队模板或静态 fallback。

## 当前判断

当前代码已经有三类相关模块：

- `coordinator-runtime/`：当前主路径仍在用的 Manager 决策壳，输出 `reply / clarify / propose_members / assign / wait` actions。
- `manager-runtime/`：更接近 HiClaw 的新模块，有 `ManagerRuntime` interface、`LocalManagerRuntime` tool-calling loop、skill loader、tool registry、OpenClaw launcher，但尚未成为主路径。
- `worker-runtime/`：当前任务执行闭环较实，能从 task room 接单，调用 Claude Code / OpenCode / Codex / Gemini，写回 progress / artifact / clarification / completed。但它仍主要是服务端托管的一次性执行，不是完整常驻 Worker Agent。

本轮最重要的断层：

- `LocalManagerRuntime` 仍未接入主路径。
- OpenClaw Manager lifecycle 还没有成为可配置、可检查、可启动、可停止的正式 runtime provider。
- Worker Runtime 没有明确区分 `ephemeral code-agent worker` 和 `resident room worker`。
- Manager -> Worker 很多地方仍由服务端直接调用 `WorkerRuntimeService.runTaskRoom()`，还没有完全变成 Matrix @mention 执行总线。

## 三线分工

### A 线：ManagerRuntime 接入主路径

负责人：待填写

目标：让 `coordinatorService.stepRoom()` 优先进入真正的 `ManagerRuntime.step()`，而不是继续只调用 `CoordinatorRuntime.step()`。

主要文件：

- `apps/server/src/services/manager-runtime/`
- `apps/server/src/services/coordinator-runtime/coordinator-service.ts`
- `apps/server/src/services/rooms/room-chat-bridge.ts`
- `apps/server/src/services/rooms/matrix-event-dispatcher.ts`
- `tests/manager-runtime-routing.test.ts`（建议新增）

具体任务：

1. 新增或完善 `manager-runtime/manager-runtime-service.ts`。
2. 输入保持为 `roomId / ownerId / afterSequence / source`。
3. 读取 Room、participants、timeline、workspace agents、run/task 状态。
4. 构造 `ManagerStepInput`，必须包含真实 `ownerId`，禁止继续写死 `default-user`。
5. 调用 `LocalManagerRuntime`，后续由 B 线切换到 OpenClaw provider。
6. 把 `thinking / tool_call / tool_result / room_message / completed` 等 `ManagerRuntimeEvent` 写入 Room timeline。
7. final `ManagerAction[]` 转成现有 `CoordinatorAction[]` 或直接交给 assign dispatcher。
8. `coordinatorService.stepRoom()` 保持对外入口，但内部优先走 `managerRuntimeService.stepRoom()`。
9. `CoordinatorRuntime` 降级为兼容 adapter / fallback，不再扩展为主脑。
10. ManagerRuntime 解析失败时要透明写入 Room timeline，不能静默 fallback 成关键词判断。

验收标准：

- 用户发“大家好”，ManagerRuntime 能自然回复，不创建 run/task。
- 用户发复杂任务，ManagerRuntime 能输出 assign，并复用现有 `dispatchCoordinatorAssignBatch()` 创建 task room。
- `tool_call / tool_result` 能在 Room timeline 中看到。
- `LocalManagerRuntime` 有测试证明已经被主路径调用。
- 现有 `room-chat-bridge` 关键测试继续通过。

### B 线：OpenClaw Manager 生命周期接入

负责人：Claude

目标：让 OpenClaw 不只是 endpoint / command 字符串，而是 AgentHub 可启动、可检查、可停止、可配置的正式 Manager runtime provider。

主要文件：

- `apps/server/src/services/manager-runtime/openclaw-launcher.ts`
- `apps/server/src/services/manager-runtime/runtime-registry.ts`（建议新增）
- `apps/server/src/services/manager-runtime/`
- `apps/server/src/routes/settings.ts` 或新增 Manager runtime 诊断路由
- `docs/OpenClaw接入指南.md`
- `tests/manager-runtime-lifecycle.test.ts`（建议新增）

具体任务：

1. 从 `openclaw-launcher.ts` 中收口出 `OpenClawManagerRuntimeProvider`。
2. Provider 提供 `ensureStarted() / stop() / status() / healthCheck() / getEndpointOrCommand()`。
3. 新增 Manager runtime registry，支持：
   - `local-skill-runtime`
   - `openclaw`
   - `qwenpaw`（先占接口）
4. 增加配置键：
   - `AGENTHUB_MANAGER_RUNTIME=openclaw|local-skill-runtime|qwenpaw`
   - `AGENTHUB_OPENCLAW_PATH`
   - `AGENTHUB_OPENCLAW_MANAGER_ENDPOINT`
   - `AGENTHUB_OPENCLAW_AUTO_START=true|false`
5. Manager workspace 统一到 `agentHubUserDataRoot()/manager/`。
6. Manager workspace 必须生成：
   - `SOUL.md`
   - `AGENTS.md`
   - `HEARTBEAT.md`
   - `TOOLS.md`
   - `skills/`
   - `state.json`
   - `workers-registry.json`
7. OpenClaw config 必须使用 AgentHub 创建的真实 Matrix identity：homeserver、userId、accessToken。
8. OpenClaw 未安装时，诊断要显示 unavailable，不能让用户误以为 Manager 正常。

验收标准：

- 有 Manager runtime status API 或等价诊断接口。
- OpenClaw 未安装时返回明确 unavailable / missing binary。
- OpenClaw 已配置时能启动进程，状态包含 pid、running、workspace、configPath、log tail。
- Manager Matrix account 能加入 group room。
- A 线能通过 registry 选择 OpenClaw ManagerRuntime provider，而不是自己拼 env endpoint；OpenClaw 不是独立 Agent 类型，也不是与 ManagerRuntime 并列的新抽象。
- fake command/mock 测试能覆盖启动、停止、状态查询。

### C 线：WorkerRuntime 双模式拆分

负责人：待填写

目标：明确区分当前轻量的一次性 Code Agent Worker 和后续 OpenClaw/QwenPaw 常驻 Room Worker。

主要文件：

- `apps/server/src/services/worker-runtime/types.ts`
- `apps/server/src/services/worker-runtime/local-worker-runtime.ts`
- `apps/server/src/services/worker-runtime/worker-runtime-service.ts`
- `apps/server/src/services/worker-runtime/resident-worker-runtime.ts`（建议新增）
- `apps/server/src/services/orchestrator/worker-controller.ts`
- `apps/server/src/services/worker-runtime/worker-workspace.ts`
- `tests/worker-runtime-modes.test.ts`（建议新增）
- `tests/matrix-resident-worker-dispatch.test.ts`（建议新增）

具体任务：

1. 在 Worker runtime 类型中加入明确模式：
   - `ephemeral-code-agent`
   - `resident-openclaw`
   - `resident-qwenpaw`
2. 当前 `LocalWorkerRuntimeAdapter` 重命名或包一层为 `EphemeralCodeAgentWorkerRuntime`。
3. `EphemeralCodeAgentWorkerRuntime` 继续负责 Claude Code / OpenCode / Codex / Gemini 的一次性 CLI 执行。
4. 新增 `ResidentRoomWorkerRuntime`，第一版负责：
   - `ensureStarted(workerInstanceId)`
   - `sendAssignment(roomId, workerParticipantId, prompt)`
   - 将任务用 Matrix @mention 发给 Worker
   - 不直接启动 code-agent CLI
5. `WorkerController.ensureReady()` 按模式分流：
   - ephemeral：检查 CLI、模型、配置和本地执行环境。
   - resident：检查进程、Matrix identity、listener、workspace config。
6. `WorkerRuntimeService.runTaskRoom()` 按模式分流：
   - ephemeral：沿用当前 `executeTask()`。
   - resident：写 `task.assigned`，在 task room 中 @mention Worker，标记 `assigned/listening`，等待 Matrix timeline 导入 Worker 后续回复。
7. `/stop` 行为分流：
   - ephemeral：abort 当前 CLI 子进程。
   - resident：发送 room control，并停止或 sleep 对应 runtime。
8. Worker workspace 必须包含：
   - `profile.json`
   - `SOUL.md`
   - `AGENTS.md`
   - `skills/`
   - `state.json`
   - `rooms.json`

验收标准：

- Claude Code / OpenCode / Codex / Gemini 旧任务仍能跑。
- WorkerInstance / health / metadata 能看出 worker mode。
- resident worker 能创建 participant 并启动 Matrix listener。
- Manager @mention resident worker 后，不走本地 code-agent CLI。
- `/stop` 对两种模式行为不同且可见。
- 新测试覆盖 ephemeral 与 resident 分流。

## 三线接口契约

三个人先对齐这些接口，改动时不要绕过：

```ts
interface ManagerRuntimeService {
  stepRoom(input: {
    roomId: string
    ownerId: string
    afterSequence?: number
    source: string
    signal?: AbortSignal
  }): Promise<{
    roomId: string
    runtimeType: string
    actions: ManagerAction[]
    appendedEventIds: string[]
  }>
}
```

```ts
interface ManagerRuntimeProvider {
  runtimeType: 'local-skill-runtime' | 'openclaw' | 'qwenpaw'
  status(): Promise<ManagerRuntimeStatus>
  ensureStarted?(): Promise<ManagerRuntimeStatus>
  stop?(): Promise<ManagerRuntimeStatus>
  createRuntime(): ManagerRuntime
}
```

```ts
type WorkerRuntimeKind =
  | 'ephemeral-code-agent'
  | 'resident-openclaw'
  | 'resident-qwenpaw'
```

```ts
interface WorkerRuntimeService {
  runTaskRoom(input: RunTaskRoomInput): Promise<RunTaskRoomResult>
  stopTaskRoom(roomId: string): boolean | Promise<boolean>
}
```

## 合并顺序

1. A 线先用 `LocalManagerRuntime` 打通主路径。
2. B 线把 OpenClaw 接入 Manager runtime registry，不直接改业务 dispatcher。
3. C 线把 WorkerRuntime 分成 ephemeral / resident 两种模式。
4. A 线切换 runtime registry，支持 `local-skill-runtime` 与 `openclaw`。
5. C 线让 resident worker 通过 Matrix @mention 接单。
6. 三线联合验收：Human message -> ManagerRuntime -> assign -> task room -> Worker mode dispatch -> Room timeline -> 前端投影。

## 禁止事项

- 不恢复 `OrchestratorEngine`。
- 不恢复 `TaskExecutionService`。
- 不恢复 `LocalA2ATransport`。
- 不扩大 `messages.ts` 编排职责。
- 不新增关键词路由、固定团队模板、静态 fallback plan。
- 不把 OpenClaw 硬塞成普通 `codeAgentType`。
- 不让 ManagerRuntime 失败后静默 fallback 到内部 LLM。
- 不为了兼容旧数据保留旧主路径。
- 不在业务控制器里直接拼 OpenClaw 进程命令；必须走 provider / registry。

## 进度同步规则

每个人完成任意切片后，必须更新本节。没有更新文档的改动视为未完成。

同步格式：

```md
### 2026-06-04 HH:mm - 负责人 / A|B|C 线

- 改动文件：
- 完成内容：
- 当前验证：
- 已知问题：
- 需要其他线配合：
- 下一步：
```

如果改动影响接口契约，必须同时更新“接口契约”小节。

如果发现本文档判断与代码不一致，必须先更新本文档，再继续实现。

## 进度同步区

### 2026-06-04 - 初始分工记录 / Codex

- 改动文件：新增本文档。
- 完成内容：把 ManagerRuntime 主路径、OpenClaw Manager lifecycle、WorkerRuntime 双模式拆成 A/B/C 三条并行线，并定义接口边界、验收标准和同步规则。
- 当前验证：文档切片，无代码验证。
- 已知问题：当前 `manager-runtime` 模块尚未接入主路径；OpenClaw launcher 还不是正式 provider；WorkerRuntime 尚未拆分 ephemeral/resident。
- 需要其他线配合：三位负责人开始前先填写各自负责人姓名或代号。
- 下一步：A 线优先实现 `manager-runtime-service.ts` 并接入 `coordinatorService.stepRoom()`。

### 2026-06-04 - B 线第一轮 / Claude

- 改动文件：
  - `apps/server/src/services/manager-runtime/openclaw-provider.ts`（新增）
  - `apps/server/src/services/manager-runtime/manager-runtime-registry.ts`（新增）
  - `apps/server/src/services/manager-runtime/index.ts`（更新导出）
  - `tests/manager-runtime-lifecycle.test.ts`（新增）
- 完成内容：
  - B1: `OpenClawManagerRuntimeProvider` 实现 `status() / ensureStarted() / stop() / healthCheck() / getEndpointOrCommand()`
  - B2: `LocalSkillRuntimeProvider` 作为 in-process fallback
  - B3: `QwenPawManagerRuntimeProvider` 占位
  - B4: Manager Runtime Registry 支持 `local-skill-runtime / openclaw / qwenpaw`，自动检测 OpenClaw 可用性
  - B5: 配置键支持 `AGENTHUB_MANAGER_RUNTIME / AGENTHUB_OPENCLAW_PATH / AGENTHUB_OPENCLAW_MANAGER_ENDPOINT`
  - B6: Manager workspace 自动生成 SOUL.md / AGENTS.md / HEARTBEAT.md / TOOLS.md / skills/ / state.json / workers-registry.json
  - B7: 12 个测试覆盖 provider status、healthCheck、registry 选择、env 覆盖
- 当前验证：`bun --filter @agenthub/server typecheck` PASS，`bun test tests/manager-runtime-lifecycle.test.ts` 12 pass / 0 fail
- 已知问题：OpenClaw 二进制未安装，`ensureStarted()` 会返回 unavailable；外部 endpoint health check 未实际验证（需要真实 OpenClaw）
- 需要其他线配合：A 线可通过 `getActiveManagerProvider()` 获取 provider，调用 `createRuntime()` 拿到 runtime
- 下一步：补充 Manager runtime status API 路由；等待 OpenClaw 安装后验证端到端启动

### 2026-06-04 19:44 - A 线第一轮 / Codex

- 改动文件：
  - `apps/server/src/services/manager-runtime/manager-runtime-service.ts`（新增）
  - `apps/server/src/services/manager-runtime/types.ts`
  - `apps/server/src/services/manager-runtime/local-manager-runtime.ts`
  - `apps/server/src/services/manager-runtime/index.ts`
  - `apps/server/src/services/coordinator-runtime/coordinator-service.ts`
  - `apps/server/src/services/coordinator-runtime/types.ts`
  - `apps/server/src/services/coordinator-runtime/runtime-registry.ts`
  - `tests/manager-runtime-routing.test.ts`（新增）
- 完成内容：
  - A1: 新增 `ManagerRuntimeService.stepRoom()`，读取 Room / timeline / worker participants 并构造 `ManagerStepInput`。
  - A2: `ManagerStepInput.context` 增加真实 `ownerId`；`LocalManagerRuntime` tool context 不再写死 `default-user`。
  - A3: ManagerRuntime async generator 过程事件写入 Room timeline：`thinking / tool_call / tool_result / room_message / task_assigned / member_proposed / completed / error`。
  - A4: final `ManagerAction[]` 转换为兼容现有 dispatcher 的 `CoordinatorAction[]`，同时保留 `rawActions` 便于后续直接接 Manager action controller。
  - A5: `coordinatorService.stepRoom()` 默认进入 `ManagerRuntimeService`；显式注入 `CoordinatorRuntime` 时继续走旧兼容路径，避免迁移期测试和外部调用断裂。
  - A6: 未接入的 Manager action（如 `create_worker`）会透明写入 `manager-runtime.unsupported-action`，不静默兜底或偷偷执行。
- 当前验证：已新增 `tests/manager-runtime-routing.test.ts`，待跑完整验证。
- 已知问题：当前默认 Manager runtime 仍是 in-process `LocalManagerRuntime`，会调用内部 LLM；B 线 OpenClaw provider 接入 `createRuntime()` 后，A 线需要再切到 registry 选择正式 Manager runtime。
- 需要其他线配合：B 线补齐 `ManagerRuntimeProvider.createRuntime()`；C 线继续把 assign 后 Worker 执行改成 resident/ephemeral 双模式。
- 下一步：跑 A 线测试、旧 coordinator 测试、server typecheck；随后把 `ManagerRuntimeService` 接入 B 线 provider registry。

### 2026-06-04 09:25 - C 线第一轮 / Codex

- 改动文件：
  - `apps/server/src/services/worker-runtime/types.ts`
  - `apps/server/src/services/worker-runtime/local-worker-runtime.ts`
  - `apps/server/src/services/worker-runtime/resident-worker-runtime.ts`（新增）
  - `apps/server/src/services/worker-runtime/worker-runtime-service.ts`
  - `apps/server/src/services/orchestrator/worker-controller.ts`
  - `apps/server/src/services/rooms/matrix-event-dispatcher.ts`
  - `tests/worker-runtime-modes.test.ts`（新增）
- 完成内容：
  - C1: `WorkerRuntimeKind` 类型加入：`ephemeral-code-agent | resident-openclaw | resident-qwenpaw`。`WorkerRuntime` 接口新增 `readonly kind`。`WorkerRuntimeResult` 新增 `kind?`。
  - C2: `LocalWorkerRuntimeAdapter` 重命名为 `EphemeralCodeAgentWorkerRuntime`，`kind = 'ephemeral-code-agent'`。所有引用同步更新。
  - C3: 新增 `ResidentRoomWorkerRuntime`，`executeTask` 通过 `roomService.appendMentionTimelineEvent` 向 task room @mention Worker participant 派发任务，返回 `waiting_for_human` 等待外部进程处理。
  - C4: `WorkerController.verifyRuntimeReadiness()` 按 mode 分流：ephemeral 保持现有 CLI/sandbox 检查；resident 检查 Matrix identity 和 access token。
  - C5: `WorkerRuntimeService.runTaskRoom()` 按 `workerInstance.runtimeBase` 分流：openclaw/copaw 创建 `ResidentRoomWorkerRuntime`，其他创建 `EphemeralCodeAgentWorkerRuntime`。
  - C6: `stopTaskRoom()` 改为 async 并按 mode 分流：ephemeral abort CLI 子进程；resident 写入 `matrix.control.stop.resident-requested` timeline event。`matrix-event-dispatcher.ts` 调用点同步改为 await。
  - C7: Worker workspace (`worker-workspace.ts`) 已包含 profile.json / SOUL.md / AGENTS.md / skills/ / state.json / rooms.json，无需修改。
  - C8: 新增 `tests/worker-runtime-modes.test.ts`，覆盖 kind 属性、runTaskRoom mode 分流、stopTaskRoom 分流，共 7 个测试。
- 当前验证：代码已写，测试文件已新增，待跑 `bun test tests/worker-runtime-modes.test.ts`。
- 已知问题：ResidentRoomWorkerRuntime 目前只是“写入 @mention timeline event”的壳，真实 OpenClaw/QwenPaw Worker 进程启动和 Matrix listener 生命周期由 B 线 provider 负责；C 线下一步需要把 resident worker 接单与 B 线进程启动串起来。
- 需要其他线配合：B 线完成 OpenClaw Worker 进程启动和 Matrix listener 后，C 线需要验证 resident worker 能通过 @mention 真正接单执行。
- 下一步：跑 C 线测试和 server typecheck；修复编译错误；准备 A/B/C 三线联合验收。

### 2026-06-04 20:14 - ABC 串联第一轮 / Codex

- 改动文件：
  - `apps/server/src/services/manager-runtime/manager-runtime-service.ts`
  - `apps/server/src/services/manager-runtime/openclaw-provider.ts`
  - `apps/server/src/services/manager-runtime/manager-runtime-registry.ts`
  - `apps/server/src/services/manager-runtime/remote-manager-runtime-adapter.ts`（新增）
  - `tests/worker-runtime-modes.test.ts`
  - `docs/Manager-Worker Runtime三线并行重构协作计划.md`
- 完成内容：
  - ABC1: `ManagerRuntimeService` 默认 runtime resolver 接入 `getActiveManagerProvider().createRuntime()`，不再固定 local runtime；测试仍可注入 fake ManagerRuntime。
  - ABC2: `OpenClawManagerRuntimeProvider / LocalSkillRuntimeProvider / QwenPawManagerRuntimeProvider` 统一实现 `createRuntime(): ManagerRuntime`。
  - ABC3: 纠正抽象边界：OpenClaw 是 `ManagerRuntimeProvider` 的一种实现，不是独立 Agent 类型，也不是与 ManagerRuntime 并列的新 runtime 抽象。
  - ABC4: 新增 `RemoteManagerRuntimeAdapter` 作为 provider 内部 HTTP 适配器；只在配置了 `AGENTHUB_OPENCLAW_MANAGER_ENDPOINT` / `AGENTHUB_QWENPAW_MANAGER_ENDPOINT` 时用于同步 `stepRoom()`。
  - ABC5: registry 自动选择规则改为“有可调用 Manager endpoint 才自动选择 OpenClaw provider”；仅安装 OpenClaw 二进制只代表 lifecycle available，不代表 stepRoom 已可用。
  - ABC6: 修复 C 线测试 helper：补 `DeferredResidentWorkerRuntime`，并让 deferred ephemeral runtime 响应 abort，覆盖 resident stop event 与 ephemeral abort。
- 当前验证：
  - `bun test tests/manager-runtime-routing.test.ts` PASS，2 pass / 0 fail。
  - `bun test tests/manager-runtime-lifecycle.test.ts` PASS，14 pass / 0 fail。
  - `bun test tests/worker-runtime-modes.test.ts` PASS，7 pass / 0 fail。
  - `bun --filter @agenthub/server typecheck` PASS。
- 已知问题：
  - OpenClaw 已安装后，当前只完成 provider lifecycle 与 endpoint adapter；还没有验证真实 OpenClaw Manager HTTP endpoint 的 action schema。
  - Resident Worker 仍是 Matrix @mention dispatch 壳，真实 OpenClaw/QwenPaw Worker listener 接单执行还没端到端验证。
  - `AGENTHUB_MANAGER_RUNTIME=openclaw` 且未配置 `AGENTHUB_OPENCLAW_MANAGER_ENDPOINT` 时会透明报错，不会回退 local，这是刻意设计。
- 需要其他线配合：后续需要补真实 Matrix identity + OpenClaw Manager endpoint contract，并把 resident worker process / listener 接到 WorkerController。
- 下一步：做真实 OpenClaw Manager endpoint contract 测试；然后做 Human message -> ManagerRuntime provider -> assign -> task room -> resident/ephemeral worker dispatch 的联合验收。

### 2026-06-04 20:26 - ABC 串联第二轮 / Codex

- 改动文件：
  - `apps/server/src/services/manager-runtime/remote-manager-runtime-adapter.ts`
  - `apps/server/src/services/manager-runtime/openclaw-provider.ts`
  - `apps/server/src/routes/settings.ts`
  - `tests/manager-runtime-lifecycle.test.ts`
  - `tests/worker-runtime-modes.test.ts`
- 完成内容：
  - ABC7: 明确 OpenClaw remote Manager endpoint 合约：Provider 填基础 endpoint 时，AgentHub 调用 `POST /step`；如果用户直接填完整 `/step` 地址则不重复追加。health check 对应 `GET /health`。
  - ABC8: `OpenClawManagerRuntimeProvider.status()` 增加 `syncReady / stepEndpoint / healthEndpoint / diagnostics`，把“binary 已安装”“endpoint 已配置”“可同步 stepRoom 调用”拆成三个不同状态。
  - ABC9: `settings.ts` 新增 Manager Runtime 诊断与生命周期接口：`GET /api/settings/manager-runtime/status`、`POST /api/settings/manager-runtime/:type/start`、`POST /api/settings/manager-runtime/:type/stop`、`POST /api/settings/manager-runtime/:type/health`。
  - ABC10: lifecycle 测试锁定 OpenClaw endpoint `/step` 调用和“未配置 endpoint 透明失败，不回退内部 LLM”的行为。
  - ABC11: resident worker dispatch 测试补充 listener metadata 断言，确认派发任务时会尝试启动 Matrix participant listener；local room 兼容模式下会明确返回 `room_is_not_matrix`。
- 当前验证：
  - `bun test tests/manager-runtime-lifecycle.test.ts` PASS，16 pass / 0 fail。
  - `bun test tests/manager-runtime-routing.test.ts` PASS，2 pass / 0 fail。
  - `bun test tests/worker-runtime-modes.test.ts` PASS，7 pass / 0 fail。
  - `bun --filter @agenthub/server typecheck` PASS。
- 已知问题：
  - 当前只定义并测试了 AgentHub 侧的 OpenClaw bridge contract，还没有真实启动 OpenClaw bridge 服务做端到端验证。
  - settings API 已有后端接口，但前端设置页尚未接入 Manager Runtime 诊断卡。
  - Matrix listener 目前能被 resident dispatch 触发，但真实 Matrix homeserver + Worker identity + access token 的 e2e 还需要继续补。
- 需要其他线配合：Manager Runtime / Worker Runtime 继续把真实 OpenClaw bridge、Matrix identity 和 Worker 常驻进程串起来；前端需要把 Manager Runtime 状态展示出来。
- 下一步：做真实 Matrix room e2e：创建 manager/worker Matrix identity，确保 room participant 能启动 listener，并验证 @mention assignment 经 Matrix timeline 回流到 AgentHub。
