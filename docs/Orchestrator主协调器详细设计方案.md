# AgentHub Orchestrator 主协调器详细设计方案

> 日期：2026-05-27  
> 范围：群聊模式下的主 Agent 协调器，包括意图理解、任务拆解、Agent 分派、并行调度、失败降级、代码冲突处理、结果聚合和聊天流汇报。  
> 目标：把赛题中一句“主 Agent 协调器”拆成可实现、可演示、可扩展的工程设计。
> 状态：历史设计资料，部分 runtime/协议边界已调整。当前实现请以 `docs/当前多Agent协作架构.md` 和 `docs/多Agent协作分层架构与业内对比.md` 为准。本文中的固定团队、远程 runtime、分支隔离等旧设计不代表当前默认路径。

---

## 1. 设计目标

赛题给出的描述很简洁：

- 在群聊模式下，自动理解用户意图，将复杂任务拆解并分派给合适的子 Agent。
- 子 Agent 完成后，Orchestrator 聚合产出并在聊天流中汇报结果。
- 支持并行调度、失败降级、代码冲突处理。

真正落地时，Orchestrator 不能只是“调用 LLM 生成一个 DAG，然后并发跑几个 Agent”。它应该是 AgentHub 的协作运行时，负责把用户的自然语言任务转化为一场可观察、可控制、可恢复、可审查的多 Agent 工作流。

本文建议把 Orchestrator 定义为：

> 一个运行在群聊里的主协调 Agent。它负责识别复杂任务，生成执行计划，维护任务账本，调度子 Agent，收集中间产物，处理失败和冲突，并把最终交付以任务卡、产物卡和汇总报告的形式回写到聊天流。

---

## 2. 业内参考与设计吸收

### 2.1 Anthropic：Orchestrator-worker 不适合所有任务

Anthropic 的多 Agent Research 系统采用 lead agent + subagents 架构。Lead agent 负责拆解问题、派生多个 subagent 并行搜索，再合成最终答案。Anthropic 强调这种模式适合信息量大、探索方向多、上下文可能超过单 Agent 容量的任务，但也承认 token 成本显著上升，并且多数代码任务未必天然高度并行。

对 AgentHub 的吸收：

- Orchestrator 启动前必须做 **复杂度与可并行性判断**。
- 简单任务不要强行多 Agent。
- 多 Agent 的价值要体现在更快的墙钟时间、更高的覆盖率、更好的审查质量，而不是 Agent 数量。

参考：[Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

### 2.2 Kimi Agent Swarm：动态子 Agent 与 context sharding

Kimi Agent Swarm 强调主 Agent 可以协调大量并行子 Agent，适合大规模资料收集、长文档生成、复杂多步骤任务。它的关键价值不是固定角色，而是按任务动态创建子 Agent，并把上下文切分给不同子 Agent 处理。

对 AgentHub 的吸收：

- 不要一开始追求数百 Agent，而是做 **小规模可控 Swarm**：默认 3 个并发，上限 8 个。
- 对代码库理解、资料调研、测试扫描、文档生成等任务使用 context sharding。
- 临时 Agent 必须有任务边界、输出契约和退出机制。

参考：[Kimi: K2.6 Agent Swarm](https://www.kimi.com/help/agent/agent-swarm)

### 2.3 Magentic-One：Task Ledger + Progress Ledger

Magentic-One 的 Orchestrator 不只是分派任务，而是维护任务账本和进度账本。Task Ledger 记录总体目标、计划、已知事实、待完成步骤；Progress Ledger 在执行过程中反思是否完成、是否卡住、是否需要换计划。

对 AgentHub 的吸收：

- 现有 `ExecutionPlan` 应升级为 **Run Ledger**。
- 每轮任务执行后都要更新 Progress Ledger。
- 重试、替换 Agent、局部重规划、用户介入都应写入 Ledger，而不是只写日志。

参考：[AutoGen Magentic-One](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html)

### 2.4 LangGraph：durable execution 与 human-in-the-loop

LangGraph 强调长运行、状态持久化、恢复、打断、人工介入和可观测性。AgentHub 可以不引入 LangGraph，但应该吸收它的运行模型。

对 AgentHub 的吸收：

- Orchestrator Run 必须有可持久化状态。
- 支持 pause / resume / cancel。
- 高风险动作进入 human approval gate。
- 前端用事件流展示运行过程，而不是只展示最终消息。

参考：[LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)、[LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)

### 2.5 OpenAI Agents SDK：manager、handoff、guardrails、tracing

OpenAI Agents SDK 把多 Agent 协作分为 manager pattern 和 handoff pattern，并提供 guardrails 和 tracing。AgentHub 的 `@orchestrator` 是 manager pattern；群聊中 `@Agent` 更接近 handoff。

对 AgentHub 的吸收：

- Orchestrator 作为 manager，保留控制权。
- 子 Agent 不直接决定整个 run 走向，只能提出 handoff 或 replan suggestion。
- 输入和输出都要有 guardrails。
- 每个 run 应有 trace：plan、task、LLM、tool、blackboard、artifact、error。

参考：[OpenAI Agents SDK: agents](https://openai.github.io/openai-agents-python/agents/)、[OpenAI Agents SDK: guardrails](https://openai.github.io/openai-agents-python/guardrails/)、[OpenAI Agents SDK: tracing](https://openai.github.io/openai-agents-python/tracing/)

---

## 3. 当前代码基础与需要补齐的设计层

AgentHub 当前已有：

- `Planner`：可生成 spec 和任务 DAG。
- `TaskGraph`：拓扑排序、依赖判断。
- `TaskScheduler`：并发执行，默认 semaphore=3。
- `ReplanningEngine`：根据失败类型选择 retry、agent substitution、local replan、task split、escalate 等策略。
- `ConflictResolver`：收集多个 Agent 的 diff，尝试自动合并或 LLM merge。
- `Synthesizer`：汇总子 Agent 产出。
- `Blackboard`：版本化共享状态。
- `ExecutionTracer`：记录 LLM、tool、blackboard、task_start/task_end 等日志。
- `RuntimeRegistry`：统一 `llm`、`code-agent`；A2A 是通信协议，MCP 是工具能力层。

需要补齐的是一个更清晰的 **Orchestrator Run 协议**：

```text
User Message
  -> Intent Router
  -> Clarifier
  -> Plan Builder
  -> Plan Review / User Confirmation
  -> Run Manager
  -> Scheduler
  -> Agent Runtime
  -> Blackboard / Artifacts / Run Events
  -> Failure & Conflict Handling
  -> Synthesizer
  -> Chat Report
```

现有模块不一定要推翻，但需要被 Run Manager 统一编排。

---

## 4. Orchestrator 的核心职责边界

### 4.1 Orchestrator 应该做什么

Orchestrator 负责：

1. 判断用户意图是否需要多 Agent。
2. 在需求不清时提出澄清问题。
3. 将任务拆成阶段、任务、依赖和产物契约。
4. 选择合适 Agent。
5. 控制并发、超时、预算、重试。
6. 维护 Task Ledger / Progress Ledger。
7. 写入和读取 Blackboard。
8. 收集 artifact。
9. 处理失败、重规划、Agent 替换。
10. 处理代码分支冲突。
11. 汇总各 Agent 贡献和风险。
12. 在聊天流中给用户可理解的进度与结果。

### 4.2 Orchestrator 不应该做什么

Orchestrator 不应该：

- 直接替代所有子 Agent 做专业任务。
- 让多个 Agent 无限自由聊天。
- 把所有历史消息原样塞给所有 Agent。
- 对所有任务都强行并行。
- 让 Code Agent 直接改主分支。
- 把运行状态只存到 message metadata。
- 在没有证据的情况下合成“看起来完成”的报告。

---

## 5. Orchestrator Run 生命周期

建议定义 12 个阶段。

```text
1. intake          接收用户消息
2. classify       意图识别
3. clarify        澄清需求
4. plan           生成计划
5. validate_plan  校验计划
6. confirm        用户确认或自动确认
7. prepare        创建 run、workspace tasks、child sessions、branches
8. execute        调度子任务
9. monitor        监听事件、更新 ledger
10. recover       失败降级和重规划
11. reconcile     冲突处理和产物对齐
12. synthesize    汇总并回写聊天流
```

### 5.1 intake：接收用户消息

输入：

- 当前 group session。
- 用户消息内容。
- 当前 workspace。
- 当前 agent roster。
- 可能的附件、引用消息、已选模型。

输出：

- `UserIntentContext`

```typescript
interface UserIntentContext {
  sessionId: string
  workspaceId: string
  userMessageId: string
  rawContent: string
  displayContent?: string
  attachments: Array<{
    id: string
    name: string
    mimeType: string
    artifactRef?: string
  }>
  mentionedAgents: string[]
  mentionedOrchestrator: boolean
  replyToMessageId?: string | null
}
```

### 5.2 classify：意图识别

不要只靠 `mentionsOrchestrator(content)`。建议分层：

```typescript
type IntentRoute =
  | 'direct_agent'
  | 'agent_handoff'
  | 'orchestrator_plan'
  | 'orchestrator_suggest'
  | 'smalltalk'
  | 'unsupported'
```

判断规则：

| 条件 | 路由 |
|---|---|
| 明确 `@orchestrator` | `orchestrator_plan` |
| 明确 `@某Agent` | `direct_agent` 或 `agent_handoff` |
| 涉及多个模块/文件/阶段 | `orchestrator_suggest` |
| 只是问答或单点修改 | `direct_agent` |
| 高风险或权限不足 | `unsupported` 或 `clarify` |

意图分类输出：

```typescript
interface IntentClassification {
  route: IntentRoute
  confidence: number
  taskKind:
    | 'qa'
    | 'research'
    | 'architecture'
    | 'code_change'
    | 'debugging'
    | 'review'
    | 'document'
    | 'mixed'
  complexity: 'low' | 'medium' | 'high'
  parallelizable: boolean
  riskLevel: 'low' | 'medium' | 'high'
  reasons: string[]
}
```

### 5.3 clarify：澄清需求

复杂任务不应直接开跑。触发澄清：

- 目标模糊。
- 用户没有指定项目范围。
- 可能写入代码。
- 需求涉及多个解释。
- 风险等级为 high。
- 缺少必要 Agent 或权限。

澄清问题要少，最多 3 个。优先选择题。

示例：

```json
{
  "questions": [
    {
      "id": "scope",
      "question": "这次修改只覆盖前端页面，还是也允许改后端接口？",
      "options": ["只改前端", "前后端都可以", "先分析后决定"]
    }
  ]
}
```

产品形态：

- 在群聊中生成“计划前确认卡”。
- 用户回答后再进入 plan。
- 比赛演示可默认跳过澄清，但设计上要有。

### 5.4 plan：生成计划

计划不应只是任务数组，应包含：

- goal
- assumptions
- constraints
- phases
- tasks
- dependencies
- agent assignments
- output contracts
- risk controls
- validation commands
- budget

推荐 schema：

```typescript
interface OrchestratorPlanV2 {
  schemaVersion: 2
  runId: string
  title: string
  goal: string
  taskKind: string
  assumptions: string[]
  constraints: string[]
  phases: OrchestratorPhase[]
  agents: ExecutionAgent[]
  tasks: OrchestratorTask[]
  budget: RunBudget
  approvalPolicy: ApprovalPolicy
}

interface OrchestratorPhase {
  id: string
  title: string
  purpose: string
  dependencies: string[]
  successCriteria: string[]
}

interface OrchestratorTask {
  id: string
  phaseId: string
  title: string
  description: string
  agentId: string
  dependencies: string[]
  taskType: 'read' | 'research' | 'design' | 'code' | 'test' | 'review' | 'synthesize'
  sandboxPolicy: 'read-only' | 'workspace-write' | 'danger-full-access'
  inputRefs: BlackboardRef[]
  outputContract: TaskOutputContract
  validation: TaskValidation
  timeoutMs: number
  maxRetries: number
  fallbackAgentIds: string[]
  parallelGroup?: string
}

interface TaskOutputContract {
  requiredBlackboardWrites: Array<{
    key: string
    schemaType: 'fact' | 'decision' | 'risk' | 'artifact_ref' | 'diff_summary' | 'test_result' | 'task_output'
  }>
  requiredArtifacts: Array<'diff' | 'file' | 'preview' | 'log' | 'review' | 'test_result'>
  allowedPaths: string[]
  acceptanceCriteria: string[]
}

interface TaskValidation {
  commands: string[]
  requiresReview: boolean
}
```

当前实现状态（2026-05-27）：

- `ExecutionTask` / `TaskLedger` 已保留 `outputContract` 与 `validation`，dispatch 会把 task card 中声明的契约贯通到运行计划。
- `Planner` 的 JSON schema 已提示模型输出 `outputContract.requiredBlackboardWrites`、`requiredArtifacts`、`allowedPaths`、`acceptanceCriteria` 与 `validation.commands`、`requiresReview`。
- `OrchestratorEngine` 在任务产出写入黑板后执行安全白名单内的 `validation.commands`；每条命令结果写入 typed Blackboard `test_result`，并通过 `/api/orchestrator-runs/:id/blackboard?schemaType=test_result` 查询。
- validation 失败会抛出任务错误，进入现有 retry / fallback / replan 路径；通过的结果会继续随最终 Synthesizer typed context 汇总。
- 非白名单命令不会进入 shell 执行，会被记录为 `skipped`，避免模型生成命令直接触发高风险操作。
- `OrchestratorEngine` 会校验 required artifacts 和 allowed paths；缺少 artifact 或产物路径越界会写 typed `risk`，并让任务失败进入现有恢复路径。
- 群聊计划卡会展示任务的 paths/artifacts/validation；Runs 详情会展示阶段级 contract/validation 数量。
- **Reviewer 自动审查**（2026-05-27 新增）：code 类型任务完成且 `requiresReview: true` 时，`OrchestratorEngine.injectAutoReviewTasks()` 自动注入 Reviewer 审查任务，审查 diff 质量和安全性，结果写入黑板。当前选择顺序为 `reviewed_by` 关系 > `roleType=reviewer` > review/test 字符串启发式。
- **Agent 角色关系第一阶段**（2026-05-27 新增）：Workspace 已新增 `workspace_agent_relations`，classic template 默认 seed Clarifier/Architect/Coder/Reviewer/Integrator 五人骨干团队；Planner 输入包含 `roleType`、`roleProfile` 和上下游关系摘要；计划任务包含 `agentSelection`，前端计划卡展示路由理由、reviewer 和 fallback。
- **Intent Router 显性化**（2026-05-27 新增）：`chatStore.ts` 新增 `assessIntentComplexity()` 启发式检测，群聊中无需 `@orchestrator` 即可自动路由复杂需求（多文件引用、多阶段关键词、架构意图等 6 种信号评分，≥3 分自动路由）。
- **Clarifier 需求澄清**（2026-05-27 新增）：Planner 的 JSON schema 扩展 `clarificationQuestions` 字段，LLM 在目标模糊时生成 1-3 个澄清问题（含选项）；前端计划卡片展示"需求澄清"区域，用户可点击选项回答。
- **Handoff 上下文裁剪**（2026-05-27 新增）：`agent-runner.ts` 的 `runAgentReply()` 在群聊场景下自动裁剪历史为 pinned + 最近 3 条 + 中间消息摘要，减少 token 消耗。
- 尚未完成：用户合并确认、专门 contract/validation 详情面板。

### 5.5 validate_plan：校验计划

LLM 生成计划后必须做程序化校验。

校验项：

- task id 唯一。
- dependency 都存在。
- DAG 无环。
- 每个 task 都绑定有效 Agent。
- 写入型任务必须有 workspacePath。
- 写入型任务必须有 sandboxPolicy。
- `danger-full-access` 必须需要用户确认。
- 每个 task 必须有 output contract。
- 并发任务不能写同一 allowedPath，除非标记为可能冲突。
- 预算不超过上限。

校验失败时：

- 自动修复简单问题，例如孤立 dependency。
- 复杂问题回退到 fallback plan。
- 高风险问题进入 clarify。

### 5.6 confirm：确认计划

建议分两级确认：

#### 低风险自动确认

满足以下条件可自动开始：

- read-only。
- 没有外部高风险工具。
- 没有写文件。
- 并发数 <= 3。

#### 高风险用户确认

这些必须确认：

- 写文件。
- 切 Git 分支。
- 执行命令。
- 调用部署工具。
- `danger-full-access`。
- 合并冲突结果。

群聊中展示：

```text
Orchestrator 计划执行 5 个任务：
- 2 个只读分析任务
- 1 个代码修改任务
- 1 个测试任务
- 1 个审查任务

需要确认：
- 允许 Coder 在独立分支修改 apps/web/src/**
- 允许执行 bun --filter @agenthub/web typecheck
```

### 5.7 prepare：准备运行环境

准备动作：

1. 创建 `orchestrator_runs`。
2. 创建 `workspace_tasks`。
3. 创建 child sessions。
4. 初始化 Blackboard namespace。
5. 写入 `run.started`、`plan.created` 事件。
6. 对写入型任务准备 Git branch。
7. 为每个 task 生成 `TaskExecutionContext`。

`TaskExecutionContext`：

```typescript
interface TaskExecutionContext {
  runId: string
  taskId: string
  phaseId: string
  workspaceId: string
  groupSessionId: string
  childSessionId: string
  agent: ExecutionAgent
  goal: string
  task: OrchestratorTask
  blackboardNamespace: string
  inputSnapshot: BlackboardEntry[]
  allowedPaths: string[]
  branch?: {
    baseBranch: string
    branchName: string
  }
  signal: AbortSignal
}
```

### 5.8 execute：调度子任务

调度器应支持：

- DAG 依赖。
- phase gate。
- concurrency。
- per-agent busy lock。
- per-runtime concurrency。
- timeout。
- retry。
- cancellation。

建议扩展现有 `TaskScheduler`：

```typescript
interface SchedulerPolicy {
  maxGlobalConcurrency: number
  maxConcurrencyByRuntime: Record<string, number>
  maxConcurrencyByAgent: number
  defaultTaskTimeoutMs: number
  acquireTimeoutMs: number
  stopOnCriticalFailure: boolean
}
```

推荐默认：

```json
{
  "maxGlobalConcurrency": 3,
  "maxConcurrencyByRuntime": {
    "llm": 3,
    "code-agent": 1
  },
  "maxConcurrencyByAgent": 1,
  "defaultTaskTimeoutMs": 300000,
  "acquireTimeoutMs": 60000,
  "stopOnCriticalFailure": false
}
```

原因：

- LLM / read-only 任务可以并行。
- Code Agent 写入任务默认不要多个同时改同一工作区。
- 未来可以按不同 branch 放宽。

### 5.9 monitor：事件和进度账本

每个任务状态变化都要写 run event。

事件类型：

```typescript
type OrchestratorRunEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'plan.created'; runId: string; plan: PlanSummary }
  | { type: 'plan.validated'; runId: string; warnings: string[] }
  | { type: 'approval.requested'; runId: string; items: ApprovalItem[] }
  | { type: 'approval.granted'; runId: string }
  | { type: 'phase.started'; runId: string; phaseId: string }
  | { type: 'task.queued'; runId: string; taskId: string }
  | { type: 'task.started'; runId: string; taskId: string; agentId: string }
  | { type: 'task.stream'; runId: string; taskId: string; delta: string }
  | { type: 'blackboard.written'; runId: string; taskId: string; key: string; summary: string }
  | { type: 'artifact.created'; runId: string; taskId: string; artifactId: string }
  | { type: 'task.completed'; runId: string; taskId: string }
  | { type: 'task.failed'; runId: string; taskId: string; error: string }
  | { type: 'task.retrying'; runId: string; taskId: string; attempt: number; delayMs: number }
  | { type: 'task.reassigned'; runId: string; taskId: string; fromAgentId: string; toAgentId: string }
  | { type: 'run.replanned'; runId: string; reason: string; changedTaskIds: string[] }
  | { type: 'conflict.detected'; runId: string; filePath: string; agents: string[] }
  | { type: 'conflict.resolved'; runId: string; filePath: string; resolution: string }
  | { type: 'run.synthesizing'; runId: string }
  | { type: 'run.completed'; runId: string }
  | { type: 'run.failed'; runId: string; error: string }
```

Progress Ledger 每次事件后增量更新：

```typescript
interface ProgressLedger {
  runId: string
  currentPhaseId?: string
  completedTaskIds: string[]
  runningTaskIds: string[]
  failedTaskIds: string[]
  blockedTaskIds: string[]
  latestFacts: string[]
  risks: string[]
  openQuestions: string[]
  replanHistory: Array<{
    at: string
    reason: string
    strategy: string
    affectedTaskIds: string[]
  }>
  lastUpdatedAt: string
}
```

当前实现状态（2026-05-27）：

- `TaskLedger` / `ProgressLedger` 已作为第一版运行时账本落地，暂存于 `orchestrator_runs.plan.taskLedger` 与 `orchestrator_runs.plan.progressLedger`。
- `initializeRunLedger(plan)` 会把旧版平铺任务自动补齐为 `phases + tasks + taskLedger + progressLedger`，因此历史 plan card 和新 plan 均可兼容。
- `emitRunEvent` 在写入 `orchestrator_run_events` 后，会同步增量更新 Progress Ledger：任务状态、黑板 key、artifact id、retry 记录、Agent 替换、replan 历史和冲突记录都会进入账本。
- `Planner` 的 JSON schema 已扩展为 `phases + tasks + clarificationQuestions`，并保留无 phase 输出的自动归一化逻辑。
- Orchestrator Runs 页面新增 Progress Ledger 阶段进度视图，Run Timeline 继续作为细粒度事件视图。
- typed Blackboard 第一阶段已落地：`Blackboard.write` 校验带 `schemaType` 的条目，Orchestrator 写入 `task_output`、`decision`、`diff_summary`、`artifact_ref`，Runs 页面可查看结构化证据。
- 尚未完成：pause/resume/cancel、任务级 retry API、ledger 原子更新锁、typed schema 迁移到 shared contract。

### 5.10 recover：失败降级与重规划

失败处理不能只有 retry。建议按失败类型决策。

| 失败类型 | 例子 | 策略 |
|---|---|---|
| transient_error | timeout、rate limit、网络中断 | 指数退避重试 |
| schema_mismatch | Agent 输出不符合 contract | 要求同 Agent 修正一次，失败后换 Agent |
| capability_mismatch | Agent 不会工具或权限不足 | Agent 替换 |
| dependency_missing | 上游产物缺失 | 补跑上游或局部重规划 |
| code_conflict | 多 Agent 修改冲突 | ConflictResolver |
| test_failed | 验证命令失败 | 派给 Coder 修复，再 Reviewer |
| unsafe_action | 请求越权或危险命令 | escalate_to_user |
| unrecoverable | 重试无效 | 标记失败并汇报 |

恢复策略：

```typescript
type RecoveryStrategy =
  | 'retry_with_backoff'
  | 'repair_output'
  | 'agent_substitution'
  | 'local_replan'
  | 'task_split'
  | 'fallback_to_orchestrator'
  | 'escalate_to_user'
  | 'fail_run'
```

建议改进现有 `ReplanningEngine`：

- `analyze` 不只看 error message，也看 task result、blackboard、artifact、exit code。
- `schema_mismatch` 先做 `repair_output`。
- `test_failed` 单独分类。
- `agent_substitution` 使用能力评分，而不是只看 runtimeType 和 capabilityTags。
- 所有策略写 run event 和 Progress Ledger。

### 5.11 reconcile：代码冲突处理

代码冲突处理分三层。

#### 第一层：计划阶段预防

Planner 尽量避免并发写同一目录：

- frontend task 写 `apps/web/**`
- server task 写 `apps/server/**`
- db task 写 `packages/db/**`
- shared schema task 写 `packages/shared/**`

如果多个任务可能改同一文件，设置依赖，不并发。

#### 第二层：执行后检测

每个 Code Agent 必须输出：

```typescript
interface CodeArtifactSummary {
  branchName: string
  baseBranch: string
  changedFiles: Array<{
    path: string
    status: 'created' | 'modified' | 'deleted' | 'renamed'
    additions: number
    deletions: number
  }>
  diffArtifactId: string
  validationResults: TestResult[]
  riskNotes: string[]
}
```

ConflictResolver 输入不应只靠 `filePath + diff`，还应包含：

- branch。
- base commit。
- changed ranges。
- full file after change。
- validation result。
- task intent。

#### 第三层：合并策略

合并顺序：

1. 不同文件：自动通过。
2. 同文件不同行：尝试结构化 patch merge。
3. 同文件同区域：
   - 如果是 import / export / schema 字段，尝试 AST-aware merge。
   - 否则 LLM 3-way merge。
4. LLM merge 不确定：needs-human。

冲突报告：

```typescript
interface ConflictReportV2 {
  filePath: string
  severity: 'low' | 'medium' | 'high'
  agents: Array<{ agentId: string; taskId: string; branchName: string }>
  reason: string
  resolution: 'auto-merged' | 'llm-resolved' | 'needs-human' | 'rejected'
  mergedContent?: string
  userDecision?: 'accept' | 'reject' | 'edit'
  notes: string
}
```

用户看到的不应是大段冲突文本，而是：

- 哪些 Agent 改了同一文件。
- 冲突原因。
- 系统建议。
- 可接受 / 拒绝 / 查看 diff。

### 5.12 synthesize：最终汇总

Synthesizer 不应只总结成功任务输出，而应生成“交付报告”。

输入：

- Plan。
- Task results。
- Blackboard typed entries。
- Artifact list。
- Conflict reports。
- Validation results。
- Replan history。

输出结构：

```markdown
## Orchestrator 汇总

### 1. 任务目标

### 2. 执行结果
- 完成：
- 部分完成：
- 未完成：

### 3. Agent 贡献
- Architect：
- Coder：
- Reviewer：

### 4. 产物
- Diff：
- 文件：
- 预览：
- 测试：

### 5. 验证情况

### 6. 冲突与处理

### 7. 风险和待确认事项

### 8. 下一步建议
```

如果任务失败，也要有失败报告：

- 哪一步失败。
- 已保留哪些产物。
- 系统尝试了哪些恢复。
- 用户可以怎么继续。

---

## 6. Agent 分派设计

### 6.1 Agent Roster

Orchestrator 调度时应看到一个 agent roster：

```typescript
interface AgentRosterItem {
  id: string
  key: string
  name: string
  role: string
  runtimeType: 'llm' | 'code-agent'
  codeAgentType?: string
  capabilityTags: string[]
  toolPermissions: string[]
  sandboxPolicy: string
  modelId?: string | null
  availability: 'idle' | 'busy' | 'disabled' | 'misconfigured'
  recentStats: {
    successRate: number
    avgDurationMs: number
    recentFailureReasons: string[]
  }
}
```

### 6.2 任务到 Agent 的匹配

匹配评分：

```typescript
score =
  capabilityFit * 0.35 +
  toolFit * 0.20 +
  sandboxFit * 0.15 +
  availability * 0.10 +
  reliability * 0.10 +
  costLatency * 0.10
```

示例：

| 任务 | 优先 Agent |
|---|---|
| 代码库扫描 | code-agent with read-only |
| 架构设计 | architect LLM |
| 代码修改 | code-agent with workspace-write |
| 测试修复 | code-agent |
| diff 审查 | reviewer LLM 或 code-agent read-only |
| 资料调研 | researcher with search tools |

### 6.3 临时子 Agent

复杂 read-only 阶段可以动态创建临时子 Agent：

```typescript
interface EphemeralAgentSpec {
  key: string
  name: string
  purpose: string
  baseRuntimeType: 'llm' | 'code-agent'
  allowedTools: string[]
  contextSlice: string
  outputContract: TaskOutputContract
  expiresAtRunEnd: true
}
```

限制：

- 默认只读。
- 不出现在长期联系人列表。
- run 结束后归档。
- 只能写 Blackboard，不直接写代码。

---

## 7. Blackboard 详细设计

### 7.1 分区

```text
workspace/{workspaceId}/run/{runId}/ledger/task
workspace/{workspaceId}/run/{runId}/ledger/progress
workspace/{workspaceId}/run/{runId}/facts/*
workspace/{workspaceId}/run/{runId}/decisions/*
workspace/{workspaceId}/run/{runId}/risks/*
workspace/{workspaceId}/run/{runId}/questions/*
workspace/{workspaceId}/run/{runId}/artifacts/*
workspace/{workspaceId}/run/{runId}/diffs/*
workspace/{workspaceId}/run/{runId}/tests/*
```

### 7.2 Typed entries

```typescript
interface BaseBlackboardValue {
  schemaType: string
  summary: string
  confidence: number
  evidenceRefs: string[]
  createdByAgentId: string
  taskId: string
}

interface FactValue extends BaseBlackboardValue {
  schemaType: 'fact'
  fact: string
  source: 'file' | 'tool' | 'agent' | 'user'
}

interface DecisionValue extends BaseBlackboardValue {
  schemaType: 'decision'
  decision: string
  rationale: string
  alternatives: string[]
}

interface RiskValue extends BaseBlackboardValue {
  schemaType: 'risk'
  risk: string
  severity: 'low' | 'medium' | 'high'
  mitigation?: string
}

interface ArtifactRefValue extends BaseBlackboardValue {
  schemaType: 'artifact_ref'
  artifactId: string
  artifactKind: string
}

interface DiffSummaryValue extends BaseBlackboardValue {
  schemaType: 'diff_summary'
  changedFiles: string[]
  branchName: string
  validationStatus: 'not_run' | 'passed' | 'failed'
}
```

### 7.3 写入规则

- 子 Agent 不能覆盖别人的 entry，只能写新版本。
- 关键决策必须由 Orchestrator 或 Reviewer 写入。
- `confidence < 0.6` 的事实不能作为最终结论，只能作为线索。
- Synthesizer 必须优先使用 typed entries，而不是 raw output。

当前实现状态（2026-05-27）：

- 服务端新增 `blackboard-schemas.ts`，第一版 typed value 覆盖 `fact`、`decision`、`risk`、`artifact_ref`、`diff_summary`、`test_result`、`task_output`。
- `Blackboard.write` 会对带 `schemaType` 的 value 做 Zod 校验并存储规范化 JSON；不带 `schemaType` 的历史自由 JSON 继续兼容。
- `Blackboard.query` 支持按 `schemaType` 过滤；`GET /api/orchestrator-runs/:id/blackboard` 使用 run ownership 鉴权后返回 `{ items }`。
- Orchestrator task completed 路径会写 typed `task_output`，并从 task summary 派生 `decision`、`diff_summary`、`artifact_ref`。
- `Synthesizer.synthesize` 已接收 typed blackboard entries 并注入汇总 prompt；Runs 页面新增”结构化黑板”证据面板，展示 schema 类型、summary、task/agent、版本和 confidence。
- Reviewer 自动审查结果也会写入黑板 `task_output`，与普通任务产出一致。

---

## 8. 安全与 Guardrails

### 8.1 输入 Guardrails

检查：

- 用户是否要求越权读写。
- 是否涉及删除大量文件。
- 是否要求泄露密钥。
- 是否要求绕过沙箱。
- 是否超出 workspace。

高风险动作：

- `danger-full-access`
- 删除文件
- 修改 `.env`
- 修改 `.git`
- 推送远程
- 部署
- 安装依赖

处理：

- 阻止。
- 降级。
- 请求用户确认。

### 8.2 输出 Guardrails

检查：

- Agent 输出是否满足 output contract。
- 是否包含敏感信息。
- 是否声称完成但没有 artifact / validation。
- 是否给出无法验证的结论。

### 8.3 Tool Guardrails

工具调用前判断：

```typescript
interface ToolCallPolicy {
  toolName: string
  riskLevel: 'low' | 'medium' | 'high'
  requiresApproval: boolean
  allowedSandboxPolicies: string[]
  allowedPathPatterns?: string[]
}
```

---

## 9. 数据库与 API 建议

### 9.1 新增表：orchestrator_run_events

```typescript
orchestrator_run_events
- id
- run_id
- workspace_id
- group_session_id
- task_id nullable
- agent_id nullable
- type
- payload json
- severity enum('debug','info','warning','error')
- created_at
```

用途：

- 前端时间线。
- 断点恢复。
- 调试。
- 比赛演示。

### 9.2 扩展 orchestrator_runs

建议字段：

- `task_ledger` json
- `progress_ledger` json
- `budget` json
- `approval_state` json
- `started_at`
- `completed_at`
- `cancelled_at`

当前也可以先复用 `plan` 字段承载 V2 schema，但长期建议拆开。

### 9.3 扩展 workspace_tasks

建议字段：

- `phase_id`
- `task_type`
- `output_contract`
- `validation`
- `allowed_paths`
- `branch_name`
- `base_commit`
- `priority`
- `blocked_reason`

### 9.4 API

```text
POST /api/messages/:sessionId/orchestrator-plan
POST /api/messages/:sessionId/orchestrator-plan/:messageId/dispatch
GET  /api/orchestrator-runs/:runId
GET  /api/orchestrator-runs/:runId/events
POST /api/orchestrator-runs/:runId/cancel
POST /api/orchestrator-runs/:runId/pause
POST /api/orchestrator-runs/:runId/resume
POST /api/orchestrator-runs/:runId/approve
POST /api/orchestrator-runs/:runId/retry-task/:taskId
POST /api/orchestrator-runs/:runId/replan
```

---

## 10. 前端交互设计

### 10.1 群聊任务卡

任务卡结构：

```text
标题：Orchestrator 计划：xxx
状态：draft / waiting_approval / running / replanning / synthesizing / completed / failed

目标
约束
阶段进度
  - 分析 2/2
  - 实现 1/2
  - 验证 0/1
任务列表
  - [running] Architect 分析代码结构
  - [done] Researcher 扫描相关文档
  - [pending] Coder 实现修改
产物
  - diff
  - review
  - test result
风险
  - 需要用户确认合并
操作
  - 开始执行
  - 暂停
  - 取消
  - 查看时间线
```

### 10.2 Run Timeline

Orchestrator Runs 页面以事件流展示：

```text
09:20 run.started
09:21 plan.created
09:21 approval.granted
09:22 phase.started analysis
09:22 task.started scan-web by Researcher
09:22 task.started scan-server by Architect
09:24 blackboard.written facts/server-routes
09:25 task.completed scan-server
09:26 phase.started implementation
09:27 artifact.created diff
09:28 conflict.detected apps/web/src/App.tsx
09:29 conflict.resolved llm-resolved
09:30 run.synthesizing
09:31 run.completed
```

### 10.3 Agent 状态

群聊侧边栏显示：

- idle
- planning
- running task title
- waiting approval
- failed
- completed

临时 Agent 显示在当前 run 内，不进入全局联系人。

---

## 11. 失败降级细节

### 11.1 Retry

重试策略：

- transient error：最多 3 次，指数退避 + jitter。
- timeout：重试一次并增加 timeout。
- schema mismatch：先让同 Agent 修复输出一次。
- code test failed：派给同 Coder 修复一次，再 Reviewer。

### 11.2 Agent substitution

替换条件：

- Agent 未配置。
- CLI 不可用。
- 权限不足。
- 多次 schema mismatch。
- 最近失败率过高。

替换顺序：

1. `task.fallbackAgentIds`
2. 同 capabilityTags Agent
3. 同 runtimeType Agent
4. Orchestrator 自己降级处理
5. escalate_to_user

### 11.3 Local replan

只影响失败任务及下游任务。

例子：

- Coder 发现需要先改 shared schema，则插入 `update-shared-schema` 任务，并让原任务依赖它。
- Reviewer 发现测试缺失，则插入 `add-tests` 任务。

### 11.4 Global replan

仅在以下情况触发：

- 原计划目标理解错误。
- 关键假设被推翻。
- 多个 phase 连续失败。
- 用户中途改变目标。

全局重规划必须在聊天中提示用户。

---

## 12. 代码冲突处理详细流程

```text
Task completed
  -> collect diff
  -> write diff_summary to blackboard
  -> run validation.commands
  -> write test_result to blackboard
  -> after all write tasks completed
  -> group by file path
  -> no overlap: auto accept
  -> overlap:
      -> try structured merge
      -> run validation
      -> if validation fails, ask Reviewer
      -> if still unclear, needs-human
```

### 12.1 冲突等级

| 等级 | 说明 | 处理 |
|---|---|---|
| low | 不同文件或同文件不同区域 | 自动合并 |
| medium | 同文件相近区域，但语义可兼容 | LLM merge + Reviewer |
| high | 同一逻辑冲突、删除/重写同一函数 | 用户确认 |

### 12.2 Reviewer 在冲突中的角色

Reviewer 不只是最终审查，还应参与冲突判断：

- 判断两个修改是否都必要。
- 判断合并后是否破坏接口。
- 建议保留哪一版。
- 要求 Coder 重新修改。

---

## 13. 结果汇报设计

### 13.1 运行中汇报

不要每个 token 都刷群聊。建议：

- task started：短提示。
- task completed：一条简短产物摘要。
- artifact created：卡片。
- failure / replan：明确提示。

### 13.2 最终汇报

最终报告必须回答：

- 做了什么？
- 谁做的？
- 产出了什么？
- 验证了吗？
- 有冲突吗？
- 失败了什么？
- 用户下一步怎么做？

### 13.3 不确定性表达

如果没有测试，不允许说“已验证通过”。只能说：

```text
未运行验证命令，当前结果仅基于代码审查。
```

如果部分任务失败：

```text
本轮部分完成：分析和设计已完成，代码实现失败，失败原因是 Codex CLI 未配置。
```

---

## 14. MVP 落地优先级

### P0：让现有 Orchestrator 可解释

1. 定义 `OrchestratorPlanV2`。
2. 任务卡显示 phase + task。
3. 新增 run events，至少覆盖 started、task started/completed/failed、artifact created、run completed。
4. Synthesizer 改成固定交付报告结构。

### P1：让 Orchestrator 可恢复

1. Progress Ledger。
2. 失败策略事件化。
3. retry / agent substitution 在 UI 可见。
4. 任务级重试 API。

### P2：让代码协作闭环

1. Task contract。
2. allowedPaths。
3. validation commands。
4. diff summary。
5. Reviewer 审查卡。
6. conflict report card。

### P3：小规模动态 Swarm

1. 只读临时 Agent。
2. context sharding。
3. 合并多路事实。
4. run 内展示临时 Agent。

### P4：协议化扩展

1. MCP tools/resources/roots 作为 Code Agent 能力层。
2. A2A remote endpoint 作为协议层配置。
3. Agent Card。

---

## 15. 推荐 Demo 设计

### Demo 场景

用户在 Agent Group 输入：

```text
@orchestrator 帮我给 Orchestrator Runs 页面增加运行时间线视图。
要求先分析现有前后端代码，再实现前端展示，最后让 Reviewer 审查 diff。
```

### 预期计划

Phase 1：分析

- Architect：扫描 `apps/server/src/routes/orchestrator-runs.ts` 和相关 API。
- Frontend Reader：扫描 `apps/web/src/pages/OrchestratorRunsPage.tsx`。

Phase 2：设计

- Architect：写 timeline 数据结构和 UI 方案。

Phase 3：实现

- Coder：修改前端页面，接入 run events。

Phase 4：验证

- QA：运行 web typecheck。
- Reviewer：审查 diff。

Phase 5：汇总

- Orchestrator：汇报文件变更、测试结果、风险。

### 展示亮点

- 群聊触发。
- Orchestrator 生成阶段化任务卡。
- 多 Agent 并行分析。
- Coder 产出 diff。
- Reviewer 审查。
- 失败/测试/冲突有明确状态。
- 最终报告内联在聊天流。

---

## 16. 与现有代码的映射

| 设计对象 | 当前代码 | 建议 |
|---|---|---|
| Plan | `ExecutionPlan` | 升级为 `OrchestratorPlanV2`，保留兼容转换 |
| Task | `ExecutionTask` / `workspace_tasks` | 增加 phase、taskType、outputContract、validation |
| Scheduler | `TaskScheduler` | 增加 runtime/agent 并发策略、事件回调 |
| Replan | `ReplanningEngine` | 增加 output repair、test_failed、ledger 写入 |
| Blackboard | `Blackboard` | 增加 typed schema |
| Trace | `ExecutionTracer` | 扩展为 run event 或新增表 |
| Conflict | `ConflictResolver` | 增加 changed ranges、branch/base commit、severity |
| Summary | `Synthesizer` | 固定交付报告结构，读取 typed blackboard |
| UI | `chatStore` task:update | 改为消费 `run:event`，task card phase 化 |

---

## 17. 实施顺序建议

第一步不要先改复杂 AI prompt，而是先把运行状态打通：

1. 新增 run event 类型和存储。
2. OrchestratorEngine 在关键节点 emit event。
3. 前端 task card / OrchestratorRunsPage 展示 timeline。
4. Plan schema 增加 phase，但兼容旧 tasks。
5. Synthesizer 改固定结构。
6. 再逐步强化 Planner prompt、Blackboard schema、失败恢复和冲突处理。

这样做的原因是：可观测性一旦打通，后续每个 Agent 协作问题都能被看见；否则 Planner 再复杂，失败时也难以解释。

---

## 18. 参考资料

- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Kimi: K2.6 Agent Swarm](https://www.kimi.com/help/agent/agent-swarm)
- [AutoGen: Magentic-One](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html)
- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)
- [LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)
- [OpenAI Agents SDK: Agents](https://openai.github.io/openai-agents-python/agents/)
- [OpenAI Agents SDK: Guardrails](https://openai.github.io/openai-agents-python/guardrails/)
- [OpenAI Agents SDK: Tracing](https://openai.github.io/openai-agents-python/tracing/)
- [Model Context Protocol: client concepts](https://modelcontextprotocol.io/docs/learn/client-concepts)
- [Google ADK: A2A intro](https://adk.dev/a2a/intro/)

