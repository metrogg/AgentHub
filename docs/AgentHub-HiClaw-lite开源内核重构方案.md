# AgentHub HiClaw-lite 开源内核重构方案

最后更新：2026-06-04  
状态：重构总纲 / Phase 0-5 第一条本地可运行切片已打通

## 0. 一句话结论

AgentHub 后续不再继续把底层多 Agent 协作能力全部手搓成一套低配 HiClaw。

新的目标是：

```text
AgentHub Product Shell
  保留并强化我们自己的 Coze / Kimi 风格前端体验：
  群聊、私聊、任务子对话、专家配置、任务看板、产物卡、设置页、Trace/Eval 页面。

HiClaw-lite Open Kernel
  底层学习 HiClaw 的 Manager-Workers 协作内核：
  Manager 带团队、Room 透明通信、Worker 真实执行、Artifact 统一沉淀、Controller 管生命周期。

Open-source Infrastructure
  通信、运行时、网关、MCP、状态机、Trace、存储、沙箱等基础层优先采用成熟开源协议或组件。
```

这不是“前端不变，后端微调”。这是一次内核换血：前端产品壳保留，底层从旧 `messages.ts -> OrchestratorEngine -> Planner/TaskScheduler` 过程式链路，迁移到 `Room + ManagerRuntime + Controller/Reconciler + WorkerRuntime + ArtifactStore + Gateway` 的资源化架构。

## 0.1 开工前审查结论

这份方案可以作为重构总纲开工，但实施时必须收紧第一阶段边界，避免一上来同时引入 Matrix homeserver、OpenClaw/QwenPaw、Gateway、ArtifactStore、前端大改，导致不可验证。

开工约束：

1. **先做接口和本地 adapter，再接真实开源组件。**
   - Room 层先实现 `RoomService + LocalMatrixCompatibleRoomAdapter`，数据结构按 Matrix event/room/participant 设计。
   - 等本地 Room API 跑通，再接 Tuwunel/Conduit/Synapse。
   - Manager 层先实现 `CoordinatorRuntime` 接口和本地 fallback adapter，再做 OpenClaw/QwenPaw POC。
   - ArtifactStore 先 filesystem adapter，MinIO/S3 只做接口兼容设计。

2. **第一刀不要改完整前端。**
   - 先让后端能创建 Room、写 timeline、查询 timeline、投影到现有消息列表。
   - 左侧会话树和 TaskBoard 可以先读兼容 API，不要第一天就重写所有 UI 状态。

3. **旧路径只允许封存和旁路，不允许继续扩展。**
   - `OrchestratorEngine`、`LocalA2ATransport`、`sessions.metadata.kind` 可以作为迁移期兼容读取，但新接口、新表、新任务不能继续以它们为事实源。
   - 如果兼容成本超过新内核推进成本，直接清库重建。

4. **每个阶段必须能独立验收。**
   - Phase 1 验收 Room/timeline，不要求 Worker 真执行。
   - Phase 2 验收 Manager 能在 Room 中自然回复和输出结构化 action，不要求 OpenClaw 真接入。
   - Phase 3 验收 WorkerRuntime 从 task room 接单并写回 timeline，不要求 Matrix 外部 homeserver。
   - Phase 4 验收 artifact ref 全链路，不要求 MinIO。

5. **不要让“像 HiClaw”变成重依赖。**
   - 当前最重要的是 Manager / Worker / Room / Storage 四个内核语义。
   - Kubernetes、完整 Higress、MinIO 集群、企业多租户、SSO、复杂 RBAC 都不是第一阶段目标。

如果后续实现遇到分歧，以这个顺序取舍：

```text
体验真实透明 > 内核边界清晰 > 可本地跑通 > 开源组件接入 > 企业级完整性 > 旧数据兼容
```

## 0.2 当前实施进度

截至 2026-06-04，本轮 HiClaw-lite Kernel 重构已经打通第一条本地可验证切片：

- **Phase 0 已落地第一层护栏**：`OrchestratorEngine` 和 `LocalA2ATransport` 已在代码中标记为迁移期兼容层。新 Manager 决策、Room 语义和生命周期所有权不应继续加到这些旧模块里。
- **Phase 1 已落地本地 Room 资源层**：数据库新增 `rooms`、`room_participants`、`timeline_events`；服务层新增 `RoomService`、`LocalMatrixCompatibleRoomAdapter` 和 `/api/rooms`；新 session 创建和 TaskThread 创建路径已开始 ensure Room 资源并写入 `task.assigned` timeline event。
- **Phase 2 已落地 CoordinatorRuntime 壳，并开始进入群聊主入口**：新增 `CoordinatorRuntime` action schema、`LocalCoordinatorRuntime`、`CoordinatorService.stepRoom()` 和 Manager 配置目录化（`SOUL.md`、`AGENTS.md`、`skills/`、`workers-registry.json`、`state.json`）。群聊消息会先写入 Room timeline，并在慢模型/Manager 决策前追加一条幂等的 `coordinator.observing` Manager timeline event，透明告诉用户 Manager 已收到并正在判断“直接回复、追问还是分派任务”；这不是规划结果，也不是静态兜底。Coordinator 对 `reply / clarify / propose_members` 会写回 Room timeline 并兼容镜像到旧 messages 表；空 action 不消费消息，避免用户输入被吞。`CoordinatorRuntime` 现在已经有 registry/selection 层：默认仍是本地 `local-llm`，`openclaw` / `qwenpaw` 已作为显式可选的外部 runtime skeleton 预留，后续接真实 OpenClaw/QwenPaw 时不需要再改群聊主入口；但这两个外部 runtime 当前还不是已跑通实现。
- **Phase 3 已落地 WorkerRuntime task room 最小壳，并打通 Coordinator assign / ManagerLoop dispatch 主线**：新增 `WorkerRuntime` 接口、`LocalWorkerRuntimeAdapter` 和 `WorkerRuntimeService.runTaskRoom()`。当前可以从 task room 读取 `task.assigned`，找到 Worker participant，调用 runtime，并把 `task.progress`、`worker.message`、`artifact.created` 写回 Room timeline。WorkerRuntime 流式事件已经支持 `clarification` 和 artifact `status`：Worker 请求澄清会写入 `approval.requested` timeline event，同时创建 `task_clarifications` pending 资源记录并把 `clarificationId` 写回 timeline metadata；partial artifact 会以 `partial` 状态进入 ArtifactStore。澄清不再被伪装成失败：`WorkerRuntimeResult.status` 已扩展为 `waiting_for_human`，`TaskThread.status`、`RuntimeLease.status`、`WorkerInstance.observedState` 会同步进入 `waiting_for_human`，`RunController.markTaskWaitingForHuman()` 会把 task 标成 `blocked + progressStatus=awaiting_human_clarification` 并发出 `approval.requested` RunEvent，run 保持 `running`。用户在同一个 task room 回答澄清后，`stepTaskRoomAfterHumanMessage()` 会记录 `human.message`、把对应 `task_clarifications` 更新为 `answered`、写入 `worker-runtime.resume-requested`，并可重新调用 `WorkerRuntimeService.runTaskRoom()` 继续执行。Coordinator 返回单个或多个 `assign` 时，会创建真实 run / workspace task / TaskThread / task room / Worker participant / RuntimeLease，并启动 WorkerRuntime 执行；多个 `assign` 已收敛到同一个 shared run 下，run completion 由 batch coordinator 在所有 Worker task settle 后统一判定，不再由每个单任务提前结束整个 run。Coordinator action 现在还支持 `taskKey / dependsOn` 的最小依赖账本语义，派发器会把依赖 key 转换成真实 task id 写入 `workspace_tasks.dependencies`、run plan 和 Room timeline metadata，并按依赖层执行 WorkerRuntime；上游失败时，下游 task room 会记录 `worker-runtime.skipped-by-dependency`，不会硬跑；上游等待用户澄清时，下游会保持可见但暂停为 `waiting_on_dependency_human_clarification`，不会误报失败。动态 `OrchestratorPlan` 的成功路径也已开始翻译成 Coordinator `assign` batch：复用同一个 Manager run，创建真实 task room / RuntimeLease / ArtifactStore 记录，并优先走 WorkerRuntime 执行，而不是直接启动旧 `OrchestratorEngine`。运行详情页的单任务 retry 也已切到 `WorkerRuntimeService.rerunTaskRoom()`：先通过 `RunController.resetTaskForRetry()` 重置资源，再从已有 task room 重新接单，不再调用旧 `OrchestratorEngine.retryTask()`。`ManagerLoop.step()` 现在还会把 `pending/blocked + prepared TaskThread` 的任务原生派发到 WorkerRuntime：确保 task room 和 Worker participant，写入 `manager-loop.dispatch` 的 `task.assigned` timeline event，再调用 `WorkerRuntimeService.rerunTaskRoom(source=manager-loop.dispatch-pending)`；等待人类澄清的 blocked task 会保持 waiting，不会被误重启。
- **Phase 3 生命周期入口继续收口**：`WorkerRuntimeService.runTaskRoom()` 已经从“执行函数”升级为完整任务房间生命周期入口。直接 `runTaskRoom()`、`rerunTaskRoom()`、澄清 resume、Coordinator assign、动态计划分发和 ManagerLoop prepared-task 派发都共享同一条路径；WorkerRuntime 一开始就写入 `worker-runtime.started` timeline event，并同步把 `workspace_task` 标为 `running`、`TaskThread` 标为 `active`、`RuntimeLease` 标为 `running`、`WorkerInstance` 标为 `busy`。运行中会按间隔写入 `worker-runtime.heartbeat` task room timeline event，并刷新 WorkerInstance `lastHeartbeatAt`，最终 completed / failed / cancelled / waiting_for_human 也在 `runTaskRoom()` 内统一同步到 RunController 和资源状态。
- **Phase 4 已落地 filesystem ArtifactStore 最小闭环**：`artifacts` 表新增 `roomId`、`storageProvider`、`bucket`、`objectKey`、`storagePath`；`registerTaskArtifact()` 会按 S3-compatible object key 语义把文件、内联内容或 artifact descriptor materialize 到用户数据目录下的 local filesystem object store；`WorkerRuntimeService` 的 `artifact.created` timeline event 已绑定真实 `artifactId / objectKey / storagePath`。
- **Phase 5 已落地 Room timeline replay + realtime WS 最小前端投影链路**：前端新增 Room API client 和 `roomTimeline` 纯投影模块；`chatStore.selectSession()` 会 ensure 当前 session/task-thread Room，拉取 participants + timeline，把 Room timeline 投影为可见消息、任务状态事件和 artifact.created 事件，再复用现有 taskBoard / Agent tabs / 产物卡投影链路。`RoomService.appendTimelineEvent()` 现在会广播 `room:timeline` WebSocket 事件；task room event 会同时通知 task session 和父 group session，前端收到后复用同一投影函数实时更新子对话消息、任务看板和 artifact 卡。即使旧 run snapshot / plan 尚未到达，Room timeline 的 `task.assigned / task.progress` 事件也能先创建最小任务看板、Agent tab 和稳定 task room 入口。Worker 的 `worker-runtime.started` 会被投影成 `running + taskThreadStatus=active + progressPercent=5`，让用户一进来就看到真实 Worker 已接单；`approval.requested` 澄清请求、`waiting_for_human` 进度事件和 `waiting-on-human-dependency` 依赖等待事件会投影成 `blocked + taskThreadStatus=waiting_for_human`，`skipped-by-dependency` 会投影成 `failed`，Agent tabs、Header 和 TaskBoard 会明确显示等待补充/依赖跳过，不再把 HITL 或依赖状态误判成 running。Manager 的 `manager-review-started` / `manager-final-review` 也会从 Room timeline 投影成 `agenthub.run.status(synthesizing/completed/failed)`，让刷新或重放时能恢复“正在汇总/最终复盘”状态。刷新、切换回群聊/任务子对话，或执行中实时写入 timeline 时，Manager/Worker 消息、`task.assigned`、`task.progress`、`approval.requested`、`artifact.created` 和 run 状态都能从 Room timeline 投影出来。
- **ManagerPatrol 开始从旧事件投影收口到 Room timeline**：任务超时巡检和 Worker 心跳异常现在会写入 group room 的 `manager.message` 与 task room 的 `task.progress` timeline event，metadata 使用 `kind=manager-patrol-check`，让 Manager 主动监督也能在群聊/子对话中被审计，而不是只停留在 RunEvent 或旧 messages。巡检还修正了一个跨 run 边界问题：每个 active run 只处理该 run 的 TaskThread 绑定 busy Worker，避免全局 busy Worker 被错误归入当前 run。
- **旧 Engine 外部入口继续收缩**：运行中用户补充需求的 `human_interrupt` 处理不再调用 `OrchestratorEngine.applyHumanInterruptToActiveRun()` 改写旧内存计划，而是写入 group room / task room timeline，并由 `RunController` 标记任务、TaskThread、RuntimeLease、WorkerInstance 状态；`POST /api/orchestrator-runs/:id/cancel` 不再调用 `OrchestratorEngine.cancelActiveRun()`，只走 `RunController.cancel()`；服务启动恢复也不再 `OrchestratorEngine.resumeRun()`，而是将 running task 通过 `RunController.requeueRunningTasksForResume()` 重新挂回 prepared，再 `RunController.reconcile()` 触发 ManagerLoop；终态 run 的最终复盘也已进入 `ManagerLoop + CoordinatorRuntime resource-review skill`，由 ManagerLoop 读取 `workspace_tasks`、TaskThread、task room timeline、ArtifactStore 和共享任务 `result.md`，再交给 `coordinator-runtime/final-review-skill.ts` 生成确定性资源复盘，写入 `manager-review-started` / `manager-final-review` group room timeline event 与兼容 messages，并发出 `run.synthesizing` / `run.completed|run.failed`，不再依赖旧 `OrchestratorEngine.synthesizeAndReport()`。
- **旧 Engine 测试口径也开始收缩**：smoke 测试里最后两处直接 `new OrchestratorEngine()` / `OrchestratorEngine.retryTask()` 的验收已改为新内核资源流。人工打断恢复测试现在验证 `human_interrupt -> RunController.reconcile() -> workspace_task pending -> TaskThread prepared -> RuntimeLease stale -> WorkerInstance idle -> WorkerRuntimeService.rerunTaskRoom()`；单任务 retry 测试现在通过 `/api/orchestrator-runs/:id/retry-task/:taskId` 进入已有 task room，再由 `WorkerRuntimeService.rerunTaskRoom()` 完成执行。新增 `tests/manager-loop-worker-runtime.test.ts` 验证 ManagerLoop 可把 prepared pending task room 直接派给 WorkerRuntime，并验证 `awaiting_human_clarification` 的 blocked task 不会被误重新派发。
- **Phase 6 Controller/Reconciler 第一轮已落地**：`RunController / RoomController / WorkerController / RuntimeLeaseController / ArtifactController` 已经分开成明确资源控制入口。`RoomController` 负责 group/task room reconcile 和 Worker participant 绑定；`RuntimeLeaseController` 负责 lease create/ready/running/waiting/release/fail/stale/startup recovery；启动/关闭恢复、Coordinator assign、WorkerRuntime、ManagerLoop、ManagerPatrol 和 TaskThread 准备路径已经切到 controller surface，不再在新主路径直接调用 RuntimeLease persistence helper。
- **Phase 0 防回流护栏已自动化并加严**：`tests/hiclaw-lite-boundary.test.ts` 会扫描 `apps/server/src`，要求旧 `task-execution-service` 只能被 `orchestrator-engine.ts` 引用、旧 `local-a2a-transport` 只能被 `task-execution-service.ts` 引用，并要求 `rooms / coordinator-runtime / worker-runtime` 不得引用 `a2a-internal` 或 `local-a2a-transport` 作为内部任务通信路径。本轮还新增了 lifecycle 防回流检查：`index.ts`、`manager-loop`、`manager-patrol`、`task-thread-service`、`run-controller`、`rooms / coordinator-runtime / worker-runtime` 不能直接引用 RuntimeLease persistence helper，必须通过 `RuntimeLeaseController`。这个测试把“旧链路只能留在迁移兼容层内部、资源生命周期必须走 controller”变成了可执行边界，而不是只写在文档里。
- **已验证**：`bun test tests/dynamic-plan-coordinator-dispatch.test.ts tests/room-chat-bridge.test.ts tests/orchestrator-routing.test.ts`、`bun test tests/room-chat-bridge.test.ts tests/coordinator-runtime.test.ts tests/room-service.test.ts tests/worker-runtime.test.ts`、`bun test tests/room-timeline-projection.test.ts tests/chat-store-artifacts.test.ts tests/session-tree.test.ts`、`bun --filter @agenthub/server typecheck`、`bun --filter @agenthub/db typecheck`、`bun --filter @agenthub/web typecheck` 通过。其中 `dynamic-plan-coordinator-dispatch.test.ts` 覆盖动态 `OrchestratorPlan -> Coordinator assign batch -> task room -> WorkerRuntime -> ArtifactStore` 的新复杂任务执行入口。`room-chat-bridge.test.ts` 覆盖了两个 Worker assign 共享一个 run、两个 task room、两个 RuntimeLease、两个 artifact 的最小团队执行闭环，也覆盖了依赖任务按层执行、上游失败时下游 task room 透明记录 `skipped-by-dependency`，以及 Worker 请求澄清时 run 保持 running、task/thread/lease/worker 进入等待人类状态的 HITL path。`worker-runtime.test.ts` 覆盖了 Worker clarification request 写入 `approval.requested`、`task_clarifications` pending 记录创建、partial artifact 以 ArtifactStore `partial` 状态保存并投影到 task room timeline、RuntimeLease/WorkerInstance 进入 `waiting_for_human`，以及用户在 task room 回答澄清后把 clarification 更新为 `answered`、触发 `worker-runtime.resume-requested` 并继续 WorkerRuntime 执行；同时补充验证了同一条人类回答不会重复 resume 同一 clarification、Worker 恢复后再次澄清时会创建新的 pending clarification 并继续保持 task/thread/lease/worker 的等待人类状态、失败 task room 可通过 `rerunTaskRoom()` 重新执行成功，以及运行中会写入 `worker-runtime.heartbeat` 并在完成后停止心跳。`room-timeline-projection.test.ts` 覆盖了 `approval.requested / waiting_for_human`、依赖等待、依赖跳过和 Manager review started/final review 到前端 `blocked / failed / synthesizing / completed` 状态的投影。本轮新增验证：`bun test tests/smoke.test.ts --test-name-pattern "manager-interrupted active task rooms|retry task re-enters|manager loop final review|TaskThread room message becomes|active run becomes a human interrupt"`，覆盖 ManagerLoop 终态复盘、主群聊/TaskThread HITL、RunController 人工打断恢复、运行详情页 retry 都走 Room timeline + RunController + WorkerRuntime；`bun test tests/manager-loop-worker-runtime.test.ts tests/worker-runtime.test.ts tests/room-chat-bridge.test.ts tests/dynamic-plan-coordinator-dispatch.test.ts tests/hiclaw-lite-boundary.test.ts`，覆盖 ManagerLoop prepared task room 原生派发、旧执行链隔离边界和新内核 task room 闭环；最新复核 `bun test tests/worker-runtime.test.ts tests/manager-loop-worker-runtime.test.ts tests/manager-patrol-room-timeline.test.ts tests/room-timeline-projection.test.ts tests/room-chat-bridge.test.ts tests/dynamic-plan-coordinator-dispatch.test.ts tests/hiclaw-lite-boundary.test.ts tests/coordinator-runtime.test.ts`、`bun test tests/smoke.test.ts --test-name-pattern "manager loop final review"`、`bun test tests/room-service.test.ts tests/runtime-lease-controller.test.ts`、`bun test tests/hiclaw-lite-boundary.test.ts`、`bun --filter @agenthub/server typecheck` 和 `bun --filter @agenthub/web typecheck` 通过。

仍未完成：

- 前端已经具备 `/api/rooms` 的最小读取、replay 投影、`room:timeline` realtime WS 增量投影，以及从 Room task event 自举最小任务看板/子对话入口的能力；ManagerPatrol 的监督事件也已进入 Room timeline。但主视图还不是完整事实源：旧 messages、旧 AG-UI replay、run snapshot 和 Room timeline 仍并存，后续要继续把主视图状态统一到 Room/ArtifactStore/资源快照。
- 真实 Matrix adapter 还没有接入。
- CoordinatorRuntime 已经接入群聊入口的轻量决策，以及单任务/多任务 `assign` 派工；多个 assign 会共享一个 run 并创建多个 task room，且已具备 `taskKey / dependsOn` 的最小依赖账本和按层执行能力。动态计划成功后也已优先通过 `startPlanRunWithCoordinatorAssignBatch()` 转成 Coordinator assign batch 执行，切走了复杂任务初始分发中最危险的一段 `startPlanRunInExistingGroup -> OrchestratorEngine.startRun` 回流。人工干预、取消、启动恢复、终态 run 复盘也已从旧 Engine 外部入口切到 `Room timeline + RunController/ManagerLoop + coordinator-runtime/final-review-skill`。但冲突合并后的后续动作、模型化 review skill、复杂返工调度等控制流还没有完全迁出旧 `OrchestratorEngine` / `TaskScheduler`。
- WorkerRuntime 已经被 Coordinator assign 主线、动态计划初始分发、运行详情页单任务 retry 和 ManagerLoop prepared-task 原生派发调用，并支持进度、消息、失败、澄清请求、partial artifact 的 task room timeline 写回；澄清请求已经从纯 timeline metadata 提升为 `task_clarifications` pending/answered 资源，且会同步到 TaskThread / RuntimeLease / WorkerInstance / RunEvent 的 `waiting_for_human` 资源状态。用户回复澄清后的最小 resume path 与失败后 rerun path 已经打通。但 resume/rerun 还没有升级成长期 Worker runtime 的原生等待/恢复状态机。旧 `TaskExecutionService -> LocalA2ATransport` 的运行中复杂控制流替换仍未完成。
- RuntimeLease 已经在 Coordinator assign、WorkerRuntime、ManagerLoop prepared-task 派发、ManagerPatrol stale 检测、启动/关闭恢复中统一走 `RuntimeLeaseController`。旧 `OrchestratorEngine` 内部仍直接使用 RuntimeLease persistence helper，但它被边界测试隔离为迁移兼容层，不能重新进入新主路径。
- 主群聊/任务看板产物卡已经可以从 Room timeline + ArtifactStore object key 的 replay 和 realtime event 最小投影，但前端仍保留旧 run snapshot、message metadata 和 AG-UI cache 读取，后续要继续把实时流和资源快照统一到 Room/ArtifactStore。

## 1. 为什么这次不能继续小修旧流程

当前 AgentHub 已经做了很多补丁：TaskThread、RunEvent、WorkerController、ArtifactStore、ManagerLoop、Human Interrupt、AG-UI 投影等。但这些能力仍然部分挂在旧链路上：

```text
用户消息
  -> messages.ts
  -> Orchestrator decision
  -> manager-planner / plan-generator
  -> orchestrator_runs / workspace_tasks / sessions metadata
  -> OrchestratorEngine
  -> TaskScheduler
  -> TaskExecutionService
  -> LocalA2ATransport
  -> Code Agent / LLM fallback
  -> blackboard / execution_logs / RunEvent / AG-UI / artifact scan
```

这条链的核心问题不是“缺几个状态”，而是职责边界错了：

- `sessions + metadata` 在假装 Room。
- `workspace_tasks + task_threads + messages + RunEvent` 都在表达任务状态。
- `OrchestratorEngine` 同时承担 Manager、Scheduler、Controller、Supervisor、Synthesizer 的一部分职责。
- Worker 还是偏“一次 CLI 调用参数”，不是长期可观察、可暂停、可唤醒、可恢复的运行实体。
- 产物在 message metadata、blackboard、shared task dir、workspace_tasks cache、artifacts 表之间重复表达。
- 用户看见的是 UI 结果，不是 Agent 之间真实透明的通信时间线。

这会导致之前反复出现的问题：

- 用户发消息后空白等待。
- 子对话准备中看不到，完成后才冒出来。
- 左侧头像/子对话重复。
- Worker 明明产出文件，主群聊没有稳定产物卡。
- Orchestrator 看起来一个人做完，多 Agent 只是后台任务。
- 旧入口残留导致新设计推进时不断被污染。

因此这次重构必须明确：**旧流程只允许作为迁移输入，不允许继续作为新能力主路径。**

## 2. 产品北极星

用户看到的是 AgentHub 自己的产品体验，而不是 Element Web 或 HiClaw 控制台：

```text
用户在 AgentHub 群聊里提出目标
  -> Manager 像 AI 主管一样回应、澄清、组队、分配、跟进、验收
  -> Worker 像真实团队成员一样在 Room 中被 @、接任务、汇报、请求澄清、交付产物
  -> Human 可以随时插话、纠偏、审批、接管
  -> 主群聊展示 Manager 的组织过程和最终交付
  -> 任务子对话展示每个 Worker 的完整可审计过程
  -> 产物进入统一 Asset / Artifact 中心
```

我们要保留：

- AgentHub 自己的前端 UI。
- Coze / Kimi 风格工作台体验。
- 本地 Coding Agent 作为 Worker 的优势。
- 专家配置、模型配置、Coding Tools、Skills/MCP 能力配置。

我们要替换：

- 自研假 Room。
- 自研散乱通信语义。
- 旧 DAG-first 主脑。
- 旧 metadata 拼接状态。
- 旧 A2A-first 内部 envelope 主路径。
- 旧 OrchestratorEngine 过程式总控。

## 3. 目标分层

### 3.1 Product Shell

AgentHub 自研产品层，继续承载用户体验：

- 群聊主对话。
- Agent 私聊。
- 任务子对话。
- Agent / Expert 配置。
- Team / Group 创建和补员确认。
- 任务看板。
- 产物卡与 Asset Center。
- Trace / Eval 页面。
- 设置页和本地运行诊断。

这层不直接关心底层是 Matrix、filesystem、MinIO、OpenClaw 还是 Claude Code。它只消费统一 Kernel API。

### 3.2 HiClaw-lite Kernel

AgentHub 后端新增或重构为这些核心资源与控制器：

```text
Room
  真实通信空间。群聊、Manager DM、Worker task room、Human intervention room 都是 Room。

TimelineEvent
  Room 内消息和系统事件。包括文本、mention、任务分配、工具调用摘要、artifact 引用、审批请求。

Manager
  AI 主管。理解目标、协调 Worker、验收结果、处理 Human interruption。

Worker
  专家 Agent 的运行实例。绑定 WorkerRuntime、模型、skills、MCP、权限、工作目录、生命周期。

Run
  一次用户目标的协作过程。由 Manager 驱动，不由 DAG 硬驱动。

Task
  Manager 维护的任务账本项。可以有依赖，但依赖图是账本和恢复机制，不是唯一主脑。

Artifact
  产物一等资源。绑定 run/task/room/worker，支持预览、下载、交接和验收。

RuntimeLease
  运行时租约。表示某个 Worker 在某个任务中占用的进程、容器、工作目录、配置缓存和凭证作用域。

Human
  人类参与者。一等 Participant，可观察、插话、审批、接管。
```

### 3.3 Open-source Adapters

Kernel 不直接绑定某个实现，而通过 adapter 接开源组件：

```text
RoomService
  -> MatrixRoomAdapter

CoordinatorRuntime
  -> OpenClawAdapter
  -> QwenPawAdapter
  -> LocalLLMCoordinatorAdapter (仅兜底)

WorkerRuntime
  -> ClaudeCodeAdapter
  -> OpenCodeAdapter
  -> CodexAdapter
  -> GeminiAdapter
  -> OpenClawWorkerAdapter
  -> QwenPawWorkerAdapter

ArtifactStore
  -> LocalFilesystemArtifactAdapter
  -> S3CompatibleArtifactAdapter

GatewayService
  -> LocalGatewayAdapter
  -> LiteLLMAdapter
  -> HigressAdapter

SkillRuntime
  -> SkillMarkdownAdapter
  -> MCPTypeScriptSDKAdapter

WorkflowController
  -> LocalReconciler
  -> XStateAdapter
  -> TemporalAdapter

TraceService
  -> RunEventAdapter
  -> OpenTelemetryAdapter
  -> LangfuseAdapter
  -> PhoenixAdapter
```

## 4. 开源采用矩阵

### 4.0 四个最高优先级模块

后续实现时优先级按 HiClaw wiki 的四个核心章节排列：

1. **Manager 协调器**：对应 [hiclaw-wiki.agent.final.md](./hiclaw-wiki.agent.final.md) 第 4 章。AgentHub 的 Manager 必须成为真实协调者，而不是一个后端函数或一次性 Planner。它要有自己的 runtime、人格配置、skills、状态文件、Worker registry 和 Room 通信能力。
2. **Worker 运行时**：对应 [hiclaw-wiki.agent.final.md](./hiclaw-wiki.agent.final.md) 第 5 章。Worker 必须是可观察、可唤醒、可休眠、可回收的运行实体。Claude Code / OpenCode / Codex / Gemini 是 AgentHub 的核心 Coding Worker，OpenClaw / QwenPaw 可作为通用 Worker runtime 补充。
3. **Matrix 通信层**：对应 [hiclaw-wiki.agent.final.md](./hiclaw-wiki.agent.final.md) 第 6 章。Room / timeline / participant / mention 是协作事实源。用户、Manager、Worker 的交流必须在 Room 里可见、可审计、可插话。
4. **共享存储层**：对应 [hiclaw-wiki.agent.final.md](./hiclaw-wiki.agent.final.md) 第 7 章。第一阶段用本地 filesystem，但语义必须对齐 MinIO/S3：所有任务输入、结果、artifact、handoff ref 都进入统一 ArtifactStore / SharedStorage，不再散落在消息 metadata 或黑板里。

这四块比外围能力更重要。Trace、Eval、企业权限、Gateway、Sandbox、Task Center 都要围绕这四块服务，不能反过来喧宾夺主。

### 4.1 通信层：采用 Matrix

决策：**Matrix 是 AgentHub 新内核的通信事实源。**

用途：

- 群聊 Room。
- Manager 与 Worker 的任务 Room。
- Team Room。
- Human intervention Room。
- mention、消息、文件、系统事件、审计 timeline。

建议实现：

- 第一阶段：新增 `RoomService` 抽象，数据模型按 Matrix room/event/participant 设计。
- 第二阶段：接 `MatrixRoomAdapter`，优先评估 Tuwunel / Conduit / Synapse。
- 第三阶段：AgentHub 前端继续自研，但所有消息来自 Matrix timeline。

默认候选：

- 本地轻量优先：Tuwunel 或 Conduit。
- 兼容成熟优先：Synapse。
- 不采用 Element Web 作为默认 UI，只允许作为调试/旁观工具。

旧路径下线：

- `sessions.metadata.kind` 不再作为 Room 类型真相。
- `orchestrator-task` 子对话不再靠 metadata 拼接。
- `workspace-agent-child`、占位子会话、自动补齐 Agent 子会话彻底禁用。

### 4.2 Manager Runtime：采用 OpenClaw / QwenPaw 思想和运行时

决策：**OpenClaw / QwenPaw 是 CoordinatorRuntime 候选，不是普通 Coding Tool。**

Manager 的职责：

- 接收用户目标。
- 自然语言理解和澄清。
- 选择 Worker 或申请补员。
- 创建任务账本。
- 在 Matrix Room 中 @ Worker 分配任务。
- 跟进 Worker 回报。
- 检查 artifact。
- 要求返工或调整任务。
- 向 Human 汇报和请求审批。

Manager 的最小配置面要学习 HiClaw：

```text
manager/
  SOUL.md
  AGENTS.md
  HEARTBEAT.md
  TOOLS.md
  state.json
  workers-registry.json
  skills/
    worker-management/SKILL.md
    task-management/SKILL.md
    team-management/SKILL.md
    artifact-review/SKILL.md
    human-approval/SKILL.md
```

第一阶段可以不完全照搬文件名，但必须具备同等语义：

- Manager 有稳定身份和人格配置。
- Manager 有自己的 skills，而不是后端代码替它偷偷判断。
- Manager 有 Worker registry，可以知道谁可用、谁忙、谁 sleeping、谁失败。
- Manager 通过 Matrix Room 说话、@ 人、分配任务、催办、验收。
- Manager 能周期性 heartbeat / patrol，而不是只在用户发消息时运行。

目标结构：

```text
CoordinatorRuntime
  OpenClawCoordinator
  QwenPawCoordinator
  LocalLLMCoordinatorFallback
```

旧路径下线：

- `manager-planner.ts` 只能作为过渡工具或 planning skill，不应长期作为 Manager 主脑。
- `planner.ts` 不再负责意图判断和任务分工主路径。
- `OrchestratorEngine` 不再新增 Manager 决策逻辑，只允许迁移期执行兼容。

### 4.3 Worker Runtime：学习 HiClaw，但保留 Coding Agent 优势

决策：**WorkerRuntime 采用多运行时模型。Claude Code / OpenCode / Codex / Gemini 是 AgentHub 的核心 Worker 基底。**

支持方向：

```text
WorkerRuntime
  claude-code
  opencode
  codex
  gemini
  openclaw-worker
  qwenpaw-worker
  local-llm-worker (仅兜底)
```

Worker 必须成为一等运行实体：

- 独立 worker id。
- 独立 Matrix account / participant。
- 独立 model binding。
- 独立 skills / MCP scope。
- 独立 workspace / temp / cache / config / session。
- 独立 runtime lease。
- 可 ready / busy / idle / sleeping / stopped / failed。

Worker 的最小运行时语义要学习 HiClaw：

```text
WorkerSpec
  role / profile / skills / mcp scope / model binding / runtime / permissions

WorkerStatus
  observed state / current task / room id / heartbeat / last error / artifact refs

WorkerRuntime
  receive Matrix event
  execute task
  report progress
  ask clarification
  publish artifact
  sleep / wake / stop
```

AgentHub 的差异化在于 WorkerRuntime 不只支持 OpenClaw/QwenPaw：

- `claude-code` 适合复杂代码修改和项目级工程。
- `opencode` 适合 OpenAI-compatible 模型和开放配置。
- `codex` 适合 Codex 官方能力和代码任务。
- `gemini` 适合 Gemini CLI 能力。
- `openclaw-worker` / `qwenpaw-worker` 适合更轻量的对话/工具型 worker。

无论底层 CLI 是否常驻，产品和控制平面都必须表现为一个真实 Worker：有 Room 身份、有状态、有任务、有产物、有可回收生命周期。

旧路径下线：

- Worker 不再只是 `workspace_agents` 上的配置行。
- Code Agent 执行不再只是一段 `runAgentReply()` 临时调用。
- 不再允许工具页模型配置影响 Worker 执行，模型只来自 Agent/Worker 绑定和 Gateway。

### 4.4 共享存储：先 filesystem，接口按 S3-compatible

决策：**第一阶段不引入 MinIO 默认依赖，但 ArtifactStore 必须按 S3-compatible 心智设计。**

短期：

```text
LocalFilesystemArtifactStore
  root = 用户数据目录 / AgentHub / artifacts
  shared task = 用户数据目录 / AgentHub / shared/tasks/{taskId}
```

长期：

```text
S3CompatibleArtifactStore
  MinIO / Garage / AWS S3 / OSS / R2
```

注意：

- MinIO 可作为可选 adapter，不作为第一阶段必装依赖。
- filesystem 是实现 adapter，不是架构真相。
- 所有产物必须登记到 ArtifactStore，不再只靠扫描或消息 metadata。

共享存储要承担四类内容：

```text
agent state
  Manager/Worker 的配置、状态快照、skills 版本。

task workspace
  spec.md、plan.md、result.md、artifacts/、logs/。

shared artifacts
  HTML、PDF、报告、代码包、图片、数据文件、截图。

handoff refs
  上下游任务之间传递的稳定引用，而不是相对路径猜测。
```

第一阶段本地目录建议按对象存储语义组织：

```text
{agenthubDataRoot}/storage/
  agents/{agentId}/...
  manager/{managerId}/...
  rooms/{roomId}/attachments/...
  runs/{runId}/...
  tasks/{taskId}/spec.md
  tasks/{taskId}/plan.md
  tasks/{taskId}/result.md
  tasks/{taskId}/artifacts/{artifactId}/...
```

以后切到 MinIO/S3 时，以上路径可以直接变成 object key，不需要重写上层业务。

旧路径下线：

- `.agenthub/handoff` 只作为历史读取，不再写新主路径。
- `workspace_tasks.artifacts` JSON 只能是缓存，不是事实源。
- blackboard 只保存 artifact ref，不保存事实产物清单。

### 4.5 AI Gateway：抽象 GatewayAdapter，短期 LiteLLM，长期 Higress

决策：**GatewayService 是必做抽象；具体实现分阶段接入。**

候选判断：

| 方案 | 定位 | AgentHub 使用建议 |
|---|---|---|
| Higress | AI Gateway + MCP Gateway + 凭证治理 + 限流审计 | 长期目标，最贴近 HiClaw |
| LiteLLM Proxy | 统一 LLM proxy，OpenAI-compatible，多模型路由、fallback、budget | 短期优先，落地快 |
| Portkey Gateway | AI gateway、路由、缓存、guardrails、观测 | 可选评估 |
| Envoy AI Gateway | 云原生 AI gateway | 后续云部署再评估 |

阶段策略：

```text
Phase A: LocalGatewayAdapter
  读取模型目录，生成 per-worker env，最小化改动。

Phase B: LiteLLMAdapter
  本地或远程 LiteLLM proxy 统一模型入口。

Phase C: HigressAdapter
  模型、MCP、凭证、consumer token、审计、限流统一进入 Gateway。
```

关键原则：

- Worker 不直接拿所有真实 key。
- Worker 只拿本次 RuntimeLease 需要的最小凭证或 consumer token。
- Gateway 负责模型路由、MCP scope、credential redaction 和审计。

旧路径下线：

- 不再把 raw API key 到处注入给 CLI。
- 不再允许 Coding Tools 页面保存运行时模型字段。
- 不再允许不同 Agent 的模型配置串用同一份 CLI config/cache。

### 4.6 A2A：降级为外部互操作，不作为第一阶段主通信层

决策：**Matrix 是通信事实源；A2A 暂不作为主路径。**

原因：

```text
Matrix 解决“所有 Agent 交流可见、可审计、人可插话”。
A2A 解决“跨 Agent 系统的任务语义互操作”。
```

当前最需要的是 HiClaw 式透明协作，所以主路径应先走 Matrix。

A2A 保留位置：

- 外部 AgentHub API。
- 远程 Agent 接入。
- Matrix event payload 中可嵌入的 task semantic envelope。
- 后续对外暴露 AgentHub Worker/Manager 能力。

旧路径下线：

- `LocalA2ATransport` 不再作为 AgentHub 内部通信主干。
- A2A 不再写成 Agent 类型、runtimeType 或 UI 创建项。
- 旧 A2A envelope 可以迁移为 Matrix event 的可选 `taskEnvelope` 字段。

### 4.7 AG-UI：继续作为前端投影协议

决策：**AG-UI 是 UI 事件协议，不是业务事实源。**

新关系：

```text
Matrix timeline + Kernel resource state
  -> AG-UI Projection
  -> AgentHub 前端任务看板 / 进度条 / 产物卡 / tabs
```

AG-UI 不负责决定任务状态，只负责把 Room/Run/Task/Worker/Artifact 状态投影给前端。

旧路径下线：

- 前端不再从多个旧 metadata 拼运行态。
- AG-UI event payload 不完整时，不允许覆盖服务端 snapshot 的完整字段。

### 4.8 MCP：采用 MCP TypeScript SDK

决策：**MCP 是 Worker 能力层，正式接 MCP SDK。**

目标：

- MCP server registry。
- 每个 Worker / RuntimeLease 有 MCP scope。
- Gateway 负责 MCP 凭证和访问控制。
- Skills 可以声明依赖 MCP。

旧路径下线：

- 不再把 MCP 当 Agent 类型。
- 不再在各个 adapter 里手写不一致的 MCP 注入逻辑。

### 4.9 Skills：采用 SKILL.md 目录模型

决策：**Skills 学 HiClaw / Claude Code 目录模型，成为 Manager 和 Worker 的 action surface。**

标准结构：

```text
skills/{skillId}/
  SKILL.md
  scripts/
  assets/
  manifest.json
```

Manager Skills：

- worker-management
- team-management
- task-management
- artifact-review
- human-approval
- model-switch
- mcp-management
- project-management

Worker Skills：

- research
- frontend-build
- backend-build
- report-writing
- data-analysis
- test-and-qa
- file-sync
- artifact-publish

旧路径下线：

- 不恢复固定场景 spec 模板。
- Skills 不做关键词触发路由。
- Skills 只能作为 Manager/Worker 可调用能力，由 runtime 决定是否调用。

### 4.10 工作流与生命周期：本地 Reconciler 优先，评估 XState / Temporal

决策：**生命周期不再靠单次函数链赌成功，采用 controller/reconciler。**

短期：

- 自研 LocalReconciler，但只写资源收敛逻辑，不写智能决策。
- RunController / WorkerController / RoomController / ArtifactController / RuntimeLeaseController 分开。

中期：

- XState 管本地状态机。

长期：

- Temporal 管长任务、重试、恢复、分布式 worker。

旧路径下线：

- `OrchestratorEngine` 不再作为生命周期总控。
- `TaskScheduler` 不再自己处理所有 recovery / retry / replan 分支。
- `messages.ts` 不再创建一堆任务、session、event 并直接启动执行。

### 4.11 Trace / Eval：OpenTelemetry + Langfuse/Phoenix

决策：**RunEvent 保留为 Kernel 内部事件流，但 Trace/Eval 产品层不要全手搓。**

目标：

- OpenTelemetry trace id 贯穿 user message、Manager action、Matrix event、Worker runtime、tool call、artifact。
- Langfuse/Phoenix 记录 LLM 调用、prompt、模型、token、latency、error、eval。
- AgentHub 前端做自己的 Trace/Eval 页面。

旧路径下线：

- `execution_logs` 不再是唯一调试入口。
- 不再只靠散乱 server log 排查 Agent 运行。

### 4.12 沙箱：保留 local-workdir，后续接成熟 sandbox

决策：**短期默认 local-workdir，后续 sandbox adapter 接成熟方案。**

候选：

- Docker Sandboxes
- Daytona
- E2B
- Devbox
- Firecracker 类隔离方案

当前原则：

- 每个 Worker/RuntimeLease 独立 HOME / APPDATA / LOCALAPPDATA / cache / config / tmp。
- 本地优先，避免启动过重。
- 明确告诉用户 local-workdir 不是 OS 级沙箱。

旧路径下线：

- 不再假装 local-workdir 是安全沙箱。
- 不再支持公开 `read-only` code-agent 权限项。

### 4.13 队列和事件总线：先 DB event，后续 NATS / Redis Streams / BullMQ

决策：**第一阶段不先引入消息队列，但接口要避免继续绑定内存事件。**

短期：

- SQLite / DB persisted events。
- WebSocket 只做订阅投影。

中期：

- NATS 或 Redis Streams 承接 worker heartbeat、room bridge、artifact indexing、trace export。

旧路径下线：

- 不再依赖浏览器当前状态拼接关键运行态。
- 不再依赖进程内 memory map 作为唯一运行事实。

## 5. 新内核完整路径

### 5.1 简单聊天

```text
Human 在 AgentHub 群聊发送消息
  -> Product Shell 调 RoomService.sendMessage()
  -> Matrix Room 写入 human message
  -> ManagerRuntime 收到 room event
  -> Manager 判断这是普通聊天
  -> Manager 在同一 Room 回复
  -> AgentHub 前端从 Matrix timeline / AG-UI projection 显示
```

关键点：

- 不应该每句话都强行创建 DAG。
- Manager 需要像人一样判断是闲聊、澄清、任务、补员还是继续当前 run。

### 5.2 复杂任务

```text
Human 提出目标
  -> Matrix group room timeline 记录消息
  -> ManagerRuntime observe
  -> Manager 生成初步意图：需要组队/派活
  -> Room 中可见地说明“我来组织”
  -> Manager 查询 Worker registry
  -> 能力不足则发 member proposal，等待 Human 确认
  -> 能力足够则创建 Run / Task ledger
  -> RoomController 创建 task rooms
  -> Manager 在 task room @ Worker 分配任务
  -> WorkerRuntime 接收 Matrix event
  -> Worker 执行并在 task room 汇报过程
  -> ArtifactStore 登记产物
  -> Manager review artifact/result
  -> 不合格则在 task room 要求返工
  -> 合格则主群聊汇报
  -> Manager 汇总最终结果
```

关键点：

- DAG 是任务账本和恢复机制，不是主脑。
- Manager 通过 Room 管理 Worker，不通过隐藏 metadata。
- Human 可随时在主群聊或 task room 插话。

### 5.3 Worker 执行

```text
Manager @ Worker
  -> WorkerRuntimeAdapter 收到 task assignment event
  -> WorkerController ensureReady(worker)
  -> RuntimeLeaseController acquire lease
  -> GatewayService issue scoped credentials
  -> ArtifactStore prepare task workspace
  -> CLI / runtime 执行
  -> Worker 将进度、错误、澄清、产物引用写回 task room
  -> RuntimeLease release / sleep
```

关键点：

- Worker 可以常驻、sleeping 或按需启动，但在产品语义上必须是“真实成员”。
- CLI 做完就退出可以接受，但 WorkerInstance 和 Room 身份不能消失。

## 6. 旧路径下线总表

| 旧路径 / 旧概念 | 新位置 | 策略 |
|---|---|---|
| `sessions.metadata.kind` 作为 Room 类型真相 | Matrix Room / RoomService | 停止新写；迁移读取；UI 不再依赖 |
| `orchestrator-task` metadata 拼子对话 | Task Room | 停止作为事实源 |
| `workspace-agent-child` | 无 | 删除入口，不迁移 |
| `GroupChatManager` | RoomService + ManagerRuntime | 不恢复 |
| `OrchestratorEngine` 总控 | ManagerRuntime + RunController + WorkerController | 冻结新增，逐步抽空 |
| `Planner` 主脑 | Manager planning skill | 不再主路径调用 |
| `TaskScheduler` 总调度 | TaskLedger + WorkerController | 只保留过渡执行 |
| `LocalA2ATransport` 主通信 | MatrixRoomAdapter | 降级为外部互操作/兼容 |
| blackboard 作为协作事实源 | ArtifactStore / Room timeline / Task ledger | 降级为索引/摘要 |
| `.agenthub/handoff` | ArtifactStore | 只读兼容 |
| `workspace_tasks.artifacts` | ArtifactStore | 缓存 |
| Coding Tools 模型字段 | Agent/Worker model binding + Gateway | 删除写入 |
| 静态模板/关键词路由 | ManagerRuntime 决策 | 禁止恢复 |
| 静态 fallback 内容 | 透明错误/重试 | 禁止恢复 |

## 7. 数据迁移原则

这次重构以新内核为唯一目标。旧数据没有就没有，历史库可以清掉；迁移读取只是可选体验优化，不是架构约束。

### 7.1 允许

- 读取历史 `sessions/messages` 展示旧聊天。
- 把历史 `orchestrator-task` 投影成只读旧 task room。
- 把历史 artifact metadata 导入 ArtifactStore。
- 把旧 RunEvent 转成 Trace 历史。
- 开发阶段直接清除旧数据库和旧 workspace/storage 数据，以新内核重新初始化。

### 7.2 禁止

- 为了旧数据继续保留旧执行主路径。
- 为了旧会话树继续保留旧 UI 入口。
- 为了旧 schema 继续设计新资源模型。
- 新任务继续写 `workspace-agent-child`。
- 新 Room 继续以 `sessions.metadata.kind` 作为真相。
- 新任务继续以 A2A envelope 为内部主通信。
- 新产物只写 message metadata。
- 新 Manager 决策继续走关键词、固定模板或旧 Planner 主路径。

### 7.3 下线节奏

```text
新内核初始化期
  允许清库、清旧 workspace/storage、重新创建 Room/Worker/Artifact/Gateway 数据。

旧数据只读期
  如果成本低，可以做只读投影；如果成本高，直接提示旧数据需清理或不可用于新内核。

入口删除期
  UI 和 API 删除旧入口。旧接口只返回迁移提示或 410/disabled。

清理期
  提供“清除所有数据”，让用户回到新内核第一次启动状态。
```

## 8. 资源模型草案

### 8.1 Room

```text
room_id
provider: matrix
provider_room_id
kind: group | manager_dm | task | direct | human_intervention
workspace_id
run_id?
task_id?
participants[]
created_at
status: active | archived | failed
```

### 8.2 TimelineEvent

```text
event_id
room_id
provider_event_id
sender_participant_id
type: message | mention | task.assigned | task.progress | artifact.created | approval.requested | system
body
metadata
sequence
created_at
```

### 8.3 WorkerInstance

```text
worker_instance_id
workspace_agent_id
room_participant_id
runtime_type: claude-code | opencode | codex | gemini | openclaw | qwenpaw
model_binding_id
skill_ids[]
mcp_scope[]
desired_state: running | sleeping | stopped
observed_state: provisioning | ready | busy | idle | sleeping | stopped | failed
last_heartbeat_at
```

### 8.4 RuntimeLease

```text
runtime_lease_id
worker_instance_id
run_id
task_id
sandbox_provider
workdir
home_dir
cache_dir
config_dir
gateway_credential_ref
status: creating | ready | running | cleaning | released | stale | failed
```

### 8.5 Artifact

```text
artifact_id
run_id
task_id
room_id
worker_instance_id
storage_provider
storage_key
mime_type
kind: report | html | pdf | code | image | data | log | other
summary
created_at
```

## 9. 实施阶段

### Phase 0：冻结旧路径

目标：阻止旧设计继续扩散。

任务：

- 标记 `OrchestratorEngine` 为 migration-only。
- 禁止新增 `workspace-agent-child`。
- 禁止新增固定模板、关键词路由、静态 fallback。
- 禁止 `sessions.metadata.kind` 作为新 Room 判断真相。
- 文档和 AGENTS 统一新口径。

验收：

- 新代码 review 时能明确判断是否在增加旧路径。

### Phase 1：RoomService + Matrix-compatible 本地 Adapter

目标：通信先换血。

任务：

- 新增 `RoomService`、`ParticipantService`、`TimelineService`。
- 定义 Matrix-compatible event schema。
- 第一版实现 `LocalMatrixCompatibleRoomAdapter`：用 SQLite/filesystem 保存 room、participant、timeline event，但字段和语义按 Matrix 设计。
- 真实 `MatrixRoomAdapter` 只做 POC 或 feature flag，不作为第一阶段必跑依赖。
- 群聊、task room、direct room 都走 RoomService。
- 前端先通过兼容 Room API 读取主群聊和 task room，逐步停止从 session metadata 拼。

验收：

- 主群聊和 task room 都有稳定 `roomId`。
- Manager @ Worker 是 timeline event。
- 用户进入 task room 能看到 Room timeline。
- 不启动真实 Matrix homeserver 时也能通过本地 adapter 完成以上验收。

### Phase 2：CoordinatorRuntime 壳 + Manager 配置

目标：Manager 从 prompt function 变成运行时。

任务：

- 新增 `CoordinatorRuntime` 接口。
- 实现 `LocalCoordinatorRuntime` 过渡 adapter，用现有内部模型输出 Manager action，但通过 CoordinatorRuntime 接口运行。
- 实现 OpenClaw/QwenPaw adapter 调研版或 skeleton，不要求第一阶段主路径跑通。
- Manager SOUL / AGENTS / SKILL.md 配置目录化。
- Manager 从 Matrix room 接收消息并输出 action。
- `manager-planner.ts` 改造成 Manager 可调用 planning skill。

验收：

- Manager 能在 room 中自然回复、追问、分配。
- 简单消息不会强行规划。
- 复杂目标能创建 task ledger 并 @ Worker。
- OpenClaw/QwenPaw adapter 有清晰接口和 POC 计划，但不阻塞本地 Manager 跑通。

### Phase 3：WorkerRuntime 资源化

目标：Worker 真正成为团队成员。

任务：

- `WorkerInstance` 绑定 Matrix participant。
- Claude Code / OpenCode / Codex / Gemini adapter 接入 WorkerRuntime。
- Worker 从 task room 接任务。
- Worker 过程写回 room timeline。
- RuntimeLease 管独立 workdir/home/cache/config/env。

验收：

- 每个 Worker 有自己的 room 身份。
- Worker 失败和部分产物都能在 task room 看到。
- 切换页面不丢状态。

### Phase 4：ArtifactStore 收口

目标：产物唯一事实源。

任务：

- filesystem ArtifactStore 成为默认实现。
- 所有产物创建都走 ArtifactController。
- 主群聊产物卡从 ArtifactStore 投影。
- task room 中 artifact event 自动关联 artifact id。

验收：

- Worker 产物不会“文件有但 UI 没有”。
- 下游读取 artifact ref，不猜相对路径。

### Phase 5：GatewayAdapter

目标：模型、MCP、凭证治理进入统一网关。

任务：

- 抽象 GatewayService。
- 短期 LocalGatewayAdapter。
- 接 LiteLLM adapter 作为快速统一模型入口。
- 设计 Higress adapter。
- RuntimeLease 获取 scoped credential，不直接拿全局 key。

验收：

- 不同 Worker 的 `code agent × model` 不串。
- Worker env 可审计、可 redaction。
- MCP scope 可配置。

### Phase 6：Controller/Reconciler 完整化

目标：生命周期不再靠一次函数链。

任务：

- RunController / RoomController / WorkerController / RuntimeLeaseController / ArtifactController 分开。
- 每个资源有 desired state 和 observed state。
- Reconcile loop 负责恢复、清理、idle-stop、stale lease。
- 评估 XState / Temporal 接入。

验收：

- 服务重启后 active run 可恢复或透明标记。
- Worker 卡死能被发现和回收。
- 用户能停止、暂停、恢复任务。

### Phase 7：Trace/Eval 产品化

目标：能证明多 Agent 协作发生了什么，以及为什么比单 Agent 好。

任务：

- OpenTelemetry trace id 贯通。
- Langfuse/Phoenix adapter。
- AgentHub Trace 页面。
- Eval case：单 Agent vs Manager-Workers。

验收：

- 任一失败能追到 Manager action、Worker event、CLI log、artifact、模型调用。

## 10. 第一批最小切片

不要一次性全推倒。第一批应该做可验证闭环：

### Slice 1：RoomService 本地抽象

```text
新增 Room/Timeline/Participant 服务
让新群聊和新 task thread 通过 RoomService 创建
旧 sessions 只做只读投影
```

### Slice 2：LocalMatrixCompatibleRoomAdapter

```text
不启动真实 Matrix homeserver
用 SQLite/filesystem 保存 Matrix-compatible room event
AgentHub 发送/读取 room event
前端显示 Room timeline
Manager/Worker 用 participant 身份发消息
```

### Slice 3：真实 Matrix Adapter POC

```text
本地启动 Tuwunel / Conduit / Synapse 之一
MatrixRoomAdapter 创建 room、发消息、读 timeline
与 LocalMatrixCompatibleRoomAdapter 共用同一 RoomService 接口
```

### Slice 4：ManagerRuntime 壳

```text
CoordinatorRuntime 接口
LocalLLMCoordinatorFallback 只作兜底
OpenClaw/QwenPaw adapter POC
Manager 从 Room event 决定 reply / clarify / assign / wait
```

### Slice 5：Worker task room

```text
Manager 在 task room @ Worker
WorkerRuntime 接收任务
CLI 执行过程写回 task room
ArtifactStore 登记产物
```

这四个切片完成后，用户体验应该从“流程引擎在后台跑”变成“我能看到 Manager 正在群里带人干活”。

## 11. 风险和决策

### 11.1 Matrix 引入复杂度

风险：

- 本地启动和账号管理复杂。
- Windows 开发环境可能有兼容问题。
- Matrix event 到前端状态需要 projection。

缓解：

- 先做 RoomService 抽象。
- 提供 embedded local Matrix 启动器。
- 保留 local memory/sqlite adapter 只做测试，不做产品默认事实。

### 11.2 OpenClaw/QwenPaw 接入成本

风险：

- 运行时接口和我们现有模型/skill配置不同。
- 本地资源占用和安装复杂。

缓解：

- 先作为 CoordinatorRuntime POC。
- 不阻塞 WorkerRuntime 继续使用 Claude Code/OpenCode/Codex。
- Manager config 使用 SOUL.md / AGENTS.md / SKILL.md 目录模型对齐。

### 11.3 Higress 偏重

风险：

- 对本地桌面产品太重。
- 安装和调试成本高。

缓解：

- GatewayAdapter 先抽象。
- 短期用 LocalGateway / LiteLLM。
- Higress 作为长期正式 adapter。

### 11.4 旧数据迁移

风险：

- 旧会话、旧任务、旧 artifact 展示断裂。

缓解：

- 旧数据只读投影。
- 开发阶段提供清除所有旧数据功能。
- 不为了旧数据保留旧执行入口。

### 11.5 企业级能力暂缓边界

HiClaw 很强的一部分来自企业级基础设施，但 AgentHub 当前是比赛项目和本地优先产品，不应该第一阶段把企业部署复杂度全部搬进来。我们要保留抽象和接口，不把重组件变成默认依赖。

暂缓默认实现：

| 企业级能力 | HiClaw / 业内做法 | AgentHub 当前策略 |
|---|---|---|
| Kubernetes / CRD / Operator | 用 CRD 管 Worker、Manager、Team、Human，Controller reconcile | 学 Reconciler 思想，但先用本地 Controller + DB 状态，不默认上 K8s |
| Helm / 多容器生产部署 | controller、Matrix、MinIO、Higress、Manager、Worker 分容器 | 暂不做完整 Helm，先保证本地一键开发和轻量服务 |
| 多租户组织权限 | org/project/space/user/group/role/permission | 先做单用户/单 workspace 心智，保留 participant/permission 字段 |
| 企业 SSO / SAML / OIDC | 企业统一登录和身份同步 | 暂不做，先保留 auth provider 抽象 |
| 细粒度 RBAC / ABAC | 每个 room、worker、mcp、artifact 都有权限策略 | 第一阶段只做 owner/admin/member 和危险动作确认 |
| Gateway consumer token 全治理 | Worker 只拿 consumer token，真实 key 在 Higress/Vault | 短期 LocalGateway/LiteLLM，长期再接 Higress/Vault |
| Secret rotation / audit | 密钥轮换、审计、吊销、最小权限 | 先做 secret redaction 和 per-runtime scoped env |
| 企业审计合规 | 完整审计日志、留存策略、导出、合规搜索 | 先保证 Matrix timeline + RunEvent + Trace 可回放 |
| HA / 高可用 | 多副本、leader election、故障转移 | 暂不做，先做进程重启恢复和 stale recovery |
| 分布式队列 | NATS / Redis Streams / Kafka | 暂不默认引入，先 DB events，后续 adapter |
| 对象存储集群 | MinIO/S3/OSS/R2 + lifecycle policy | 先 filesystem，ArtifactStore 接口按 S3-compatible |
| 网络隔离 / Zero Trust | per-worker network policy、egress control | 第一阶段只做 runtime lease/env/workdir 隔离和危险权限提示 |
| 配额 / 计费 / 成本中心 | token budget、团队账单、资源配额 | 先做 token/latency trace，不做计费 |
| 企业级 Eval 平台 | 数据集、基准、回归、审批流 | 先做关键 trace 和少量 demo eval case |
| Worker marketplace 治理 | 模板审核、版本、签名、许可证扫描 | 先内置少量专家模板，不做市场 |

第一阶段必须避免的误区：

- 不为了“像 HiClaw”而默认要求用户启动一整套 K8s / Higress / MinIO / Matrix / Gateway 集群。
- 不把企业权限、组织、多租户、审计、计费放到当前主线前面。
- 不因为暂缓企业能力而继续手搓错误边界；接口和资源模型仍要按未来可扩展设计。

当前最小企业级保留项：

- 资源都有 stable id、owner、status、createdAt/updatedAt。
- Room / Artifact / Worker / Gateway 都有 provider adapter 抽象。
- RuntimeLease 记录本次执行的凭证作用域、workdir、sandbox、worker、task。
- 日志和 trace 做 secret redaction。
- 高风险动作进入 Human approval。

也就是说：**企业级能力先设计边界，不做重实现；本地体验、透明协作、真实 Worker 执行和产物交付优先。**

## 12. 最终验收标准

这次重构成功不是看表多了多少，而是看体验是否像 HiClaw 的内核：

- 用户说“大家好”，Manager 可以在 Room 中 @ 成员回应，而不是所有消息都进入硬规划。
- 用户发复杂目标，Manager 先自然承接，再可见地组织团队。
- 每个 Worker 都有稳定身份、房间、状态和产物。
- 用户能进入任一 task room 看到完整交流。
- 用户插话能被 Manager 接住，任务能暂停/调整/返工。
- Worker 失败、超时、部分产物都透明可见。
- 页面刷新、切换子对话、服务重启后，运行态可恢复或透明说明。
- 产物卡一定来自 ArtifactStore。
- 模型、MCP、凭证不串。
- 新功能不再依赖旧 metadata、旧模板、旧 Planner、旧 OrchestratorEngine 主控。

## 13. 当前结论

推荐的最终技术路线：

```text
通信：Matrix
  Room / Timeline / Participant / Mention 成为真实协作基础。

Manager Runtime：OpenClaw / QwenPaw
  作为 CoordinatorRuntime，不再用旧 Planner/OrchestratorEngine 当主脑。

Worker Runtime：Claude Code / OpenCode / Codex / Gemini + OpenClaw/QwenPaw 可选
  Coding Agent 是 AgentHub 的核心优势。

共享存储：filesystem first, S3-compatible later
  本地轻量，接口不锁死。

AI Gateway：Local/LiteLLM short-term, Higress long-term
  统一模型、MCP、凭证、审计。

A2A：外部互操作层
  不作为第一阶段内部通信主路径。

AG-UI：前端投影
  不作为业务事实源。

MCP：官方 SDK
  能力层标准化。

Lifecycle：Reconciler first, XState/Temporal later
  不再靠一次函数链赌成功。

Trace：OpenTelemetry + Langfuse/Phoenix
  可观测和评估产品化。
```

一句话：**AgentHub 前端继续做我们自己的开源 Coze/Kimi 风格工作台；底层换成 HiClaw-lite 开源内核，通信、运行时、网关、MCP、Trace、存储、沙箱尽量用成熟开源组件，旧流程只允许迁移读取，不允许继续驱动新能力。**

## 14. 参考依据和取舍原则

本轮重构可以直接参考以下两类资料：

- [hiclaw-wiki.agent.final.md](./hiclaw-wiki.agent.final.md)：作为 HiClaw 架构分层、Manager-Workers 思想、Room/Storage/Gateway/Controller 设计的文字依据。
- [../hiclaw源码参考/](../hiclaw源码参考/)：作为 HiClaw 实际源码结构、Manager 配置、skills、controller/reconciler、worker runtime、Matrix/MinIO/Higress 接入方式的本地源码依据。

使用这些资料时要区分“直接采用”和“吸收思想”：

- Matrix 通信、Manager/Worker runtime 思想、Room timeline、Human-in-the-Loop、Worker lifecycle、Skill 目录模型、Gateway consumer 思想，是本轮重构的核心依据。
- Kubernetes、企业多租户、完整 Higress all-in-one、Element Web、复杂 CRD 部署，不作为 AgentHub 第一阶段默认依赖。
- AgentHub 前端产品形态、专家配置、Coding Agent Worker 适配、模型组合体验，是我们自己的产品差异化，不照搬 HiClaw UI。

旧路径和旧数据不再作为架构约束：

- 当前仍在开发阶段，历史任务、历史会话、历史数据库数据可以丢弃。
- 旧数据能低成本只读展示就展示，不能展示也可以通过“清除所有数据 / 重建新内核数据”解决。
- 不允许为了保留旧数据而保留旧 `sessions.metadata`、旧 `OrchestratorEngine` 主控、旧 Planner 主脑、旧 A2A 主通信、旧 handoff、旧固定模板或旧 UI 入口。
- 数据迁移服务于新内核，而不是让新内核迁就旧设计。
