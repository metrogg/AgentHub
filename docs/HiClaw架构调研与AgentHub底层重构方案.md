# HiClaw Manager-Worker 架构调研与 AgentHub 底层重构方案

> 状态：重构施工文档（Phase 6 第一轮已完成；当前主路径已开始进入 Room / Worker / RuntimeLease controller 化）  
> 目标：把 AgentHub 从“DAG-first 流程引擎”升级为“Manager-led Team Runtime + 资源控制平面”的多 Coding Agent 协作内核。

## 0. 实施前审查结论

这份方案的方向是对的，但核心要进一步校准：AgentHub 不应该只是把 `messages.ts -> OrchestratorEngine -> TaskExecutionService` 的过程式链路换成更复杂的 DAG 控制器，而应该学习 HiClaw 的 Manager-Workers 思想，让 Orchestrator/Manager 像一个团队负责人一样持续经营任务。

新的主轴是：

```text
用户委托目标
  -> Manager 理解目标、判断是否需要组队/补员/澄清
  -> Manager 创建和维护任务账本
  -> Manager 通过 TaskThread 与 Worker 沟通
  -> Worker 在真实子对话和运行时中执行
  -> Manager 观察回报、检查产物、追问、返工、调整分工
  -> Manager 汇总并向用户交付
```

这里还要把一个原则显式钉住，避免后续实现时又被“流程引擎心智”吃掉：

- **Human-in-the-Loop 不是附加功能，而是内核约束。**
- 人类参与者不是偶尔点确认框的旁观者，而是 Team Runtime 中的**一等公民**。
- Manager-Workers 架构的意义之一，就是把“盯每个 Worker 执行细节”的负担从 Human 身上拿走，让 Human 主要关注目标、约束、风险、审批、纠偏和验收。
- 因此 AgentHub 的群聊、TaskThread、RunController、ManagerLoop、AG-UI 投影，都必须围绕“Human 可观察、可插话、可纠偏、可接管”来设计。

`Run / Task / TaskThread / WorkerInstance / Artifact / RuntimeLease / RunEvent` 仍然要做成稳定资源，但它们服务的是 Manager-led 协作，而不是让系统变成一个更僵硬的 DAG-first 编排器。

但它不能被理解为“马上整块推倒重写”的施工单。真正安全的重构必须遵守以下约束：

1. 先建立投影层，再切换 UI 和执行路径。旧表和旧会话在迁移期只能被投影或隐藏，不能一刀删掉导致历史运行不可读。
2. 先做 `ManagerLoop 壳 + RunEvent + TaskThread`，再做 `ArtifactStore`，再做 `WorkerInstance / RuntimeLease`，最后让 `RunController` 替代 `OrchestratorEngine` 主流程。不要先接 OpenClaw 或重写执行器。
3. 每个新资源必须有稳定 ID、唯一约束、状态映射、事件重放和降级策略。没有这些，就只是把旧混乱换了名字。
4. OpenClaw / CoPaw 只能作为指挥型 runtime 的候选接入，必须先完成官方文档和源码级 adapter 调研，不能凭概念直接写入主路径。
5. A2A、AG-UI、MCP、Skills 的分层不能被打乱：A2A 是 Agent 间通信语义，AG-UI 是 UI 事件投影，MCP/Skills 是 Code Agent 能力层，不是 Agent 类型。

判断标准很简单：完成每个阶段后，用户应该感觉“我把事情交给了一个 Manager，它正在带团队推进”，并且能清楚看到“谁在干、干到哪、产物在哪、失败在哪里”，而不是看到更多表、更多入口和更多状态名。

### 0.1 当前仓库施工基线

后续开 goal 时不要把本文档当成“从零开始”的清单。当前仓库已经有一部分基础资源落地，下一步应在此基础上继续收口，而不是重复建表或另起一套名字：

- 已新增 `task_threads` 迁移和 `TaskThread` 服务雏形，任务子对话应继续向 TaskThread 一等资源收敛。
- 已新增 `artifacts` 迁移和 `ArtifactStore` 服务雏形，产物卡和 handoff 应继续向 ArtifactStore 收敛。
- 已新增 `worker_instances` / `runtime_leases` 迁移和 Worker runtime resource 服务雏形；RuntimeLease 生命周期已经由 `RuntimeLeaseController` 统一承接 create/ready/running/waiting/release/fail/stale/startup recovery，新主路径不应再直接调用底层 persistence helper。
- 已开始把 `workerInstanceId`、`taskThreadId`、artifact snapshot 投影进 RunEvent / AG-UI / 前端 store，但 UI 运行态还没有彻底只从 RunEvent 恢复。
- `/api/orchestrator-runs/:id` 已开始前推 `runtimeActivitySnapshot`，把“当前谁在执行 / Orchestrator 是否还在 planning / synthesizing”作为服务端控制面事实返回；前端应优先消费该 snapshot，再把 AG-UI replay 与本地 task board 推导作为 fallback。
- `TaskThread` 的 `prepared / assigned / active / completed` 语义要尽量一路保留到前端投影，不要在中途全部压扁为普通 task status。左侧子对话、Agent tabs、任务看板与主群聊汇报应优先体现 TaskThread 资源状态，再退回任务状态。
- 已开始落地 `.agenthub/shared/tasks/{taskId}` 共享任务目录协议：任务准备阶段会写入 `spec.md` / `meta.json` / `artifacts/`，A2A `message/send` 正文和 Code Agent prompt 已注入 `spec.md -> plan.md -> result.md -> artifacts/` 执行契约；最终汇总前会读取并校验 `result.md`，将 `SUCCESS / REVISION_NEEDED / BLOCKED / INTERRUPTED` 映射回控制面状态。
- `RunController` 已下沉到 task 级生命周期控制：`resume` 的 running-task requeue、`blocked_by_dependency` 的失败投影、retry/requeue/reconcile/cancel/final review 相关状态推进，都在从旧 `OrchestratorEngine` 散写收敛到统一控制面入口。后续新增 run/task 生命周期能力必须优先进入 `RunController` / `ManagerLoop`。
- `retry / replan` 也开始往同一条控制面收口：手动重试、`retry_with_backoff`、`local_replan`、`agent_substitution` 这几条路径的旧 task reset 已抽成 `RunController.resetTaskForRetry()/resetTaskForReplan()`，统一处理 `workspace_tasks.pending + taskThread -> prepared + task.retrying/run.replanned`，不再各分支自己重置表状态。
- 动态新任务注入也开始进入控制面：`supervisor supplement`、`task_split`、`global_replan` 三条路径新增任务时，`workspace_tasks` 插入与 `task.queued` 事件广播已收口到 `RunController.queueTask()`，不再每个分支重复写“insert task + emit queued event”。
- `RunController.cancel()` 的批量收尾也补上了 `TaskThread` 同步：取消 run 时，除了批量把未终态 task 置为 `cancelled`，还会把对应 `task_threads` 和子对话 metadata 一并更新到 `cancelled`，减少“run 已取消但子对话还显示 active/pending”的旧残留。
- `human_interrupt` 已经从”可见提示”进入真实控制链：群聊存在 active run 时，新的用户要求会被登记成当前 run 的 `human_interrupt`，写入 blackboard / run events，并同步投影到活跃 TaskThread；Manager 处理它时会中断 live agent reply、回收 `runtimeLease` / `workerInstance`、把任务重置回 `pending + prepared`，执行器也开始支持在更新后的任务描述下恢复这次执行。
- `WorkerController` reconcile 模式已对齐 HiClaw：实现分阶段 reconcile loop（EnsureReady → AssignLease → ObserveHealth → RecoverStale），每阶段幂等检查当前状态 vs 期望状态。Worker 状态始终从 reconcile 写回，不再分散在多处散写。
- HiClaw 风格 idle-stop 已落地：空闲超时自动转入 sleeping，新任务通过 `ensureReadyForTask()` 自动 wake + reconcile；服务重启通过 `recoverStaleOnStartup()` 恢复 stale lease。
- Worker 心跳监控已启用：2 分钟宽限期 + 5 分钟超时检测，超时自动标记 Worker failed + RuntimeLease stale。
- `ManagerLoop` / `RunController` / `RoomController` / `WorkerController` / `RuntimeLeaseController` / `WorkerRuntimeService` 已经成为新任务主路径的资源控制面。`OrchestratorEngine`、`TaskExecutionService`、`LocalA2ATransport` 已删除，不能再承接新 run / task / room / worker lifecycle。现有 Planner 已从初始任务分工主路径退下，复杂任务现在先走 `manager-planner.ts` 的 Manager-first 行动方案生成；`planner.ts` 暂时保留为 JSON 抽取、校验和契约归一化工具来源。
- ArtifactStore 已从散写迁移到统一注册入口：`ArtifactController.registerArtifactBatch()` 成为产物唯一注册点，每次注册自动发 `artifact.created` RunEvent。`workspace_tasks.artifacts` JSON 字段降级为缓存。
- RunEvent replay API 已完整化：`GET /api/orchestrator-runs/:id/events?afterSequence=N` 支持增量重放 + 资源 snapshot 恢复。
- TaskThread 专用查询端点已上线：`GET /api/orchestrator-runs/:id/task-threads` 替代前端从 sessions 反向推导旧模式。
- ManagerPatrol 主动巡检已落地：每 2 分钟扫描 Worker 健康 + 任务超时，发 RunEvent + 群聊可见消息。
- ManagerLoop.step() Observe-Think-Act 主循环已落地：自动决定 dispatch_pending / review_running / synthesize。

如果本文档中的“建议表结构”和当前 schema 有细节差异，优先读取当前 `packages/db/src/schema.ts`、最新 migration 和对应 service 文件，再按本文档的资源语义补齐缺口。不要因为文档措辞回到旧入口，也不要重复创建平行表。

### 0.2 开 Goal 时的使用方式

本文档是重构路线图，不是一个 goal 内全部完成的实现清单。开 goal 时应按“一个可验证切片”推进，优先选择 Phase 1 中的一个闭环，例如：

```text
RunEvent replay 可恢复任务看板
或
TaskThread prepared/assigned/active 状态和左侧入口稳定
或
shared task directory 写入 spec.md、投影到子对话，并通过 A2A / Code Agent prompt 约束 Worker 按共享目录交付
```

每个切片都必须保持当前 dev server 可启动、群聊可创建、子对话可进入、至少一条 Code Agent 执行路径可用。旧 `OrchestratorEngine` / `TaskExecutionService` / `LocalA2ATransport` 已删除，不要为了兼容旧数据或旧 UI 行为把它们恢复回来；如需兼容，只能在 Room/Run/Worker/Artifact 资源层做显式迁移或只读投影。

另外，“RunEvent / AG-UI 是 UI 运行态事实源”不等于只看事件、丢弃资源表。正确心智是：

```text
ResourceStore 保存资源当前事实：Run / Task / TaskThread / WorkerInstance / Artifact / RuntimeLease
RunEvent 保存资源变化事实流：可排序、可回放、可审计
AG-UI 是 RunEvent 面向前端的事件协议投影
前端刷新时先加载 kernel snapshot，再按 sequence replay RunEvent 增量
```

如果某个事件 payload 比资源 snapshot 信息更少，前端合并时只能补充或更新明确字段，不能把更完整的 `taskThreadId / sessionId / workerInstanceId / sharedTaskRelativeRoot / artifactId` 覆盖成空。

## 1. 背景判断

AgentHub 当前已经具备 Manager-first 行动方案生成、A2A envelope、AG-UI event、任务子对话、Code Agent 适配和工作目录隔离等能力，但这些能力仍然有一部分挂在过程式执行链上：

```text
用户群聊消息
  -> messages.ts
  -> Orchestrator decision
  -> Manager-first action plan
  -> startPlanRunInExistingGroup()
  -> orchestrator_runs / workspace_tasks / sessions
  -> OrchestratorEngine
  -> TaskScheduler（已删除）
  -> TaskExecutionService
  -> LocalA2ATransport
  -> Code Agent / LLM fallback
  -> 扫描产物 / 写黑板 / 发 AG-UI
```

这条链可以工作，但它的问题是：`Run`、`Task`、`TaskThread`、`Worker`、`Artifact`、`RuntimeLease`、`RunEvent` 都不是稳定的一等资源，而是在执行过程中被创建、修复或拼接出来的状态投影。

这会导致：

- 用户发消息后前 10-20 秒反馈不足。
- 子对话有时任务结束后才出现，或切换回来丢状态。
- 左侧会话树出现重复 Agent 头像或重复子对话。
- Worker 明明产出文件，但主群聊产物卡没有稳定呈现。
- Orchestrator 看起来像一个人做完，成员协作感弱。
- `messages`、`workspace_tasks`、`orchestrator_run_events`、AG-UI store 都在表达运行状态，但没有单一真相源。

HiClaw 的优势不是单纯用了 Matrix / MinIO / Kubernetes，也不只是把任务拆成 DAG。它的核心是 **Manager-Workers 协作范式**：

```text
Human 把目标交给 Manager
Manager 负责理解目标、创建/选择 Worker、分配任务、跟进进度、处理异常
Worker 只对 Manager / Team Leader 负责，完成后回报
Human 可以随时旁观、插话、纠偏
Controller 保证 Manager、Worker、Room、Storage、Gateway 等资源真实存在
```

也就是说，HiClaw 更像“一个 AI 主管带团队”，而不是“一个函数调用图执行器”。它把多 Agent 协作拆成了两个互相配合的平面：

- **协作智能平面**：Manager / Team Leader 通过 IM timeline 像人一样分配、催办、验收和调整。
- **资源控制平面**：Controller 持续 reconcile Worker、Team、Human、Room、Storage、Gateway、Runtime 等资源。

这里要再强调 Human 的职责边界：

- Human 不应该退化为“最后看结果的人”。
- Human 也不应该被迫盯每个 Worker 的 token 流、CLI 输出和工具调用。
- Human 的主要职责应该是：
  - 提出目标和追加约束
  - 审批高风险动作、补员、返工和范围调整
  - 在主群聊或 TaskThread 中随时插话纠偏
  - 在 Manager 无法继续时给出决策
  - 最终验收交付结果
- Manager 的职责则是代替 Human 持续监督 Worker，把低层执行监督从人手里拿走。

资源控制平面大致是：

```text
Manager / Team / Worker / Human 是声明式资源
Controller 持续 reconcile 目标状态
Matrix room 是通信资源
Worker container/pod 是执行资源
MinIO prefix 是产物与共享状态资源
Higress consumer 是凭证与模型网关资源
SOUL / AGENTS / Skills / MCP 是 Agent 行为配置资源
```

AgentHub 应该优先吸收 **Manager-Workers 协作范式**，再吸收资源模型；不要只学资源模型而保留僵硬的 DAG-first 流程。

同时，OpenClaw 值得作为 AgentHub 的指挥型运行时候选接入。它和 Claude Code / Codex / OpenCode 这类 Coding Agent 的定位不同：

- OpenClaw / CoPaw 更像长期在线的 Manager / Team Leader runtime：擅长接入消息通道、维护会话、调用管理 skills、做任务协调、等待事件和处理 Worker 回报。
- Claude Code / Codex / OpenCode / Gemini CLI 更像执行型 Coding Worker runtime：擅长在一个工作目录内完成代码、报告、测试、网页等具体产出。

因此后续设计不应简单把 OpenClaw 加进 `codeAgentType` 列表里，而应把运行时拆成 `CoordinatorRuntime` 和 `WorkerRuntime` 两条线。

## 2. HiClaw 可借鉴的核心

### 2.1 控制平面

HiClaw 的 `Worker`、`Team`、`Manager`、`Human` 都是可声明、可观察、可恢复的资源。Controller 不依赖一次函数调用成功，而是反复 reconcile：

```text
期望 Team 存在
  -> 确保 Team room 存在
  -> 确保 Leader / Worker 账号和房间存在
  -> 确保 Gateway consumer 和 MinIO 权限存在
  -> 确保 Agent 配置和 skills 已写入
  -> 确保容器/Pod 处于 Running / Sleeping / Stopped
  -> 把实际状态写回 status
```

AgentHub 需要的不是 Kubernetes CRD，而是同样的思想：**每个协作对象都有 stable id、desired state、observed status、reconcile loop**。

### 2.2 通信平面

HiClaw 用 Matrix room 固定通信拓扑：

- Manager DM room
- Team room
- Worker room
- Leader room

这些 room 不是 UI 临时入口，而是真实通信资源。AgentHub 可以继续使用自研 IM，不必引入 Matrix，但必须把 `TaskThread` 变成一等资源，而不是 `session.metadata.kind = "orchestrator-task"` 的副产品。

### 2.3 执行平面

HiClaw 的 Worker 是真实运行实体，有独立 runtime、model、skills、MCP、env、state。AgentHub 现在的 Code Agent 更像“任务执行参数”，还没有成为长期可观察的 `WorkerInstance`。

AgentHub 应把专家 Agent 实例化为：

```text
WorkerInstance =
  workspaceAgentId
  codeAgentType
  modelBinding
  skills / MCP
  permissions
  runtime lease
  home / config / cache / tmp
  lifecycle state
```

### 2.4 产物平面

HiClaw 要求 Manager 分配任务前先推文件，Worker 完成后必须拉取结果、读取 meta、更新 state。AgentHub 当前主要靠执行后扫描和 message metadata，这对复杂任务不够稳。

AgentHub 需要一等 `ArtifactStore`：

- Agent 执行过程中显式登记 artifact。
- artifact 和 task、thread、run、agent 绑定。
- 下游任务读取的是 artifact/handoff 引用，不是猜相对路径。
- 主群聊产物卡从 ArtifactStore 派生，不从消息里临时找。

### 2.5 生命周期平面

HiClaw 的资源有 `Running / Sleeping / Stopped` desired state。AgentHub 目前有 run/task 状态，但缺少 Worker runtime 生命周期和可恢复控制。

AgentHub 需要：

- `Run` lifecycle：planning / awaiting_approval / dispatching / running / paused / synthesizing / completed / failed / cancelled。
  - 注意：`awaiting_approval` 是目标内核里的逻辑状态。当前 `orchestrator_runs.status` 还没有这个 enum，迁移期必须投影为 `planning`，并通过 `approval.requested` / `manager.next_action` 的 payload 表达“等待用户确认”。不要直接把 `awaiting_approval` 写进旧表状态。
- `Task` lifecycle：planned / queued / assigned / running / waiting_artifact / blocked / reviewing / done / failed / cancelled。
- `WorkerInstance` lifecycle：provisioning / ready / busy / idle / sleeping / stopped / failed。
- `RuntimeLease` lifecycle：creating / ready / running / cleaning / released / failed。

### 2.6 Manager-loop 协作平面

HiClaw 最值得学习的不是“把任务切成多少节点”，而是 Manager 的工作方式：

```text
Observe   观察用户目标、团队状态、Worker 回报、产物和异常
Think     判断下一步是澄清、补员、分配、等待、追问、返工、汇总还是终止
Act       通过 IM/A2A 给 Worker 发任务、更新任务账本、登记产物、向用户汇报
Review    检查 Worker 输出是否满足目标和交付契约
Adjust    动态追加/取消/重派任务，而不是被初始 DAG 锁死
```

AgentHub 后续 Orchestrator 不应该只是一次性输出 `reply / plan / member_proposal`。它应该是一个可持续运行的 Manager loop：

- 用户消息进入后，Manager 先快速给出模型生成的承接说明；模型尚未返回时，只展示透明运行状态，避免空白等待。
- Manager 可以先创建粗粒度任务账本，再随着 Worker 回报逐步细化。
- Manager 通过 TaskThread 和 Worker 交流，Worker 的中间问题和结果都回到 Manager。
- Manager 对每个 Worker 结果做验收：够用就登记 artifact，不够用就追问或返工。
- 用户插话时，Manager 把新约束合并进当前 run，而不是机械重开流程。
- DAG 是 Manager 的账本和恢复机制，不是系统替 Manager 决策的主脑。

这会让 AgentHub 的体验从“流程引擎执行计划”转向“AI 负责人带团队交付”。

### 2.7 HiClaw 处理思路在 AgentHub 中的映射

AgentHub 不需要完整复刻 HiClaw 的技术栈，但每个协作问题的处理思路应向 HiClaw 靠齐：用 AgentHub 自己的 IM、A2A、AG-UI、本地工作区和 Coding Agent runtime 实现同类能力。

| 协作问题 | HiClaw 的处理思路 | AgentHub 应采用的处理思路 |
| --- | --- | --- |
| 谁负责理解用户目标 | Manager 是唯一顶层入口，像负责人一样承接目标 | 群聊中的 Orchestrator/Manager 是真实协作主体，不再只是一次 Planner 调用 |
| 如何分配任务 | Manager 通过 IM @ Worker，任务在房间中可见 | Manager 通过 A2A message/send 写入 TaskThread，子对话保存真实任务和回复 |
| 如何让过程像团队协作 | Matrix timeline 承载 Manager、Worker、Human 的可见对话 | 主群聊展示 Manager 汇报，TaskThread 展示 Worker 执行现场，AG-UI 投影状态 |
| 如何处理复杂任务 | Manager 先粗分，再随 Worker 回报继续追问、返工、补员 | `ManagerLoop.step()` 持续观察 WorkLedger、TaskThread、Artifact，再决定下一步 |
| 如何避免一次性计划锁死 | Manager/Team Leader 可以动态调整任务 | DAG 只是 WorkLedger 的依赖视图，允许动态增删改任务 |
| 如何保证 Worker 真实存在 | Worker 是容器/Pod，有 runtime、状态和 room | WorkerInstance 是一等资源，有 runtime binding、健康状态和 RuntimeLease |
| 如何隔离运行环境 | 每个 Worker 独立容器/Pod，无状态，可替换 | 每个 Agent/Task 独立 RuntimeLease、workdir、config/cache/session；local 优先，sandbox 可切换 |
| 如何共享文件 | MinIO/S3 保存 workspace、shared tasks 和产物 | `.agenthub/shared/tasks/{taskId}` 任务目录协议 + ArtifactStore，本地 FS 起步，后续可接 S3/MinIO provider |
| 如何管理凭证 | Higress consumer，Worker 不拿真实 key | 模型目录和工具凭证先集中管理；后续引入 per-agent credential lease / gateway adapter |
| 如何管理 Skills/MCP | Manager 分发 skills，Gateway 管 MCP 权限 | Skills/MCP 是能力层；Agent 配置选择能力，WorkerController 物化到 runtime |
| 如何让人介入 | Human 资源 + Matrix 权限 + 房间旁观/插话 | 用户可在主群聊或 TaskThread 插话，ManagerLoop 必须合并新约束而不是重开僵硬流程 |
| 如何恢复和审计 | Controller reconcile + Matrix 日志 + resource status | RunEvent replay + ResourceStore + execution logs；服务重启后按资源状态恢复/标记失败 |
| 如何组织团队 | Manager / Team Leader / Worker 分层 | 短期 Manager -> Worker；中期支持 Team Leader 作为特殊 Worker 管子团队 |

关键取舍：

- 技术栈可以不同：AgentHub 可以继续用自研 IM、SQLite、本地 FS、A2A、AG-UI 和本地 CLI。
- 协作语义要相同：Manager 必须像负责人，Worker 必须像成员，TaskThread 必须像真实工作房间，Artifact 必须像可交接产物。
- 系统代码只做资源和状态控制，不能偷偷替 Manager 做静态路由、关键词分工或固定模板计划。

#### 共享产物：不能只学“对象存储”，要学任务目录协议

HiClaw 的共享产物思路不是“Worker 结束后扫文件放附件”，而是：

1. Manager 分配任务前，先创建标准任务目录。
2. Manager 写入 `meta.json`、`spec.md` 和必要的 `base/` 参考文件。
3. Manager 立即 push 到共享存储，并确认成功后再通知 Worker。
4. Worker 收到任务后先 file-sync，再读取 `spec.md`。
5. Worker 在同一任务目录下写 `plan.md`、`result.md` 和中间产物。
6. Worker 完成后 push 回共享存储，并在房间里告诉 Manager。
7. Manager 必须 pull 最新任务目录后再读取和验收，不能假设本地副本实时同步。

AgentHub 应学习的是这个协议，而不是必须使用 MinIO。短期用本地文件系统也要保持同样语义：

```text
.agenthub/shared/tasks/{taskId}/
  meta.json       # Manager/系统维护：状态、assignee、timestamps、artifact refs
  spec.md         # Manager 写给 Worker 的任务说明、上下文、验收标准
  base/           # Manager 提供的输入资料和上游 artifact 快照
  plan.md         # Worker 写：执行计划
  result.md       # Worker 写：最终结果摘要
  artifacts/      # Worker 写：文件、报告、网页、图片、日志等产物
```

这里的 `spec.md` 是 Manager 针对本次具体任务即时生成的任务说明和验收标准，不是 `.agenthub/specs/*.spec.yml` 那种固定场景模板，也不能通过 trigger/关键词自动命中。旧的场景 Spec 模板仍然不应回到主路径。

对应 AgentHub 机制：

- `TaskThread` 里发给 Worker 的 A2A message 必须引用 `shared/tasks/{taskId}/spec.md`，不能只塞一段长 prompt。
- `RuntimeLease` 启动前应把任务目录以只读或受控方式挂载/复制到 Worker workdir。
- Worker 完成后，`WorkerRuntimeService` / runtime adapter 先收集任务目录，再调用 `ArtifactController.register()`。
- `ArtifactStore` 的 `handoff_path` 应优先指向 `shared/tasks/{taskId}/artifacts/...` 或其 provider URI，而不是 Worker 临时 workdir。
- Manager 验收前必须读取 ArtifactStore/任务目录的最新 snapshot，不能只看 Worker 最后一条文字消息。
- 后续接 S3/MinIO 时，只替换 `ArtifactProvider`，不改变任务目录协议。

这比现在的 `.agenthub/handoff` 更强：`handoff` 是结果交接目录，而 `shared/tasks/{taskId}` 是任务从分配到验收的完整协作空间。后续实现时，`handoff` 可以降级为 `shared/tasks/{taskId}/artifacts` 的兼容别名。

#### 通信房间：不能只学“有子对话”，要学房间职责和发送协议

HiClaw 对消息去向很严格：管理回复不能混进 Worker 任务房间，任务分发不能写在 admin DM 里，Team 任务不能绕过 Team Leader 直接找 Team Worker。AgentHub 虽然不用 Matrix，也应有同样的房间语义。

AgentHub 映射：

```text
主群聊 group
  用户 <-> Manager
  展示承接、计划、进度、风险、产物、最终交付

任务子对话 TaskThread
  Manager <-> Worker
  承载任务 spec、Worker 过程输出、问题、结果、artifact refs

Team Leader 子对话 / Team Thread（中期）
  Manager <-> Team Leader
  Manager 只向 Leader 委派团队级任务

Team 内部 Thread（中期）
  Team Leader <-> Team Workers
  Manager 不穿透团队内部直接调 Worker
```

规则：

- Manager 给 Worker 的任务必须进入对应 TaskThread，不能只作为主群聊提示或后台 prompt。
- 主群聊只展示 Manager 的汇报和关键事件，不堆满 Worker 原始日志。
- 用户在主群聊插话时，ManagerLoop 应更新当前 WorkLedger；用户进入 TaskThread 插话时，Manager 也要能感知并纳入上下文。
- 任何“跳转子对话”都必须指向真实 TaskThread，不允许 UI 自动补空壳。
- 后续支持 Team Leader 时，Manager 只问 Leader 进度，Leader 再管理内部 Worker，学习 HiClaw 的委派边界。

#### Worker 生命周期：不能只学“ready/busy”，要学 ensure-ready、idle-stop、可恢复

HiClaw 的 Worker 是可停可唤醒的运行实体：Manager 分配任务前先 ensure-ready，空闲超过阈值自动 stop，runtime 切换会重建容器但保留账号/房间/存储/凭证。

AgentHub 映射：

- `WorkerInstance.desiredState = running | sleeping | stopped`。
- `WorkerInstance.observedState = provisioning | ready | busy | idle | failed`。
- 分配任务前，`WorkerController.ensureReady(workerInstanceId)` 必须运行。
- 如果 Worker runtime 未安装、模型不可用、CLI auth 失效、sandbox 不可用，任务进入 `blocked`，Manager 向用户透明说明。
- 空闲 Worker 可按设置进入 sleeping，但 TaskThread 和 Artifact 不消失。
- 切换 runtime/model/skills 时应创建新 RuntimeLease 或重建 WorkerInstance 运行态，不能污染旧会话。
- 服务重启后，running lease 要恢复、标记 stale，或提示用户接管，不能继续假装运行。

第一阶段可以不做自动 idle-stop，但设计上必须预留：

```text
ensureReady -> assign task -> observe heartbeat/output -> mark idle -> optional sleep -> wake on next assignment
```

#### Skills/MCP：不能只学“标签”，要学 Manager 管理和 Worker 同步

HiClaw 中 Worker skills 由 Manager 集中管理，默认 skills 必带，新增/更新 skill 后要 push 到 Worker，并通知 Worker file-sync。Worker 不能随便改自己的 skills。

AgentHub 映射：

- Skills/MCP 是能力包，不是 Agent 类型。
- Agent 配置页选择 skills/MCP 只是声明期望能力。
- WorkerController 在任务执行前把选中的 skills/MCP 物化到 Worker runtime config。
- 更新 skills/MCP 后，必须产生 `worker.capabilities.updated` 事件，并让下一次 RuntimeLease 使用新能力。
- 通用协作 skills 应默认随 Worker 物化：`task-progress`、`artifact-register`、`file-sync/shared-task`、`ask-manager`。
- Manager 专属 skills 与 Worker skills 分开：Manager 有 `worker-management`、`task-management`、`team-management`、`artifact-review`；Worker 不应获得创建/删除其他 Worker 的管理能力。
- 后续如果接第三方 skill 市场，必须经过 license、安全和 schema 适配，不直接默认启用。

#### 心跳和催办：不能只学“状态展示”，要学 Manager 主动巡检

HiClaw Manager 会定期读 state.json，检查 active tasks，确保 Worker ready，向正确房间询问进度，发现异常再汇报 admin。

AgentHub 映射：

- `ManagerLoop` 不只在用户发消息时运行，也应能被 heartbeat 触发。
- heartbeat 读取 WorkLedger 中的 active tasks，而不是扫描所有消息。
- 对正在执行但长时间无输出的 Worker，先 `ensureReady`，再在对应 TaskThread 询问是否阻塞。
- 对 Team-delegated task，只问 Team Leader，不直接找 Team Worker。
- 对超时、无响应、runtime failed、artifact missing，Manager 在主群聊发出风险提示和建议动作。
- heartbeat 事件也写入 RunEvent，用户回来后能看到系统不是卡死，而是在等待/催办/阻塞。

第一阶段可以用简单计时器或请求触发恢复；长期应做 durable heartbeat job。

#### 身份和权限：不能只学“群聊里有人”，要学谁能做什么

HiClaw 区分 Admin、Manager、Worker、Team Leader、Human L1/L2/L3、Trusted Contact 和 Unknown。AgentHub 当前是单用户为主，但也应先把身份边界写入设计，避免后续多人协作时返工。

AgentHub 映射：

- 当前用户默认是 workspace owner/admin。
- Manager 可以执行管理动作：创建/停止 Worker、分配任务、更新 WorkLedger、登记 artifact。
- Worker 只能处理被分配任务、读授权任务目录、写结果和 artifact。
- Team Leader 可以管理自己团队内部任务，但不能越权管理其他团队。
- 普通参与者可以评论和提供约束，但不能改 Agent 配置、模型凭证或权限。
- 未授权来源在群聊/外部 channel 中不能触发管理动作。

AgentHub 在人机协作上的明确目标应该是：

1. Human 可以从主群聊进入任意 TaskThread 旁观执行过程。
2. Human 可以在主群聊高层干预，也可以在 TaskThread 低层插话纠偏。
3. ManagerLoop 必须把 Human 的新消息视为高优先级上下文变化，而不是简单重开流程。
4. 高风险动作、补员、返工、范围收缩、结果验收，都应有清晰的人机边界。
5. “透明”与“减负”要同时成立：Human 看得见过程，但不需要亲自盯每个 Worker 的每一步。

短期 UI 可以不做完整多人权限，但后端事件和资源字段要保留 `actorId / actorType / permissionScope`。

#### 凭证隔离：不能只学“有模型配置”，要学 Worker 不直接拿主密钥

HiClaw 通过 Higress consumer 让 Worker 只拿消费者令牌，不直接拿真实 API Key。AgentHub 当前不必马上上 Higress，但应按这个思路演进。

AgentHub 映射：

- 模型管理保存真实 endpoint/key，是库存层。
- Agent 运行时拿到的应是本次 RuntimeLease 的最小必要 env/config。
- 不同 WorkerInstance 的 model binding、CLI config、cache/session 必须隔离。
- 后续增加 `CredentialLease`：为某次 RuntimeLease 生成短期凭证或受限代理配置。
- Worker 输出和日志需要做 secret redaction，避免 key 泄露到 TaskThread 或 RunEvent。
- MCP server 凭证也应走 per-agent/per-task scope，不默认全局暴露。

这部分可以先本地实现为“按 RuntimeLease 注入 env + 日志脱敏 + 不写全局配置”，以后再接 gateway provider。

### 2.8 从 HiClaw wiki 得出的硬结论

`docs/hiclaw-wiki.agent.final.md` 把 HiClaw 拆得很细，读完以后需要把几个结论变成 AgentHub 后续重构的硬约束，而不是停留在“参考了 HiClaw”这种空话。

#### Manager 不是 Planner，也不是后端流程的皮肤

HiClaw 的 Manager 是一个长期在线的协调者：它接收人类目标，调用管理 skills，创建/选择 Worker，维护任务账本，追踪进度，处理异常，再向人类汇报。Planner 只是 Manager 可能使用的一项能力。

AgentHub 现在最危险的误区，是把 `ManagerLoop` 做成 `Planner -> DAG -> Executor` 的新名字。正确方向是：

- Planning skill 只生成或更新 WorkLedger；旧 Planner 不再是必经第一步。
- ManagerLoop 才决定下一步是澄清、分发、等待、催办、返工、补员、暂停、汇总还是请求 Human 决策。
- RunController / WorkerController 只能执行 Manager 的明确意图，并保证资源状态收敛。
- 代码不能用静态规则绕过 Manager 去判断任务是不是“值得规划”、应该找谁、是否追加 QA。

验收标准不是“DAG 跑完”，而是用户能感到“我把事情交给了一个负责人，它在带团队推进”。

#### TaskThread 不是 UI 子会话，而是 AgentHub 的 Room 资源

HiClaw 的 Matrix Room 是真实通信资源：它有参与者、权限、历史消息、审计和明确用途。AgentHub 不用 Matrix，但 TaskThread 必须承担同等语义。

这意味着：

- TaskThread 创建失败时，任务必须 blocked，而不是前端补一个空入口。
- TaskThread 要保存 Manager 分派、Worker 接单、Worker 过程、澄清、结果、artifact 引用和 Human 插话。
- 主群聊只是 Manager 面向 Human 的高层汇报，不应该堆 Worker 原始执行日志。
- 进入 TaskThread 后看到的内容必须是真实执行链路产生的内容，不是“为了 UI 展示”复制出来的假消息。
- 切换会话、刷新、服务重启后，TaskThread 入口应由资源状态和 RunEvent replay 恢复，而不是从 session metadata 猜。

所以后续所有“子对话稳定性”问题，本质都要回到 TaskThread 资源和 RunEvent 投影，而不是继续在 SessionList 里补丁式修。

#### Shared task directory 不是附件目录，而是任务协作空间

HiClaw 的 MinIO 共享任务树承担了“任务规格、上下游输入、过程计划、结果和产物”的协作空间。AgentHub 的 `.agenthub/shared/tasks/{taskId}` 也必须按这个心智推进。

硬规则：

- Manager 分派前先写 `spec.md / meta.json / base/`。
- Worker 必须先读 `spec.md`，再写 `plan.md / result.md / artifacts/`。
- Worker 完成后，ArtifactStore 登记的是任务目录中的产物，而不是临时 workdir 里扫到什么就算什么。
- 下游任务读取 ArtifactStore 或 shared task refs，不能猜上游 Worker 的相对路径。
- `.agenthub/handoff` 只能作为兼容别名，不能继续作为新的协作主路径。

这条如果做实，产物卡、下游接力、最终汇总和失败后的 partial artifact 才会稳定。

#### Worker 是可协调资源，不是一次 CLI 调用

HiClaw 的 Worker 有 runtime、model、skills、MCP、Room、Storage、Credential、desired state 和 observed state。AgentHub 的 Coding Agent 也必须逐步从“执行参数”变成 WorkerInstance。

后续 WorkerInstance / RuntimeLease 要继续补齐：

- ensure-ready：分配任务前检查 CLI、模型、auth、skills、sandbox/local-workdir。
- isolated runtime：每个 Worker/Task 的 home/config/cache/session/tmp 分离。
- heartbeat：长任务无输出时 ManagerPatrol 能区分“仍在跑 / 阻塞 / 已死”。
- stale recovery：服务重启或进程退出后，不能继续显示 running。
- idle-stop / wake：空闲 worker 可以睡眠，新任务到来再唤醒。
- reconfigure：切换 runtime/model/skills 时创建新 lease 或重建运行态，不能污染旧会话。

这也是为什么“多 Agent 协作像不像真的多人”，最终不是 UI 问题，而是 Worker 有没有真实生命周期。

#### Human-in-the-Loop 是协作网络的一等参与者

HiClaw 的 OpenHuman 和 Matrix 权限体系说明了一件事：Human 不是最后验收的人，也不是偶尔点确认框的人，而是可以进入任意相关房间观察、纠偏、补充约束和接管决策的参与者。

AgentHub 应继续强化：

- 主群聊插话进入 `human_interrupt` 控制面。
- TaskThread 插话也要进入 ManagerLoop 的上下文，而不是只影响当前聊天。
- 高风险动作、补员、返工、范围收缩和最终验收要能请求 Human 决策。
- Human 看得见 Worker 过程，但不需要盯每个 Worker 的每一步；Manager 负责替 Human 监督细节。
- 事件和消息都要带 `actorType / actorId / permissionScope`，为以后多人协作留边界。

#### Gateway 思想比“模型配置页”更重要

HiClaw 的 Higress 价值不只是统一 baseURL，而是把 LLM/MCP 凭证集中在网关，Worker 只拿 consumer token。AgentHub 当前可以暂时不引入 Higress，但配置分层必须继续向这个方向靠：

- 模型管理是库存和凭证层。
- Agent 配置是组合选择层。
- RuntimeLease 是本次执行的最小注入层。
- Worker 日志、TaskThread、RunEvent 必须做 secret redaction。
- MCP 权限应逐步变成 per-agent/per-task scope，而不是全局暴露。

短期实现可以是本地 CredentialLease；长期可以接 gateway provider / reverse proxy / enterprise credential broker。

#### 技术栈不照搬，控制平面思想必须照搬

AgentHub 不应默认引入 Matrix、MinIO、Higress、Kubernetes，因为这会让比赛项目和本地用户体验过重。但 HiClaw 的控制平面思想必须学：

```text
Resource Spec      用户/Manager 声明期望
Resource Status    Controller 观察实际状态
Reconcile Loop     差异收敛、失败重试、事件记录
Event Timeline     Human 可看、可审计、可恢复
Runtime Adapter    本地/Docker/远程环境可替换
```

因此后续重构优先级应该是：

1. 继续削 `messages.ts` 和 `OrchestratorEngine` 的总控职责。
2. 把 `RunController.reconcile()` 和 `ManagerLoop.step()` 做成持续推进主路径。
3. 把 TaskThread / ArtifactStore / WorkerInstance / RuntimeLease 的资源状态做实。
4. 前端彻底从 resource snapshot + RunEvent / AG-UI replay 恢复 UI。
5. 再评估 OpenClaw / CoPaw 作为 coordinator runtime，而不是先把它塞进普通 code agent 下拉。

## 3. AgentHub 目标架构：Manager-led HiClaw-lite Kernel

AgentHub 不直接引入 Matrix、MinIO、K8s、Higress 作为默认依赖，而是做一套以 Manager 为中心的轻量内核：

```text
Manager-led AgentHubKernel
  ManagerLoop                 # 协作智能主循环，负责观察、分配、验收、调整、汇总
  TeamRuntime                 # 群聊团队运行时，维护 Manager / Leader / Worker / Human 关系
  WorkLedger                  # Manager 的任务账本，DAG 是账本视图之一
  ResourceStore               # Run / Task / Thread / Worker / Artifact / Lease / Event
  ResourceController          # 确保资源存在、状态可恢复
  RunController               # Run 生命周期，不替代 Manager 决策
  TeamController              # 团队和成员生命周期
  WorkerController            # WorkerInstance 生命周期和健康
  TaskController              # 任务状态、依赖、重试、阻塞
  TaskThreadController        # 真实任务沟通线程
  ArtifactController          # 产物登记、handoff、可见性
  RuntimeLeaseController      # 本地/沙箱/远程 runtime 租约
  EventController             # AG-UI / RunEvent 投影
```

关键原则：

- Manager loop 是主脑；Planner 是 Manager 可调用的技能，不是系统固定入口。
- DAG 是任务账本的一种结构化视图，可以被 Manager 动态修改。
- Controller 负责资源和状态，不负责替 Manager 判断意图、分工或追加任务。
- Worker 必须通过 TaskThread 接收任务和回报，不能只作为后台函数执行。
- 用户看到的主群聊应该像“Manager 带团队”，不是“系统流程跑节点”。

### 3.0 Runtime 分层：指挥型与执行型分开

当前 AgentHub 把 `runtimeType = code-agent | llm` 和 `codeAgentType = codex | claude-code | opencode | gemini` 作为主要运行时心智。这个模型适合执行型 Agent，但不够表达 OpenClaw 这类指挥型 Agent。

目标运行时应拆成两层：

```text
AgentRoleClass
  coordinator      # Orchestrator / Team Leader / Manager
  worker           # 具体执行任务的专家
  reviewer         # 可作为 worker 的特殊职责
  fallback         # 内部 LLM 兜底

RuntimeBase
  coordinator:
    openclaw
    copaw
    llm-fallback
  worker:
    codex
    claude-code
    opencode
    gemini
```

其中：

- `openclaw` 是 Orchestrator / Team Leader / Manager 的候选指挥型运行时基底；进入实现前必须先完成 adapter research 和生命周期控制设计。
- `copaw` 可作为轻量 Manager / Team Leader 运行时，适合以后做低资源占用或 Python agent loop。
- `codex`、`claude-code`、`opencode`、`gemini` 继续作为主要 Coding Worker 基底。
- `openclaw` / `copaw` 暂不进入普通 Worker 下拉；若以后要作为 Worker runtime，必须先完成 adapter research、生命周期控制和产物协议映射。
- `llm-fallback` 只用于内部模型链路或缺少可用运行时的兜底，不作为主要专家 Agent 方向。
- 其他候选 runtime 只允许先进入 adapter research note，不进入 schema enum、下拉框或默认主路径。

这会带来一个重要产品变化：Agent 配置页不再只是“选择 Coding Tool + 模型”，而是先选择 Agent 的角色运行形态：

```text
指挥型 Agent:
  OpenClaw / CoPaw（候选；未完成 adapter research 前不进入默认主路径）
  LLM fallback（仅内部兜底/过渡，不作为主要专家形态）
  + 管理型 skills
  + message/channel adapter
  + task/project coordination 能力

执行型 Agent:
  Codex / Claude Code / OpenCode / Gemini
  + 编码/研究/文档/测试 skills
  + workspace runtime lease
  + artifact contract
```

短期兼容上，现有 `workspace_agents.runtimeType` 和 `codeAgentType` 可以继续服务旧路径；新内核应在 `WorkerInstance` 或后续 `AgentRuntimeBinding` 中表达更完整的 runtime family，避免把 OpenClaw 硬塞成普通 `code-agent`。

### 3.1 核心资源

#### Project

用户工作目标所在的项目空间。它不是单次对话，而是长期工作容器。

字段建议：

- `id`
- `workspaceId`
- `goal`
- `projectPath`
- `defaultArtifactRoot`
- `createdAt / updatedAt`

#### Team

群聊对应的协作团队。Team 绑定一个 Orchestrator / Team Leader，以及可参与协作的 WorkerInstance。当前 Orchestrator 仍可由已适配的 Coding Agent 承担；未来在完成 adapter research、生命周期控制和事件投影后，可以优先支持 OpenClaw / CoPaw 这类指挥型 runtime，避免长期让普通 Coding Worker 承担所有协调职责。

字段建议：

- `id`
- `workspaceId`
- `groupSessionId`
- `orchestratorAgentId`
- `desiredMemberIds`
- `status`
- `createdAt / updatedAt`

#### WorkerInstance

专家 Agent 的运行实例。它不是 Agent 配置本身，而是“某个 workspace 里这个 Agent 当前可用的执行实体”。

注意：迁移期 `workspace_agents.runtimeType = llm | code-agent` 和 `workspace_agents.codeAgentType` 仍是旧配置字段；新内核不要把 `llm-fallback` 写进旧 `runtimeType` 心智，而应在 `WorkerInstance` 或后续 `AgentRuntimeBinding` 中表达 `runtimeFamily / runtimeBase`。

字段建议：

- `id`
- `workspaceId`
- `workspaceAgentId`
- `runtimeFamily = coordinator | worker | fallback`
- `runtimeBase = openclaw | copaw | codex | claude-code | opencode | gemini | llm-fallback`
- `modelId`
- `skillIds`
- `mcpServerIds`
- `sandboxPolicy`
- `desiredState = running | sleeping | stopped`
- `observedState = provisioning | ready | busy | idle | failed`
- `lastHeartbeatAt`
- `runtimeHome`
- `runtimeConfigPath`
- `message`

#### Run

一次用户目标的协作执行。Run 不应该在计划创建时直接进入 `running`，而应先进入可观察的规划和确认阶段。

字段建议：

- `id`
- `workspaceId`
- `teamId`
- `groupSessionId`
- `goal`
- `status`
- `plan`
- `ledger`
- `createdByMessageId`
- `createdAt / updatedAt`

#### Task

Manager 工作账本中的任务条目。它可以形成 DAG 依赖视图，但本质不是固定流程节点；一旦 Manager 确认需要某项工作，Task 就应存在。即使尚未正式分配，也应展示为 `planned / queued`。

字段建议：

- `id`
- `runId`
- `workspaceId`
- `assigneeWorkerInstanceId`
- `workspaceAgentId`
- `title`
- `description`
- `status`
- `dependencies`
- `inputArtifactRefs`
- `requiredOutputContract`
- `actualArtifactRefs`
- `threadId`
- `attempt`
- `error`
- `createdAt / updatedAt`

#### TaskThread

任务子对话。它是稳定资源，之后再投影成 `sessions`。

字段建议：

- `id`
- `runId`
- `taskId`
- `workspaceId`
- `groupSessionId`
- `assigneeWorkerInstanceId`
- `sessionId`
- `status = prepared | assigned | active | completed | failed`
- `lastEventId`
- `createdAt / updatedAt`

#### Artifact

一等产物资源。

字段建议：

- `id`
- `workspaceId`
- `runId`
- `taskId`
- `agentId`
- `kind = file | directory | preview | report | log | diff | url`
- `title`
- `path`
- `handoffPath`
- `mimeType`
- `size`
- `checksum`
- `metadata`
- `createdAt`

#### RuntimeLease

一次任务执行拿到的运行时租约，承载本地进程、Docker Sandboxes、未来远程容器或云沙箱。

字段建议：

- `id`
- `runId`
- `taskId`
- `workerInstanceId`
- `provider = local-workdir | docker-sandbox | remote-container`
- `status`
- `cwd`
- `homeDir`
- `configDir`
- `cacheDir`
- `tmpDir`
- `containerId`
- `pid`
- `startedAt / releasedAt`

#### RunEvent

AG-UI 和 UI 看板的可重放运行态事实流。注意：RunEvent 不是替代资源表的唯一数据源；`ResourceStore` 保存 Run / Task / TaskThread / WorkerInstance / Artifact / RuntimeLease 的当前事实，RunEvent 保存这些事实如何变化。前端应先加载资源 snapshot，再按 sequence replay RunEvent 增量。

字段建议：

- `id`
- `runId`
- `workspaceId`
- `groupSessionId`
- `taskId`
- `threadId`
- `workerInstanceId`
- `type`
- `payload`
- `severity`
- `sequence`
- `createdAt`

所有任务看板、进度条、子对话入口、产物卡都从资源 snapshot + RunEvent / AG-UI replay 派生，不再从消息 metadata 临时拼。

## 4. 新执行路径

目标路径不再是 DAG-first，而是 Manager-loop-first。DAG / Task 仍然存在，但它们是 Manager 的任务账本和恢复机制。

```text
用户在群聊发消息
  -> ChatIngress 写 user message
  -> ManagerLoop 创建 Run(status=planning)，立即发 run.started / manager.thinking
  -> Manager 快速回应用户：理解目标、交付物、初步处理方式
  -> Manager 观察团队能力和上下文
  -> Manager 决策：
       reply             # 普通聊天，直接回答
       clarify           # 需要用户补充关键条件
       member_proposal   # 当前团队能力不足，申请补员
       delegate          # 可以开始委派
  -> Manager 创建/更新 WorkLedger
       Task 是账本条目，DAG 是依赖视图，不是固定剧本
  -> TaskThreadController 为任务创建 prepared thread
  -> 主群聊立即可见 Manager 计划、准备中线程、任务看板
  -> Manager 通过 A2A message/send 在 TaskThread 中 @ Worker
  -> WorkerController 确保 WorkerInstance ready
  -> RuntimeLeaseController 分配 local/docker/remote runtime
  -> Worker 执行并在 TaskThread 回报过程、问题、结果和 artifact refs
  -> Manager 观察 Worker 回报：
       验收通过 -> ArtifactController 登记产物，任务完成
       信息不足 -> 追问同一 Worker 或追加研究任务
       方向错误 -> 要求返工或改派
       能力不足 -> 提出补员申请
       用户插话 -> 合并约束并更新账本
  -> Manager 持续向主群聊汇报进展和风险
  -> Manager 判断目标满足后进入 synthesizing
  -> Manager/Synthesizer 读取 ArtifactStore + WorkLedger + TaskThread 生成最终交付
```

关键变化：

- `messages.ts` 不再负责创建完整 run/task/thread 并启动 engine，只做 chat ingress。
- `orchestratorRuns.plan` 不再是事实中心，Manager 的 WorkLedger / Task / Artifact / Event 才是事实中心。
- 短期 WorkLedger 先由 `workspace_tasks`、`orchestrator_runs.plan/ledger payload` 和 RunEvent 共同投影；等 TaskThread / ArtifactStore / WorkerInstance 稳定后，再考虑独立账本表，避免第一刀过度建模。
- Planner 不再是必经第一步，而是 Manager loop 的一个工具；Manager 可以先粗分、边做边细化。
- 子对话先创建为 `TaskThread(prepared)`，即使未正式分配也可展示“准备中”。
- Code Agent 执行不是直接从 task 参数启动，而是通过 `WorkerInstance + RuntimeLease` 启动。
- Orchestrator / Team Leader 不再必须是普通 Coding Agent；可以由 OpenClaw / CoPaw 这类指挥型 runtime 承担。
- 产物不是执行后扫描为主，而是以 `ArtifactController.register()` 为主，扫描只是补充。
- Worker 输出必须先回到 Manager 的观察/验收循环，不能直接被系统机械汇总成最终结果。

### 4.1 示例：市场调研 + 小米分析 + HTML 报告

用户输入：

```text
给我调研报告一下今天的 A 股、港股、美股市场情况，以及分析一下小米情况，然后用 HTML 页面报告给我
```

Manager-led 路径应该是：

```text
Manager：
  1. 立即给出模型生成的承接说明，例如说明会先核对实时数据能力，再组织市场数据、小米专项、报告结构和 HTML 交付。
  2. 判断需要实时数据，若当前无浏览/财经数据能力，先申请补员或说明需要联网工具。
  3. 创建 WorkLedger：
       - 全球市场 Research：A 股 / 港股 / 美股当日表现、指数、板块、风险事件
       - 小米专项 Analyst：小米股价、新闻、财报/业务线、汽车/手机/IoT 影响
       - Report Architect：报告结构、口径、结论框架
       - HTML Builder：可打开的 HTML 页面、图表和样式
       - Reviewer：数据来源和页面可用性检查
  4. 为每个任务创建 TaskThread(prepared)，主群聊可见。
  5. @ Research Worker 获取市场数据，要求给来源和时间。
  6. @ Analyst Worker 做小米专项，不只看股价，还要解释原因和风险。
  7. 收到结果后检查：
       - 三地市场是否同一交易日口径
       - 小米分析是否覆盖港股、小米汽车、财报/新闻和市场情绪
       - 数据来源是否足够可信
  8. 不够就追问或返工；够了才交给 Builder。
  9. Builder 产出 HTML artifact，Reviewer 验证能打开、内容完整、引用清楚。
 10. Manager 在主群聊交付 HTML 产物卡和简要结论。
```

这和旧 DAG-first 的区别是：Manager 不只是“生成任务列表”，而是在执行过程中持续判断、沟通、验收和调整。用户看到的是一个负责人带团队推进，而不是一个静态流程在跑。

## 5. 模块重构建议

### 5.1 新增内核模块

建议新增：

```text
apps/server/src/kernel/
  resources/
    types.ts
    store.ts
    controller.ts
  controllers/
    run-controller.ts
    team-controller.ts
    worker-controller.ts
    task-controller.ts
    task-thread-controller.ts
    artifact-controller.ts
    runtime-lease-controller.ts
    event-controller.ts
  adapters/
    session-projection.ts
    ag-ui-projection.ts
    a2a-projection.ts
```

### 5.2 逐步收缩旧模块职责

| 旧模块 | 新职责 |
| --- | --- |
| `messages.ts` | 只做用户消息入口、鉴权、简单路由、调用 RunController |
| `orchestrator-engine.ts` | 逐步拆成 RunController / TaskController / Synthesizer runner |
| `task-scheduler.ts` | Coordinator assign + RunController / ManagerLoop 资源调度 | 已删除，不再保留内存 DAG 执行器 |
| `task-execution-service.ts` | 变成 RuntimeLease + A2A dispatch 的执行适配器 |
| `workspace/session-manager.ts` | 变成 TaskThread -> Session 投影器，不再主动猜旧子会话 |
| `run-events.ts` | 变成 EventController 的存储/发布适配器 |
| `blackboard.ts` | 降级为 Artifact / Task metadata 辅助索引，不再当主交接层 |

## 6. 迁移阶段

### Phase 0：文档和术语收口

目标：团队先统一“资源控制平面”语言。

动作：

- 新增本文档。
- 更新 `AGENTS.md`、`README.md` 和 `docs/当前状态与下一步路线.md`，说明后续方向是 HiClaw-lite Kernel。
- 明确不直接引入 Matrix / MinIO / K8s 作为默认依赖。

验收：

- 新人能理解 AgentHub 当前路径和目标路径差异。
- 后续 AI Agent 不再继续围绕 `messages.ts` 打补丁式扩展。

### Phase 0.5：现有 Schema 兼容和状态映射

目标：明确当前数据库和目标资源模型的映射，避免迁移时出现“文档状态名”和“数据库 enum”不一致。当前仓库已经开始加表，后续工作重点是补齐生命周期、投影和兼容读写，而不是继续重复建表。

当前事实：

- `workspace_agents.runtimeType` 只有 `llm | code-agent`。
- `workspace_agents.codeAgentType` 只有 `codex | claude-code | opencode | gemini`。
- `workspace_tasks.status` 只有 `pending | running | done | failed | cancelled | blocked | skipped`。
- `orchestrator_runs.status` 只有 `planning | running | synthesizing | completed | failed | cancelled`。
- `orchestrator_run_events` 已开始增加 `sequence`、`threadId`、`workerInstanceId`，但事件回放、严格排序、幂等消费和 UI 单一事实源仍需继续完成。
- `task_threads` 已开始落地；迁移期子对话仍投影为 `sessions.type = direct` + `metadata.kind = "orchestrator-task"`，但 session 不再应作为任务线程的事实中心。
- `artifacts` 已开始落地；迁移期 `workspace_tasks.artifacts` JSON 和消息 metadata 只能作为兼容投影或引用，不应继续作为产物事实中心。
- `worker_instances` / `runtime_leases` 已开始落地；当前最缺的是 lease 状态机、进程/sandbox 清理、服务重启后的 stale/recovery 处理。

迁移原则：

1. 新内核可以有更细状态，但旧 UI/旧表必须通过 projection 兼容。
2. 在未完成 enum 迁移前，不要直接把 `planned / queued / assigned / waiting_artifact / reviewing` 写入 `workspace_tasks.status`。
3. 新状态可以先写入 `workspace_tasks.progressStatus`、`orchestrator_run_events.payload` 或新表，再投影为旧状态。
4. 旧字段不能继续作为事实中心，但迁移期可以作为兼容投影字段。

建议状态映射：

| 新 Task 状态 | 旧 `workspace_tasks.status` 投影 | 说明 |
| --- | --- | --- |
| `planned` | `pending` | 计划已生成，未进入队列 |
| `queued` | `pending` | 等待依赖或调度 |
| `assigned` | `pending` | 已绑定 Agent / Worker，尚未开始 CLI |
| `running` | `running` | 正在执行 |
| `waiting_artifact` | `running` | 等待产物登记或 handoff |
| `reviewing` | `running` | 验收/复核阶段 |
| `blocked` | `blocked` | 等待用户、配置或上游 |
| `done` | `done` | 完成 |
| `failed` | `failed` | 失败，可保留部分产物 |
| `cancelled` | `cancelled` | 用户或系统取消 |
| `skipped` | `skipped` | DAG 决策跳过 |

| 新 Run 状态 | 旧 `orchestrator_runs.status` 投影 | 说明 |
| --- | --- | --- |
| `planning` | `planning` | 正在理解目标/生成计划 |
| `awaiting_approval` | `planning` | 已有计划，等待用户确认 |
| `dispatching` | `running` | 正在创建子对话、租约、任务分发 |
| `running` | `running` | 子任务执行中 |
| `paused` | `running` | 迁移期投影为 running，但 UI 应显示暂停 |
| `synthesizing` | `synthesizing` | 汇总中 |
| `completed` | `completed` | 完成 |
| `failed` | `failed` | 失败 |
| `cancelled` | `cancelled` | 取消 |

验收：

- 文档中出现的新状态都有旧表兼容映射。
- 任何阶段都不能因为写入新状态导致 Drizzle enum 或 SQLite 迁移失败。
- 前端读取旧接口时仍能看到合理状态；读取新 RunEvent 时能看到更细状态。

### Phase 1：RunEvent replay + TaskThread projection 同步落地

目标：先解决用户最痛的“没反馈、状态丢、子对话入口不稳定”，同时让主群聊先表现出 Manager 正在带团队，而不是空等 Planner。RunEvent 和 TaskThread 必须一起落地：没有 TaskThread，RunEvent 没有稳定子对话实体可投影；没有 RunEvent，TaskThread 状态刷新和回放又会继续依赖临时 UI 状态。

动作：

- 在已新增的 `orchestrator_run_events.sequence / threadId / workerInstanceId` 基础上，补齐回放 API、排序语义、事件 payload schema 和前端幂等消费。
- 在已新增的 `task_threads` 表基础上，确保 Manager 创建 WorkLedger 任务条目后立即创建 `TaskThread(status=prepared)`。
- 创建 TaskThread 时同步写入透明系统状态，例如“任务已规划，等待 Manager 分发”；子对话可点击后不能是空白页，也不能用固定话术伪装成 Worker/Manager 输出。
- 前端任务看板、进度条、产物卡、子对话入口逐步收敛到 AG-UI / RunEvent projection；第一阶段允许旧接口作为投影兼容，但不能再新增绕过 RunEvent 的 UI 状态源。
- `emitRunEvent()` 成为唯一广播入口。
- 每次用户目标进入规划时，系统可以立即发透明运行事件：
  - `run.started`
  - `manager.thinking`
- Manager/Orchestrator 的结构化模型输出返回后，再发决策事件：
  - `manager.intent_observed`
  - `manager.next_action`

注意：`manager.intent_observed` 和 `manager.next_action` 只能来自 Manager/Orchestrator 的结构化模型输出或明确的系统状态，例如“等待模型返回”“配置不可用”“用户确认中”。它们不能变成关键词分类器，也不能用静态文案伪装成 Manager 判断。

验收：

- 用户发消息后 1 秒内主群聊有可见运行反馈。
- 用户能看到 Manager 当前是在理解目标、等待模型、申请补员、分配任务还是验收结果。
- Manager 创建任务账本后，所有 `prepared` 子对话入口都稳定存在，且进入后能看到“等待 Manager 分发”的上下文。
- 切换会话再回来，任务看板和进度能从事件恢复。
- 前端不再依赖临时 typing 状态判断任务是否在跑。

#### RunEvent 契约

`RunEvent` 不是日志装饰，而是前端运行态的可重放事实流。事件设计必须满足：

- 同一个 `runId` 内 `sequence` 第一阶段必须尽量单调递增并可用于排序；等旧数据 backfill、并发写入原子化和重试机制完成后，再升级为严格递增并增加唯一索引。
- 事件可幂等消费，payload 必须包含稳定资源 ID。
- 前端刷新后可以通过 replay API 从 `sequence=0` 恢复任务看板、进度、子对话入口和产物卡。
- WebSocket 只负责推送增量，不能成为唯一状态来源。
- 任何旧 `task_board:*` 或临时 typing 状态都只能转成 RunEvent，不能再绕过 RunEvent 单独驱动 UI。

最小事件集合：

| 事件 | 必填 payload | 用途 |
| --- | --- | --- |
| `run.started` | `runId, groupSessionId, goal` | 主群聊立即出现运行卡；当前代码已支持该事件名，不要另起 `run.created` 平行事件 |
| `manager.thinking` | `runId, actorAgentId, actorName, stage` | 显示 Manager 正在理解/判断/验收 |
| `manager.intent_observed` | `runId, intent, confidence?, needsClarification?` | 记录 Manager 对用户意图的理解 |
| `manager.next_action` | `runId, action, reason` | 透明展示下一步：澄清/补员/委派/等待/汇总 |
| `plan.created` | `runId, taskIds, summary` | 任务看板骨架 |
| `task.planned` | `taskId, title, workspaceAgentId?, dependencies` | 计划阶段任务项 |
| `thread.prepared` | `taskId, threadId, sessionId, status` | 左侧子对话入口 |
| `task.assigned` | `taskId, workerInstanceId, workspaceAgentId` | 分配给真实 Agent |
| `task.started` | `taskId, runtimeLeaseId, cwd` | 执行开始 |
| `worker.message.sent` | `taskId, threadId, workerInstanceId, messageId` | Manager 已向 Worker 派发任务 |
| `task.progress` | `taskId, threadId, workerInstanceId?, progressPercent?, status` | Worker 进度和任务看板状态 |
| `task.stream` | `taskId, threadId, messageId?, text` | 子对话/主群聊过程输出 |
| `artifact.created` | `artifactId, taskId, kind, title, handoffPath?` | 产物卡 |
| `manager.reviewed` | `taskId, verdict, reason, nextAction` | Manager 验收 Worker 回报 |
| `task.rework_requested` | `taskId, workerInstanceId, reason` | 返工，不伪装成新任务静默冒出 |
| `task.completed` | `taskId, artifactIds, summary` | 成员汇报 |
| `task.failed` | `taskId, error, artifactIds?` | 失败但保留过程和部分产物 |
| `run.synthesizing` | `runId` | 汇总中 |
| `run.completed` | `runId, summaryMessageId?` | 完成 |
| `run.failed` | `runId, error` | 整体失败 |

数据库加固：

- `orchestrator_run_events.sequence`：同一 `runId` 内尽量递增，第一阶段作为排序和回放字段；等旧数据 backfill、并发写入原子化和重试机制完成后，再增加唯一索引 `(runId, sequence)`。
- `orchestrator_run_events.threadId`：关联 `task_threads.id`，用于稳定子对话入口。
- `orchestrator_run_events.workerInstanceId`：关联后续 `worker_instances.id`，迁移期可为空。
- `orchestrator_run_events.payload`：必须保存完整 projection 数据，不能要求前端再去猜消息 metadata。

replay API 建议：

```text
GET /api/orchestrator-runs/:runId/events?afterSequence=0
```

返回值必须按 `sequence ASC`，并包含当前 `Run / Task / TaskThread / Artifact` 的 snapshot 或足够的事件让前端重建 snapshot。第一阶段可以先返回事件流加现有 task/session 投影，后续再统一成 kernel snapshot。

### Phase 2：TaskThread 控制器收口

目标：在 Phase 1 已有 TaskThread 表和 projection 的基础上，彻底收口旧子会话创建和修复逻辑，解决子对话重复、消失、不可点击。

动作：

- `workspace_tasks.sessionId` 改为 `task_threads.sessionId` 的投影结果。
- Manager 创建 WorkLedger 任务条目后立即创建 `TaskThread(status=prepared)`。
- `SessionList` 只展示 `TaskThread` 投影出来的 `orchestrator-task` session。
- 删除“修复/补齐旧 workspace-agent-child 子会话”的逻辑。
- 把 TaskThread 对应 session 的创建和复用逻辑收口到 TaskThreadController / TaskThreadService 内部，不再通过通用 workspace session manager 的宽松匹配 helper 创建任务子对话。
- 复用已有 session 时必须严格匹配 `ownerId + workspaceId + type=direct + metadata.kind=orchestrator-task + orchestratorRunId + orchestratorTaskId`。不能再用 `hiddenFromSessionTree`、仅有 `orchestratorRunId`、仅有 `orchestratorTaskId` 这类旧 metadata 判定为当前 TaskThread。

验收：

- Manager 创建任务账本后，所有任务子对话入口都稳定存在。
- 未分配时可点击，但显示“等待 Manager 分发/准备中”。
- 任务失败、取消、切换页面后子对话仍可进入。

#### TaskThread 身份和投影规则

`TaskThread` 的核心价值是把“Kimi Thread 式子对话”变成稳定资源。它不能再由前端猜，也不能由 `SessionList` 自动补齐。

身份规则：

- 一个 Task 最多对应一个 TaskThread。
- 建议唯一约束：`UNIQUE(runId, taskId)`。
- `task_threads.sessionId` 是投影到 IM 系统的 session，不是 TaskThread 本身。
- `workspace_tasks.sessionId` 迁移期可以继续保留，但只能由 `task_threads.sessionId` 回填，不能由其他模块直接创建不同 session。
- 未正式分配前也要创建 TaskThread，状态为 `prepared`。
- 正式分配后写入 Manager 发给 Worker 的 A2A message，状态变为 `assigned / active`。

建议表结构：

```text
task_threads
  id
  workspace_id
  run_id
  task_id
  group_session_id
  workspace_agent_id
  worker_instance_id
  session_id
  status = prepared | assigned | active | completed | failed | cancelled
  last_event_id
  created_at
  updated_at
```

Session 投影规则：

- `session.type = direct`
- `session.workspaceId = task_threads.workspace_id`
- `session.workspaceAgentId = task_threads.workspace_agent_id`
- `session.metadata.kind = "orchestrator-task"`
- `session.metadata.orchestratorRunId = run_id`
- `session.metadata.orchestratorTaskId = task_id`
- `session.metadata.taskThreadId = task_threads.id`
- `session.metadata.groupSessionId = group_session_id`

左侧展示规则：

- 群聊展开后只查询 TaskThread 投影出的 `orchestrator-task` session。
- 不再显示 `workspace-agent-child`。
- 不再按 workspace agent 自动补“空子会话”。
- 旧历史子会话如果没有 `taskThreadId`，默认隐藏在新树之外；需要历史查看时放到单独“历史入口”，不要混入新运行树。

点击规则：

- `prepared` 状态可点击，显示“任务已规划，等待 Manager 分发”，不能是空白页。
- `assigned / active` 显示 A2A 任务提示和 Agent 输出。
- `failed / cancelled` 仍可点击，保留错误、日志和部分产物。

### Phase 3：ArtifactStore 一等资源化

目标：让产物可见、可交接、可追踪。

动作：

- 在已新增的 `artifacts` 表和 `ArtifactStore` 服务基础上，补齐登记、去重、投影、回放和兼容读取。
- `WorkerRuntimeService` / Code Agent adapter 通过 `ArtifactController.register()` 显式登记产物。
- 扫描 workdir 只作为 fallback，不作为主路径。
- 主群聊产物卡、任务看板产物、子对话产物统一读 `artifacts`。
- 下游任务 input 使用 `artifactRef / handoffPath`，不猜相对路径。

验收：

- Worker 生成文件后，即使最终命令失败，也能显示“部分产物已保留”。
- 下游任务能明确拿到上游 artifact 引用。
- 产物卡不会因为消息 metadata 缺失而消失。

#### ArtifactStore 契约

Artifact 是产物资源，不是消息附件。消息可以引用 artifact，AG-UI 可以展示 artifact，但 artifact 的事实中心必须在 ArtifactStore。

建议表结构：

```text
artifacts
  id
  workspace_id
  run_id
  task_id
  task_thread_id
  workspace_agent_id
  worker_instance_id
  kind = file | directory | preview | report | log | diff | url
  title
  description
  source_path
  handoff_path
  relative_path
  mime_type
  size
  checksum
  status = discovered | registered | verified | partial | failed
  visibility = private | team | user
  metadata
  created_at
  updated_at
```

所有权规则：

- `source_path` 是 Agent 执行目录中的原始路径，可用于排查。
- `handoff_path` 是系统复制/登记后的交接路径，下游任务只能稳定依赖它。
- `relative_path` 只用于 UI 展示，不作为读取依据。
- 如果任务失败但文件存在，artifact 状态应为 `partial`，并通过 `artifact.created` 事件显示“部分产物已保留”。
- 如果文件被登记但后续验证失败，不删除 artifact，只更新 status 和 metadata。

去重规则：

- 文件类 artifact 应记录 `checksum`，建议用 `sha256`。
- 同一 `task_id + checksum + relative_path` 重复登记时应幂等更新，不重复生成卡片。
- 目录类 artifact 可以记录目录 manifest checksum，第一阶段可先为空，但 metadata 里要保存文件清单摘要。

A2A / AG-UI 映射：

- A2A `responseTask.artifacts` 映射到 ArtifactStore 记录。
- AG-UI `artifact.created` 必须携带 `artifactId`，前端通过 artifact API 或 payload snapshot 渲染卡片。
- `workspace_tasks.artifacts` 迁移期只作为 ArtifactStore 的兼容投影，不再作为事实中心。
- 消息 metadata 中的 artifacts 只保存 artifact refs，例如 `{ artifactId, title, kind }`。

扫描 fallback：

- Code Agent adapter 最好显式调用 `ArtifactController.register()`。
- 如果 CLI 不能显式登记，执行结束后可以扫描 workdir 生成 `discovered` artifact。
- 扫描只能补漏，不能作为下游读取路径的依据；下游仍必须拿到 `handoff_path`。

### Phase 4：WorkerInstance 和 RuntimeLease 一等资源化

目标：让每个专家 Agent 成为真实可观察执行实体。

动作：

- 在已新增的 `worker_instances` / `runtime_leases` 表和 Worker runtime resource 服务基础上，补齐状态机、进程清理、stale/recovery 和 UI 投影。
- 引入或补齐 `runtimeFamily` / `runtimeBase` 等价字段，区分 OpenClaw/CoPaw 指挥型 runtime 与 Codex/Claude Code/OpenCode 执行型 runtime；如果当前 schema 还未支持指挥型 runtime，不要先把 OpenClaw/CoPaw 写进旧 `codeAgentType`。
- Agent 配置保存后，由 WorkerController 创建/更新 WorkerInstance。
- 每个任务执行前，RuntimeLeaseController 分配 local/docker runtime。
- 进程 pid、sandbox root、home/config/cache/tmp、container id 全部落库。
- 停止任务/停止 Agent/服务关闭时按 RuntimeLease 清理。

验收：

- 用户能看到每个 Agent 当前 `ready / busy / failed / stopped`。
- 停止按钮能清理对应 CLI 进程或 sandbox。
- 同一 Code Agent 搭配不同模型时，不共享 config/cache/session。

#### WorkerInstance / RuntimeLease 边界

`workspace_agents` 是用户配置的专家角色，`WorkerInstance` 是某个 workspace 中该专家的可运行实例，`RuntimeLease` 是某次 task 执行占用的运行环境。三者不能混成一个对象。

```text
workspace_agents
  专家定义：名字、角色提示词、skills、MCP、权限、默认 runtime binding

worker_instances
  工作区实例：当前运行时、模型绑定、健康状态、心跳、隔离目录、desired state

runtime_leases
  单次执行租约：cwd、home/config/cache/tmp、pid/container/sandbox id、清理状态
```

建议表结构：

```text
worker_instances
  id
  workspace_id
  workspace_agent_id
  runtime_family = coordinator | worker | fallback
  runtime_base = openclaw | copaw | codex | claude-code | opencode | gemini | llm-fallback
  model_id
  skill_ids
  mcp_server_ids
  sandbox_policy = workspace-write | danger-full-access
  desired_state = running | sleeping | stopped
  observed_state = provisioning | ready | busy | idle | failed
  health
  runtime_home
  runtime_config_path
  last_heartbeat_at
  message
  created_at
  updated_at
```

```text
runtime_leases
  id
  workspace_id
  run_id
  task_id
  worker_instance_id
  provider = local-workdir | docker-sandbox | remote-container
  status = creating | ready | running | cleaning | released | failed
  cwd
  home_dir
  config_dir
  cache_dir
  tmp_dir
  data_dir
  container_id
  sandbox_id
  pid
  started_at
  released_at
  error
```

生命周期规则：

- Agent 配置页保存的是 `workspace_agents`，不能代表 runtime 已经 ready。
- WorkerController 根据 `workspace_agents` 创建或更新 `worker_instances`。
- 任务开始前必须拿到 `runtime_leases`，并把 lease id 写入 RunEvent。
- 取消任务、停止 Agent、服务退出时，必须按 lease 清理进程和 sandbox。
- 服务重启后，`running` lease 需要被标记为 `failed` 或进入 recovery，不允许 UI 继续显示“运行中”。
- `local-workdir` 只能声明“环境目录隔离”，不能声明 OS 级安全沙箱。
- 当前默认 provider 是 `local-workdir`，因为它最贴近本地 Coding Agent 的轻量体验；设置页可选择切换到 `docker-sandbox`。
- `docker-sandbox` 只有在 `sandboxRunnable=true` 且用户/策略明确启用时才能作为执行 provider，否则必须透明降级到 `local-workdir` 或阻止启动并说明原因。

OpenClaw/CoPaw 作为指挥型 runtime 时，也必须遵守 WorkerInstance 生命周期，不能开一个不可追踪的后台进程。

### Phase 5：RunController 替代 OrchestratorEngine 主流程

目标：从过程式 engine 迁移到 Manager-loop + 资源控制器。RunController 负责状态推进，ManagerLoop 负责协作决策。

动作：

- `RunController.reconcile(runId)` 根据 Run/Task/Worker/Artifact/Event 状态推进。
- 新增 `ManagerLoop.step(runId)`，读取用户消息、WorkLedger、TaskThread、Worker 回报和 ArtifactStore，决定下一步动作。
- 旧 `TaskScheduler` 已删除；ready-node / dependency layer 语义由 Coordinator assign 的 `dependsOn`、RunController 状态和 ManagerLoop dispatch/reconcile 承接。
- `OrchestratorEngine.startRun()` 逐步降级为旧路径兼容入口。
- Planner 变成 ManagerLoop 可调用的技能，输出只创建或更新 WorkLedger，不直接启动所有执行。
- Supervisor / Manager 追加任务必须经过 RunController 创建 Task/TaskThread/Event。

验收：

- 服务重启后能根据资源状态恢复或标记待恢复，不靠内存 Map。
- 暂停、恢复、取消、重试、跳过都通过 Run desired state 实现。
- Orchestrator/Manager 不再混杂 session 创建、DB task 插入、执行、合成、事件广播。
- Manager 的每个可见动作都有 RunEvent，可被用户和开发者追踪。

#### RunController 执行模型

第一版不要直接做复杂后台调度系统。建议采用“Manager step + 可重入 reconcile 函数 + 轻量触发器”的模型：

```text
POST /messages
  -> ChatIngress 写消息
  -> ManagerLoop.createOrRoute()
  -> ManagerLoop.step(runId)
  -> RunController.reconcile(runId)

用户确认/取消/重试
  -> 写 control record
  -> ManagerLoop.step(runId)
  -> RunController.reconcile(runId)

任务完成/失败
  -> 写 Task/Artifact/Event
  -> ManagerLoop.step(runId)
  -> RunController.reconcile(runId)

服务启动
  -> 扫描未终态 run
  -> 标记 stale runtime lease
  -> 对可恢复 run 调用 ManagerLoop.step(runId) + reconcile(runId)
```

约束：

- `ManagerLoop.step(runId)` 必须一次只做一个或少量明确动作：澄清、补员、委派、等待、追问、返工、汇总。
- `reconcile(runId)` 必须可以重复调用。
- 不能依赖内存 Map 作为事实中心。
- 每一步先读数据库 snapshot，再决定下一步 action。
- action 必须落 RunEvent，方便 UI 和排查。
- 如果模型规划失败，按语义透明写事件：致命失败写 `run.failed`；需要用户补充或确认时写 `approval.requested` / `task.clarification_needed` / `manager.next_action`，并在 payload 中标记 blocked/awaiting_user。当前代码尚未支持 `run.blocked` 事件名，除非先扩展 `OrchestratorRunEventType`、AG-UI 映射和前端消费，否则不要直接写 `run.blocked`。

第一版可以同步触发 reconcile，但每个耗时执行必须进入 `WorkerRuntimeService` / `RuntimeLeaseController`，不要阻塞 HTTP 请求直到所有任务完成。后续再替换为 durable job runner。

### Phase 6：可选外部基础设施适配

目标：保留未来接 HiClaw / Matrix / MinIO / 远程 A2A 的空间。

动作：

- `CommunicationProvider`
  - `agenthub-im` 默认
  - `matrix` 可选
- `ArtifactProvider`
  - `local-fs` 默认
  - `s3/minio` 可选
- `RuntimeProvider`
  - `openclaw-manager`
  - `copaw-manager`
  - `local-workdir`
  - `docker-sandbox`
  - `remote-container`
- `CredentialProvider`
  - `agenthub-model-catalog`
  - `gateway-consumer`

验收：

- AgentHub 保持本地轻量体验。
- 后续可接 HiClaw 风格远程 Worker，而不推翻内核。

### Phase 6.5：OpenClaw / CoPaw 接入前置研究门槛

OpenClaw / CoPaw 目前只能作为候选 coordinator runtime 进入设计，不应直接进入实现。实现前必须完成一份 adapter research note，回答以下问题：

1. 启动方式：它是一次性 CLI、长期进程、服务端 daemon，还是容器内 agent loop？
2. 通信方式：它通过 stdin/stdout、HTTP、WebSocket、Matrix/IM channel，还是自己的任务协议接收指令？
3. 身份模型：它如何表达 Manager、Team Leader、Worker、Human？是否能映射到 AgentHub 的 Team / TaskThread？
4. 配置隔离：模型、凭据、skills、MCP、cache、session 如何隔离？是否支持每 Agent 独立 runtime home？
5. 产物协议：它如何登记文件、报告、日志、链接？是否能映射到 A2A artifact 和 AgentHub ArtifactStore？
6. 生命周期：能否健康检查、停止、恢复、清理？异常退出时如何感知？
7. 许可和分发：是否允许内置、二次封装、随项目分发？是否需要用户自行安装？
8. Windows 本地体验：是否能在 Windows 上可靠运行，还是必须 WSL/Docker？

只有这些问题回答清楚后，才能新增：

```text
CoordinatorRuntimeAdapter
  probe()
  prepareConfig()
  start()
  sendMessage()
  observeEvents()
  stop()
  cleanup()
```

并接入：

```text
WorkerInstance(runtimeFamily="coordinator", runtimeBase="openclaw")
RuntimeLease(provider="local-workdir" | "docker-sandbox" | ...)
TaskThread / A2A / RunEvent / ArtifactStore projection
```

禁止事项：

- 禁止把 OpenClaw 简单加入 `codeAgentType` 下拉框。
- 禁止让 OpenClaw 绕过 A2A / RunEvent / TaskThread 直接写 UI 消息。
- 禁止在没有生命周期控制时启动长期后台进程。
- 禁止把 OpenClaw 的团队/房间模型直接覆盖 AgentHub 的 IM 会话树；必须通过 projection 层适配。

## 7. 需要避免的误区

### 不要直接照搬 HiClaw 的重栈

Matrix / MinIO / Higress / K8s 是 HiClaw 的部署选择，不是 AgentHub 眼下必须引入的基础设施。我们要学的是资源模型和生命周期。

### 不要把资源控制平面做成固定模板

Team、Worker、Task 是资源，不是“网站建设模板”。Manager 仍然动态理解目标、选择成员、创建账本和调整分工；系统只负责资源创建、校验、状态推进。

### 不要恢复关键词路由

Manager 判断、Planner 分工、补员建议、追加任务仍然必须来自模型输出。控制平面只能执行明确决策，不能偷偷替模型判断。

### 不要让 DAG 成为主脑

DAG 是 WorkLedger 的结构化视图，用于可视化、依赖、恢复、重试和审计。它不是系统替 Manager 决策的主脑。复杂任务允许 Manager 先创建粗粒度任务，再随着 Worker 回报动态细化、返工、补员或取消。

### 不要让 Worker 变成后台函数

Worker 必须像团队成员一样在 TaskThread 中接收任务、提出问题、回报进度和交付产物。`WorkerRuntimeService` 可以负责启动 CLI，但不能让用户只看到一条后台任务日志。

### 不要让 AG-UI 只是事件装饰

AG-UI 必须成为 UI runtime projection，而不是“执行过程中顺手广播一下”。前端应从 AG-UI / RunEvent 恢复完整运行视图。

### 不要让 Artifact 继续依赖消息 metadata

消息是交流记录，Artifact 是产物资源。两者可以互相引用，但不能互相替代。

## 8. 第一刀建议

第一刀不要直接重写所有编排，也不要先接 OpenClaw。建议从 **ManagerLoop 壳 + RunEvent replay + TaskThread projection + shared task directory** 开始，因为它最直接改变用户体感：用户发消息后看到的是 Manager 在接任务、判断、准备分工，而不是系统空白等待一个 DAG。

最小改造目标：

```text
用户发出复杂目标后：
  1. ManagerLoop 立即创建 run.started / manager.thinking
  2. Manager 在主群聊给出模型生成的承接说明；模型尚未返回时先显示 RunEvent 驱动的可见状态
  3. ManagerLoop 调用 Manager-first planning action 生成初版 WorkLedger；旧 Planner 只作为校验/兼容工具
  4. 每个 task 创建 shared/tasks/{taskId}/spec.md
  5. 每个 task 创建 TaskThread(prepared)，并写入透明系统状态
  6. RunEvent 记录 plan.created / task.planned / thread.prepared
  7. SessionList 从 TaskThread projection 显示子对话
  8. 前端任务看板完全由 RunEvent + TaskThread 恢复
```

这一步完成后，用户会立刻感受到：

- 发消息后不再空白。
- 主群聊里是 Manager 在承接任务，而不是系统机械规划。
- 子对话入口不再消失。
- 未正式分配也能看到“准备中”。
- Worker 正式接任务前已经有标准任务目录和 spec.md，不再只靠一段后台 prompt。
- 切换回来不丢状态。

随后再做 ArtifactStore 和 WorkerInstance，逐步把 Worker 回报、Manager 验收、返工和补员都纳入 ManagerLoop，最后再替换 OrchestratorEngine 的过程式主流程。

### 当前第一刀进度快照（2026-06-03）

已完成：

- `TaskThread` 投影服务已接入任务准备流程，任务规划后可以提前创建 `orchestrator-task` 子对话，并严格绑定 `runId + taskId + groupSessionId`。
- 前端会话树已按 `groupSessionId` 挂载群聊下任务子对话，不再按 workspace 混挂，也不再补齐旧 `workspace-agent-child` 占位入口。
- `plan.created` / `task.planned` / `thread.prepared` 事件已携带 `taskThreadId`、`childSessionId`、`workerInstanceId`、`sharedTaskRelativeRoot`、`sharedTaskSpecPath`，AG-UI adapter 已能把 `thread.prepared` 投影为任务状态。
- `.agenthub/shared/tasks/{taskId}` 会生成 `meta.json`、`spec.md`、`base/`、`artifacts/`。
- A2A `message/send` 的正文已注入共享任务目录协议，Worker 能在协议消息里看到 `spec.md -> plan.md -> result.md -> artifacts/` 的交付契约。
- Code Agent prompt 已注入同一份共享任务目录协议，避免 CLI Worker 只看到普通 prompt 而不知道共享目录交付规则。
- `result.md` 已采用 HiClaw taskflow 风格的机器可读结果契约：`STATUS / SUMMARY / DELIVERABLES / NOTES`。最终汇总前会读取并校验这份契约，成功产物会转成正式 artifact refs；`REVISION_NEEDED / BLOCKED / INTERRUPTED` 会同步回 `workspace_tasks`、`TaskThread` 和 RunEvent，而不是只在总结文本里提示。
- Orchestrator 任务主路径已把登记后的 `ArtifactStore` 记录回流为 canonical artifacts，后续黑板写入、任务结果、事件载荷和最终汇总会优先沿用这份产物事实，而不是继续只依赖扫描结果或消息 metadata。
- 前端 `taskBoard` 已进一步收敛为 `resourceSnapshot` 优先：当 run snapshot 中存在 task-thread / runtime-lease / artifact 事实时，任务卡会直接使用 snapshot 覆盖旧 task/message 投影，不再把旧 artifacts 和 canonical artifacts 混拼成双份来源。
- 群聊最终总结消息现在会在加载 run snapshot 后，用 canonical `ArtifactStore` artifacts 回填 `artifacts / file_card / delivery_report.files`，主群聊交付卡不再只依赖消息写入当时留下的 metadata。
- `RunController` 已开始接管 run 生命周期主干：群聊规划落地阶段会先通过 `prepareForDispatch()` 写入 plan/planMessageId 并广播 `dispatching` 管理事件，执行器启动后通过 `markRunning()` 切到运行态，汇总前通过 `markSynthesizing()` 切到汇总态，最终由 `finish()/fail()` 统一收口完成/失败事件和状态写库。
- `RunController.cancel()` 已落地并接入真实入口：`/api/orchestrator-runs/:id/cancel` 不再自己直接写 `orchestrator_runs / workspace_tasks` 和单发 `run.cancelled` 事件，而是统一通过控制面取消未终态任务、写入取消事件并让 `progressLedger` 跟随事件更新。
- 服务进程退出时的 shutdown recovery 已开始走同一条取消链路：`index.ts` 在停止活跃 run 时会先读取 run 上下文，再通过 `RunController.cancel()` 统一写入 `server_shutdown` 取消原因，而不是沿用旧的散写状态更新。
- `OrchestratorEngine.resumeRun()` 的失败分支已开始改走 `RunController.fail()`；resume/normal run 两条路径不再分别手搓 `run.failed` 状态和事件。
- `manager-loop.ts` 已继续瘦身：当前只保留 `startManagerLoopRun()` 与 `emitManagerDecisionEvents()` 这类 Manager 壳入口，不再保留 `completeManagerLoopRun()/failManagerLoopRun()` 这类旧 lifecycle helper，避免后续开发继续绕开 `RunController` 写 `run.completed/run.failed/run.cancelled`。
- AG-UI 的 run 级事件投影已补强：`run.started / run.completed / run.failed / run.cancelled / run.synthesizing` 现在除了 `RUN_STARTED / RUN_FINISHED / RUN_ERROR` 外，还会统一投影 `agenthub.run.status`，前端恢复运行态时可以更多依赖统一的 run status 事件，而不是混合猜测粗粒度终态事件。
- `retryTask()` 已开始接回统一生命周期：任务重试会先通过 `RunController.markRunning()` 把 run 拉回运行态，再写入 `task.retrying` 事件；如果重试最终失败或取消，会继续统一走 `RunController.fail()/cancel()`，不再只在 task 层局部更新。
- 前端 `chatStore` 的任务看板 reducer 已继续收口：`applyAgUiTaskStatus()`、`applyAgUiRunStatus()`、`applyResourceSnapshotToTaskBoard()` 现在共用一层 `applyTaskBoardTasks()/applyTaskBoardRunStatus()`，不再分别散写 taskBoard 的 phases/status。
- `taskBoardFromRun()` 和 `resourceSnapshot` 恢复路径都已补上 phase 状态重算：任务线程从 `running -> completed` 或 ledger 中任务已终态时，阶段状态会同步从 `active` 转成 `completed`，避免出现“任务都结束了但阶段仍显示 active”的旧 UI 残留。
- 前端运行态投影已开始分层：`chatStore` 里新增 `reduceRuntimeActivityProjection()`，把 `agentTyping / agentActivity` 从 `applyAgUiEventToState()` 中和 `taskBoard` 推进逻辑拆开，Manager 思考、任务执行、汇总中、结束清空这些活动状态现在先走独立 runtime activity reducer。
- WebSocket 实时运行态也开始收口到独立 projection：`AgentTyping / MessageStream / MessageMetadata / MessageCompleted / MessageCancelled` 不再各自直接拼聊天态，而是开始共用 `buildReplyingRuntimeProjection()`、`applyLiveMessageStreamProjection()`、`applyLiveMessageMetadataProjection()`、`clearLiveRuntimeProjection()` 这层 live runtime helpers。
- 前端会话树与运行态快照的合流又往前走了一步：`fetchSessions()` 不再单纯用后端 session 列表覆盖本地树，而会把当前 `taskBoard` 里的 orchestrator task threads 重新投影回 `sessions`；这样刷新列表、切换会话或 AG-UI 触发补拉时，不会再把“准备中/运行中”的子对话入口直接刷没。
- 前端控制面开始从“页面临时拼状态”收敛成统一 projection：`WorkspaceChatPage` 不再自己临时统计 `activeAgentCount`，而是通过 `buildControlPanelProjection(taskBoard + agentTabs + runtimeActivity)` 生成左侧控制面事实；`AgentTabs` 现在可以直接显示当前活动成员与执行阶段，减少 `TaskBoard / AgentTabs / 顶部运行提示` 三套来源各自漂移。
- 主线程的运行态提示也开始和控制面共用同一份 runtime 描述：`runtime.tsx` 不再自己硬编码 `planning / thinking / executing / synthesizing` 文案分支，而是复用 store 中的 `describeRuntimeActivity()/runtimeActivityLabel()`；这样左侧控制面和中间对话区对“谁在执行、现在处于什么阶段”的表述终于开始对齐。
- 右侧 `TaskBoard` 也开始从“组件里现场推理状态”收敛到统一 panel projection：阶段完成计数、任务结果行显隐、产物数量、progress tone、失败/运行态样式不再在 `TaskBoard.tsx` 里临时计算，而是先由 store 中的 `buildTaskBoardPanelProjection(taskBoard)` 派生，再交给组件纯渲染。这样左右中三块面板都开始围绕同一份 run/thread/task 事实做 UI 投影。
- `agenthub.task.status` 事件已开始显式携带 `taskThreadStatus` 语义，前端 `chatStore` 也新增统一的 `reprojectRunResourcesIntoUi()` 收口 helper：即使当前帧没有新的 `resourceSnapshot`，只要收到 `prepared / assigned / active / completed` 这类线程语义，Agent tabs 和子对话入口也会优先按 TaskThread 事实重投影，而不是再走旧的局部补丁分支。
- 服务端 `run detail` 已开始直接前推控制面事实：`/api/orchestrator-runs/:id` 现在除了 run 基础字段，还会返回 `taskBoardSnapshot + resourceSnapshot + agUiEvents`，把任务看板、任务线程、runtime lease、artifact 和事件重放所需的恢复包更多收拢到同一条 API，而不是让前端刷新后再各处散拉、散猜。
- 前端 `taskBoardFromRun()` 已开始优先消费服务端 `taskBoardSnapshot`；只有旧数据或字段缺失时，才回退到本地从 `plan/taskLedger/resourceSnapshot` 重建任务看板。这意味着“控制面事实从浏览器临时推理前推到服务端快照”已经迈出第一步。
- 前端加载会话时的活动态恢复也往控制面收了一刀：`loadTaskBoardSnapshotForSession()` 现在会先基于 `taskBoard + agUiEvents` 生成 `runtimeActivity`，并在进入群聊/子对话时直接恢复 `agentTyping / agentActivity`。即使 replay 暂时不可用，只要 `taskBoard` 里已经有 running task，前端也能先恢复“谁在执行”；如果 run 处于 `planning / synthesizing`，也会先恢复 Orchestrator 的阶段态，而不是先清空再等事件回灌。
- `run-events` 已补上迁移期自愈：如果本地数据库还缺 `orchestrator_run_events.sequence/thread_id/worker_instance_id`，事件层会先补齐列和索引再继续写入，避免旧库在新资源投影接入后直接崩掉。
- `RunController` 已开始下沉到 task 级控制面：除了 run 生命周期外，`requeueRunningTasksForResume()` 现在会在服务重启恢复时统一把 `running` 任务重排回 `pending`、把对应 `TaskThread` 收回 `prepared` 并写出 `task.queued` 事件；`markTaskBlocked()` 会统一处理 `blocked_by_dependency` 这类阻塞任务，把 task row、thread 状态和失败事件一起收口到控制面，不再由 `OrchestratorEngine` 在多个分支里重复散写。
- 生命周期收口相关 smoke test 已覆盖三条主链路：`orchestrator run can be cancelled and marks unfinished tasks`、`run controller drives orchestrator run lifecycle through dispatch, execution, synthesis, and completion`，以及 `retry task re-enters run execution lifecycle and records retry events`。
- 服务端控制面快照相关 smoke test 已补上：`orchestrator run detail returns task board snapshot and control-plane resources`，确保 `/api/orchestrator-runs/:id` 返回的 `taskBoardSnapshot`、`resourceSnapshot` 和 `agUiEvents` 能同时覆盖 task/thread/runtime/artifact 这几类一等资源，而不是只验证前端本地投影。
- 前端状态收口相关测试已覆盖：`chat store artifact snapshot projection > resource snapshot recomputes phase status from task thread state` 与 `task board derived from run snapshot normalizes phase status from task ledger`，确保刷新恢复和资源快照回放都能重建正确阶段状态。
- 子对话稳定性相关测试已补上：`chat store artifact snapshot projection > session refresh preserves orchestrator task threads projected from the current task board`，确保运行中的任务线程不会因为一次 session refresh 被本地树抹掉。
- 控制面投影相关测试已补上：`chat store artifact snapshot projection > control panel projection reflects executing agent activity on top of task board tabs`，确保“谁在执行”开始进入统一 panel projection，而不是靠页面临时统计。
- runtime activity 描述统一后，控制面投影测试同时覆盖了共享 label：当前执行成员的 `phase` 与 `label` 会一起进入 projection，保证左侧控制面和主线程提示不会再各自飘不同的阶段文案。
- 右侧面板 projection 相关测试已补上：`chat store artifact snapshot projection > task board panel projection derives phase counters and task result badges from task board state`，确保 TaskBoard 的阶段计数、任务结果摘要显隐、产物徽标与运行态颜色开始由统一 projection 决定，而不是组件私下再推导一遍。
- 运行中人类介入的第一条真实主链路已打通：当群聊存在活跃 run 时，主群聊里的新补充要求会被挂接到当前 run，登记成 `human_interrupt` blackboard entry，并投影成 Manager 在主群聊的确认消息与活跃 TaskThread 的同步消息，而不是再默认重开一轮 run。
- TaskThread 级人类介入也已接入同一控制面：用户在 `orchestrator-task` 子对话中补充或纠偏时，消息不再走普通 direct agent reply，而是按该 TaskThread 绑定的 `runId` 精确写入 `human_interrupt`，并在 blackboard / RunEvent / Manager 可见消息里保留 `source=task_thread`、`taskThreadId`、`taskId`、`childSessionId`。这让 TaskThread 开始接近 HiClaw Room 的语义：Human 可以进入 Worker 房间干预，Manager 负责吸收并协调后续动作。
- 这条链路已经开始接入控制面：`RunController.reconcile()` 现在会消费未处理的 `human_interrupt`，把约束并入未完成任务描述，登记 `manager_actions/human_interrupts/*`，并发出 `run.replanned(strategy=human_interrupt)` 与 `task.rework_requested`。这意味着 Human 的插话开始进入 Manager 账本，而不只是停留在聊天时间线上。
- live worker interrupt 的第一刀也已落下：当 `human_interrupt` 命中 active task thread 时，Manager 现在会中断对应 task room 执行，把相关 `RuntimeLease` 经 `RuntimeLeaseController` 标成 stale，并把 `WorkerInstance` 收回 idle。旧 `TaskScheduler -> TaskExecutionService -> LocalA2ATransport -> runAgentReply` cancel/abort 链已删除；后续更完整的 cancel/abort 只能继续在 `RunController` / `WorkerRuntimeService` / 进程生命周期管理中补齐，`cancelled` 不能再被错误吞成 `failed`。
- runtime activity 分层相关测试已覆盖：`chat store artifact snapshot projection > runtime activity projection tracks manager, task execution, and synthesis states`，确保前端“谁在执行、执行到哪”开始有独立可验证的状态推进。
- snapshot 恢复活动态相关测试已补上：`snapshot-derived runtime activity falls back to the running task when replay is unavailable` 与 `snapshot-derived runtime activity falls back to orchestrator planning and synthesizing states`，确保刷新恢复时即使不先 replay 全部事件，控制面也能从当前 taskBoard 快照恢复出基本活动态。
- 线程语义直达前端的测试也已补上：`ag-ui adapter > maps task.started to task status with active task thread semantics` 与 `chat store artifact snapshot projection > task status event reprojects sessions and tabs from task thread semantics without resource snapshot`，确保实时 `task.status` 事件本身就能稳定驱动“谁在执行 / 子对话归谁 / 线程现在处于什么阶段”。
- 恢复与阻塞任务的控制面测试也已补上：`run controller requeues running tasks for resume and resets task thread state` 与 `run controller marks blocked tasks through the control plane and syncs task threads`，确保服务重启恢复和依赖阻塞不再只是 task 表单点改写，而会连同 `TaskThread` 和事件流一起进入统一控制面。
- 共享任务结果契约相关测试已补上：`tests/shared-task-directory.test.ts` 覆盖 `result.md` 写入、解析和路径校验；`tests/shared-task-result-contract.test.ts` 覆盖共享结果状态到控制面状态和 artifact refs 的映射。

进行中：

- RunEvent / AG-UI 仍在从“广播辅助状态”收敛为前端运行态事实流；任务看板、Agent tabs、产物卡还未完全只从 replay 和资源 snapshot 恢复。
- run detail 虽然已经开始返回 `taskBoardSnapshot + resourceSnapshot + agUiEvents` 这类控制面恢复包，前端也开始基于 snapshot 直接恢复活动态，但当前仍会在若干路径上额外请求 replay events、并保留本地重建 fallback；后续还要继续把“刷新恢复控制面”的入口收敛到更明确的服务端 snapshot/replay 契约。
- ArtifactStore 已接入任务执行主路径，任务卡和群聊总结卡也开始吃 canonical snapshot，但消息流运行时、独立 run detail 视图和部分旧 metadata part 仍处于“snapshot 优先、消息兼容”迁移期。
- WorkerInstance / RuntimeLease 已有第一轮 controller ownership：Worker ensure-ready、heartbeat、stale recovery、idle-stop、startup/shutdown lease recovery、task room running/waiting/released/stale 都已经进入 `WorkerController` / `RuntimeLeaseController`。剩余差距主要是长期 Worker 等待/恢复状态机、runtime reconfigure、per-agent config/cache/session 隔离和更完整的 durable reconcile queue。
- `resume/retry/requeue/cancel/final review` 的外部主路径已开始切到 `RunController` / `ManagerLoop` / `WorkerRuntimeService`，但旧 `OrchestratorEngine` 内部仍有复杂 replan/retry、冲突合并后的后续动作和部分状态散写，需要作为下一轮“删除迁移层”切片继续拔干净。
- 前端虽然已经能从 `agenthub.run.status + task.status + resourceSnapshot` 恢复更多运行态，但 `RUN_FINISHED / RUN_ERROR / CUSTOM` 三种事件分支仍并存，chat store 里还有一部分状态归并逻辑可以继续向“统一 run/task status reducer”收敛。
- `chatStore` 虽然已经把 runtime activity 和 live runtime helper 抽出第一层，但成员汇报消息、Manager review 结果、Code Agent 流式输出、message cache 与 runtime activity 仍未完全形成独立 projection slice，后续还要继续拆成更清晰的前端控制面状态。

下一步建议：

1. 继续把主群聊运行中消息部件、run detail API 和前端运行详情改成优先读 `ArtifactStore` / `resourceSnapshot`，把 `messages.metadata.artifacts` 压缩成兼容引用层。
2. 继续扩展 run detail / replay snapshot，让前端刷新后不仅能恢复任务看板和子对话入口，还能恢复“谁在执行、执行到哪、当前产物有哪些”的连续运行态，并逐步减少额外的 replay 拉取与本地猜测逻辑。
3. 继续把 `OrchestratorEngine` 中剩余的复杂 replan/retry、冲突合并后的后续动作、progress/heartbeat 持久化收口到 `RunController.reconcile()` / `ManagerLoop.step()` / `WorkerRuntimeService`，让 DAG 成为 Manager 的账本，而不是一次性流程主脑。
4. 继续把前端 chat store 的 `RUN_FINISHED / RUN_ERROR / agenthub.run.status / agenthub.task.status / resourceSnapshot` 归并逻辑收成更统一的 reducer，让刷新恢复和实时事件消费完全共用一套状态推进规则。
5. 把 `agentTyping / agentActivity / member report / manager review` 这些运行态 UI 投影继续从 taskBoard reducer 中拆开，形成更接近 HiClaw “运行状态面板 + 任务线程 + 资源快照” 的前端控制面。
6. 把 `resume/retry` 触发后的前端 runtime projection 也纳入同一套事件恢复链路，避免“刷新后任务看板恢复了，但当前谁在执行/为什么卡住”仍然需要临时状态猜测。
7. 继续把 WebSocket 的 `MessageStream / MessageMetadata / MessageCompleted` 和 AG-UI 运行事件统一到更完整的 live runtime projection，减少“消息流”和“运行态”两套状态并存的前端复杂度。
8. 继续把 `human_interrupt` 从“已经能 interrupt active worker”推进成“完整的 Worker lifecycle orchestration”：ManagerLoop 接下来要能在 interrupt 之后自动决定重派任务、重试未完成 work、恢复 idle worker，或向 Human 请求更高层确认，而不是停在 interrupt + stale lease。

## 9. 开 Goal 前施工护栏

这份文档是重构方向，不是一次性推倒重写清单。开 goal 后必须按可验证切片推进，每个切片都要保持当前产品可启动、可创建群聊、可进入子对话、可执行至少一个 Code Agent 任务。

### 第一阶段只允许做什么

- 建立 `ManagerLoop` 壳，让用户发消息后立即看到事件驱动的运行状态，并在模型返回后看到 Manager 承接、思考和下一步。
- 让 `RunEvent` 成为任务看板、进度、子对话入口和产物卡的事实来源；旧接口只做兼容投影。
- 让 `TaskThread` 在任务规划后立即准备好，未分配也可点击，不再靠前端补空壳。
- 引入 `.agenthub/shared/tasks/{taskId}` 任务目录协议，让 Worker 接到的是可追踪的任务 spec。
- 继续复用现有 Code Agent adapter；新任务执行入口必须走 `WorkerRuntimeService`。`TaskExecutionService` 只允许留在旧 `OrchestratorEngine` 迁移兼容层内部，不再作为新增执行路径。

### 第一阶段明确不做什么

- 不接 OpenClaw / CoPaw 到主路径，不把它们加入普通 `codeAgentType` 下拉。
- 不引入 Matrix、MinIO、K8s、Higress 作为默认依赖。
- 不新建固定团队模板、固定场景 spec、关键词路由或静态兜底计划。
- 不用固定“我将如何处理”话术假装 Manager 思考；模型承接失败时写透明错误或等待状态。
- 不把 `workspace_tasks.status` 直接写成旧 enum 不支持的新状态；细状态先走 RunEvent payload、新表或投影字段。
- 不删除历史数据表和旧会话；迁移期只隐藏、投影或兼容读取，避免历史运行不可读。

### 每个切片的最低验收

- `bun --filter @agenthub/server typecheck`
- `bun --filter @agenthub/web typecheck`
- `bun --filter @agenthub/db typecheck`
- 手工验证：创建群聊 -> 发复杂目标 -> 1 秒内有 Manager 反馈 -> 任务看板出现 -> 子对话 prepared 可点击 -> 分配后子对话有 A2A 任务消息 -> 切换回来状态不丢。

### 失败处理原则

- 模型规划失败时透明写 `run.failed`，或用 `approval.requested` / `task.clarification_needed` / `manager.next_action` 表达可恢复阻塞；不要在未扩展事件类型前写 `run.blocked`，也不要用静态关键词生成假计划。
- Worker 执行失败但有文件产出时，必须登记 partial artifact，并在主群聊说明“部分产物已保留”。
- 子对话创建失败时，任务进入 blocked，不能让 UI 自动创建一个看似真实的空子会话。
- 服务重启后，仍显示 running 的 RuntimeLease 必须标记 stale、failed 或 awaiting_recovery，不能继续假装正在运行。
