# AgentHub 多 Agent 协作设计调研与优化方案

> 日期：2026-05-27  
> 目的：梳理业内多 Agent 协作模式，结合 AgentHub 当前实现，给出可落地的架构优化方案与比赛演示路线。
> 状态：历史调研资料，部分 runtime/协议边界、固定团队和 Git 隔离描述已调整。当前权威路径请以 `docs/当前多Agent协作架构.md` 和 `docs/多Agent协作分层架构与业内对比.md` 为准。

---

## 1. 结论摘要

AgentHub 当前已经具备多 Agent 平台的核心骨架：IM 会话、Workspace、Agent Group、Runtime 统一层、Orchestrator、Task DAG、Blackboard、Execution Logs、Code Agent 执行适配。当前默认执行路径已经收敛为“项目根 + `.agenthub/workdirs` + `.agenthub/handoff`”，不再把 Git 分支隔离作为默认事实。下一步不应简单堆更多 Agent，而应把协作系统从“静态 DAG + 任务分发”升级为“可解释、可暂停、可重规划、可审计的协作运行时”。

核心建议：

1. **保留 IM 群聊作为产品外壳**：这是 AgentHub 的差异化。用户不应面对复杂图编辑器，而是在聊天里看到 Agent、任务、产物、决策过程。
2. **采用三种协作拓扑并存**：简单任务走单 Agent，领域切换走 handoff，复杂任务走 Orchestrator-worker。不要所有任务都强行多 Agent。
3. **把 Orchestrator 从一次性 Planner 升级为 Run Manager**：维护 Task Ledger、Progress Ledger、Run Events、Budget、Checkpoint，并支持执行中重规划。
4. **Blackboard 继续作为 Agent 间共享状态，但要 Schema 化**：Agent 不直接互相拼接长文本，而是读写结构化产物、事实、决策、风险和文件变更。
5. **Code Agent 协作必须以 Git 和 Artifact 为核心**：多 Agent 写代码的关键不是聊天，而是分支隔离、diff 提取、测试验证、冲突解决和人工确认。
6. **Swarm 只能作为高阶能力，先小规模落地**：Kimi 式大规模 Agent Swarm 对搜索、资料收集、批量生成很有价值，但对代码任务并不总是合适。AgentHub 应先实现 3-8 个并行子任务的“可控小集群”。
7. **演示重点放在“透明协作闭环”**：创建 Workspace -> `@orchestrator` 规划 -> 多 Agent 并行执行 -> 进度可视化 -> 产物卡片 -> Reviewer 审查 -> 汇总报告。

---

## 2. 当前 AgentHub 的基础与缺口

### 2.1 已有基础

从现有代码和文档看，AgentHub 已有这些基础能力：

- IM 式 Direct / Group 会话。
- Workspace、workspace_agents、workspace_tasks。
- `@orchestrator` 触发任务卡与 dispatch。
- `AgentRuntime` 统一接口，当前只把 `llm` 和 `code-agent` 作为 runtime 身份；MCP/Skills/Rules 是 Code Agent 能力层。
- Orchestrator 模块：Planner、TaskGraph、TaskScheduler、Synthesizer、ConflictResolver、ReplanningEngine。
- Blackboard 与 execution_logs 表。
- Code Agent adapter：Codex、Claude Code、OpenCode、Gemini。
- 工作目录隔离：当前默认使用项目根 + `.agenthub/workdirs` + `.agenthub/handoff`，Git 分支隔离不再作为默认路径。
- 前端已开始消费 `task:update` 和 `blackboard:update`。

这说明项目不是从 0 开始，重点应是“架构收敛”和“体验打磨”。

### 2.2 主要缺口

当前缺口集中在协作语义，而不是基础 CRUD：

| 缺口 | 表现 | 优先级 |
|---|---|---|
| Orchestrator 状态不够产品化 | 有 DAG 和 scheduler，但用户看到的运行过程还不够清晰 | 高 |
| Task Ledger / Progress Ledger 不够显式 | DB 有 workspace_tasks，但缺少面向运行管理的事件流与阶段状态 | 高 |
| Blackboard Schema 不够强 | 容易变成“任意 JSON 仓库”，后续合成和审计会困难 | 高 |
| Agent 能力匹配较粗 | 现在更多依赖 profile 字段，缺少可评分的能力/工具/成本/可靠性选择 | 中 |
| Code Agent 产物闭环待加强 | diff、测试、冲突、人工确认需要形成稳定流程 | 高 |
| 失败降级还不够闭环 | ReplanningEngine 已存在，但与 UI、DB、重试策略的用户可见状态要加强 | 中 |
| 评估体系不足 | 多 Agent 是否真的优于单 Agent，需要任务级指标证明 | 中 |

---

## 3. 业内优秀设计与可借鉴点

### 3.1 Anthropic：Orchestrator-worker 适合“广度优先”任务

Anthropic 的多 Agent Research 系统采用 lead agent + parallel subagents 架构：主 Agent 分析问题、制定策略，并派生多个子 Agent 并行搜索不同方向，再由主 Agent 合成答案。Anthropic 的经验很重要：多 Agent 在“需要并行探索多个方向、信息超过单上下文窗口、工具调用很多”的任务上收益明显，但 token 成本也很高；他们也明确指出多数代码任务并不总是高度可并行。

对 AgentHub 的启发：

- `@orchestrator` 不应默认接管所有问题。只有复杂、宽搜索、跨文件、跨角色任务才进入多 Agent。
- Planner 需要先做 **parallelizability assessment**：任务是否真的能拆并行？如果不能，走单 Agent 或 handoff。
- 多 Agent 价值要用“更高正确率 / 更短墙钟时间 / 更好审查质量”证明，而不是只展示 Agent 数量。

参考：[Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

### 3.2 Kimi Agent Swarm：水平扩展与实时可视化

Kimi Help Center 对 K2.6 Agent Swarm 的描述是：主 Agent 可协调最高 300 个并行子 Agent，执行超过 4000 次工具调用，适合大规模发现、资料收集、批量输出和长文档生成。它强调“水平扩展”，不是预定义固定角色，也不是手写 workflow。

对 AgentHub 的启发：

- AgentHub 可以借鉴“动态子 Agent”思想，但不要一开始追求 300 个。比赛和本地运行场景更适合 **小规模动态 swarm**：3-8 个 ephemeral workers。
- Swarm 最适合这些 AgentHub 场景：
  - 资料调研：多个 Researcher 分别查竞品、架构、API、风险。
  - 代码库理解：多个 Reader 分别扫描前端、后端、数据库、测试。
  - 批量生成：多个 Worker 分别生成页面、测试、文档、示例数据。
- Swarm 的产品亮点不是“后台跑很多模型”，而是用户能看到任务列表创建、子 Agent 生成、并行执行、产物归档。

参考：[Kimi Help Center: K2.6 Agent Swarm](https://www.kimi.com/help/agent/agent-swarm)

### 3.3 Magentic-One：Task Ledger + Progress Ledger 是核心

AutoGen / Magentic-One 的关键不是角色名字，而是 Orchestrator 的双账本：

- **Task Ledger**：记录总体任务、计划、事实、假设、待完成步骤。
- **Progress Ledger**：每一步反思进度，判断是否完成、是否卡住、是否需要换计划。

它不是一次性生成完整 DAG 后盲跑，而是在执行中持续检查和重规划。

对 AgentHub 的启发：

- 当前 `workspace_tasks` 可以继续作为任务表，但还需要 `run_events` 或更强的 execution log，把每次计划、指派、状态变化、重试、黑板写入、产物生成都记录成事件。
- Orchestrator 每一轮都应能回答：
  - 当前目标是什么？
  - 已知事实是什么？
  - 哪些任务完成了？
  - 哪些任务阻塞？
  - 是否需要重规划？
  - 下一步最小动作是什么？

参考：[AutoGen Magentic-One architecture](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html)

### 3.4 LangGraph：长运行、状态、可恢复比“聊天”更关键

LangGraph 的定位是低层级 agent orchestration runtime，强调 long-running、stateful workflows、streaming、human-in-the-loop、debugging 和 deployment。对 AgentHub 来说，不一定要引入 LangGraph，但它的设计方向值得吸收：把多 Agent 看成有状态运行图，而不是一次 request-response。

对 AgentHub 的启发：

- 每个 Orchestrator run 应有 durable state，而不是只靠内存 Map。
- Run 应支持暂停、恢复、取消、重试。
- UI 应能展示状态图和事件流。
- Scheduler 应支持 per-node timeout、retry、error handler。

参考：[LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)、[LangGraph fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance)

### 3.5 OpenAI Agents SDK / LangChain Handoffs：不是所有协作都要中心调度

OpenAI Agents SDK 明确区分两类常见模式：

- **Manager pattern**：中心 manager 把专业 sub-agent 当工具调用，manager 保持控制权。
- **Handoff pattern**：一个 Agent 把控制权交给另一个专业 Agent，由后者继续直接和用户交互。

LangChain 的 handoff 文档进一步强调：handoff 需要明确的 active_agent 状态和上下文裁剪，不能把所有历史都塞给下游 Agent。

对 AgentHub 的启发：

- 群聊里 `@Agent` 更像 handoff：用户指定下一个 Agent 回复。
- `@orchestrator` 更像 manager：Orchestrator 控制任务分解和合成。
- AgentHub 应支持 `handoff` 消息类型：
  - `fromAgentId`
  - `toAgentId`
  - `reason`
  - `contextSummary`
  - `handoffArtifacts`
- handoff 不应传完整聊天历史，而应传”用户目标 + 当前结论 + 相关 artifact refs”。

**实施状态**（2026-05-27）：已实现。`agent-runner.ts` 的 `runAgentReply()` 新增群聊上下文裁剪逻辑：`checkIsGroupSession()` 检测群聊会话，`trimHistoryForHandoff()` 将历史裁剪为 pinned + 最近 3 条 + 中间消息摘要（发送者 + Agent 名 + 前 100 字符预览），摘要消息标记 `{ contextTrimmed: true }`。

参考：[OpenAI Agents SDK: multi-agent design patterns](https://openai.github.io/openai-agents-python/agents/)、[LangChain handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)

### 3.6 CrewAI：Flow 管控制，Crew 管自治

CrewAI 把生产级多 Agent 分成两层：

- Flow：结构化、事件驱动、管理状态和控制流。
- Crew：在某个复杂步骤里，由一组角色化 Agent 自治协作。

这对 AgentHub 非常实用。我们可以把 Orchestrator Run 看作 Flow，把某个阶段内的多 Agent 执行看作 Crew。

对 AgentHub 的启发：

- 顶层流程必须可控：阶段、状态、预算、暂停点、审批点由系统管理。
- 阶段内部可以适度自治：比如“研究竞品”阶段派 3 个 Researcher 并行探索。
- UI 上应区分“阶段”和“任务”：用户先看阶段，再展开子任务。

参考：[CrewAI introduction](https://docs.crewai.com/en/introduction)、[CrewAI Flows](https://crewai.com/crewai-flows)

### 3.7 MCP 与 A2A：工具协议和 Agent 协议要分清

MCP 适合让 Agent 安全访问工具、资源、提示词、工作区 roots。MCP 文档强调 tools 是 model-controlled，但应用应显示工具暴露情况、工具调用提示和人工确认。MCP roots 对 AgentHub 的 workspace 边界很关键。

A2A 适合远程 Agent 或跨团队 Agent 服务通信。Google ADK 文档也明确说：如果只是同进程内部模块或高频共享状态，不要用 A2A，直接用本地 sub-agent 更简单。

对 AgentHub 的启发：

- **MCP 用于工具层**：文件、搜索、数据库、浏览器、Office、部署、设计资源。
- **A2A 用于远程 Agent 层**：未来接入外部团队维护的 Agent 服务。
- **本地 AgentHub 内部不要过早 A2A 化**：当前 RuntimeRegistry + Blackboard 更直接。

参考：[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[MCP client concepts](https://modelcontextprotocol.io/docs/learn/client-concepts)、[Google ADK: A2A introduction](https://adk.dev/a2a/intro/)

---

## 4. AgentHub 推荐总体架构

### 4.1 三种协作拓扑

AgentHub 应明确支持三种协作拓扑，而不是只有一种“群聊多 Agent”。

#### A. Direct Agent：单 Agent 直接处理

适用：

- 简单问答。
- 单文件修改。
- 用户明确指定一个 Agent。
- 任务不可并行或上下文耦合强。

设计：

- 走现有 `runAgentReply`。
- 可使用 RuntimeRegistry。
- 可产出 artifact。
- 可 handoff 给其他 Agent，但默认不启动 Orchestrator。

#### B. Handoff：专业 Agent 接力

适用：

- 用户先问 Architect，再切到 Coder。
- Reviewer 发现问题后交给 Coder 修复。
- Support / Settings / Coding Tool 等不同领域 Agent 接管会话。

设计：

- 增加 `handoff` 事件和消息 metadata。
- 当前 Agent 输出 `handoffSuggestion`，用户确认或系统自动执行。
- 接收方只拿结构化摘要和 artifact refs，不拿全部 raw history。

#### C. Orchestrator-worker：中心编排

适用：

- `@orchestrator`。
- 多文件、多角色、多阶段任务。
- 需要并行调研、实现、测试、审查。
- 需要最终综合报告。

设计：

- Orchestrator 维护 Run Ledger。
- Worker Agent 只负责自己的 task。
- Worker 写 Blackboard 和 artifacts。
- Synthesizer 读取结构化产物并汇总。

### 4.2 推荐分层

```text
User / IM UI
  - Direct chat
  - Agent Group
  - Task cards
  - Artifact cards
  - Run timeline

Collaboration Layer
  - Intent Router
  - Handoff Manager
  - Orchestrator Run Manager
  - Human Approval Gate

Planning & Scheduling Layer
  - Clarifier
  - Planner
  - Task Ledger
  - Progress Ledger
  - Task Scheduler
  - Replanning Engine
  - Budget Manager

Agent Runtime Layer
  - LLM Runtime
  - Code Agent Runtime
  - Remote A2A endpoint adapter (future protocol profile, not runtimeType)

Shared State & Artifact Layer
  - Blackboard
  - Artifact Store
  - Execution Logs
  - Run Events
  - Agent Workdirs
  - Handoff Store

Tool / Protocol Layer
  - Local tools
  - MCP servers
  - Browser/search
  - File/DB/Office/deploy tools
```

---

## 5. 关键设计点

### 5.1 Intent Router：先判断是否值得多 Agent

用户输入进入后先路由：

```text
if explicitly_mentions("@orchestrator"):
  create_orchestrator_plan
elif mentions_specific_agent:
  run_direct_or_handoff
elif simple_question:
  direct_agent
elif task_requires_parallel_work:
  suggest_orchestrator
else:
  direct_agent
```

判断维度：

- 是否涉及多个文件/模块？
- 是否需要调研 + 设计 + 实现 + 审查？
- 是否可以拆成互不依赖的任务？
- 是否需要多个工具？
- 预计 token / 时间成本是否值得？

这一步很重要，因为多 Agent 的失败常来自”任务本来不该多 Agent”。

**实施状态**（2026-05-27）：已实现。`chatStore.ts` 新增 `assessIntentComplexity()` 启发式检测，6 种信号自动评分（多文件引用 +2、多阶段关键词 +2、架构意图 +2、协作暗示 +1、复杂动词+技术对象 +1、长消息+技术内容 +1），≥3 分自动路由到编排器。仅在群聊 + ≥2 Agent 时生效。

### 5.2 Clarifier：复杂任务先澄清，不要直接开跑

Kimi Researcher、Anthropic Research 这类系统都不是盲目执行。AgentHub 应在以下情况下先问 1-3 个澄清问题：

- 用户目标模糊。
- 需要修改真实项目但未指定范围。
- 涉及高风险操作。
- 需求可能有多种解释。

产品形态：

- 任务卡顶部显示”需要确认的信息”。
- 用户可以点选或直接编辑。
- 确认后生成最终计划。

**实施状态**（2026-05-27）：已实现。Planner 的 JSON schema 扩展 `clarificationQuestions` 字段，LLM 在目标模糊时生成 1-3 个澄清问题（含 2-4 个选项）。前端 `Thread.tsx` 的 `OrchestratorPlanCard` 新增”需求澄清”区域，用户可点击选项回答，回答后高亮显示。

### 5.3 Planner：输出阶段 + 任务，而不是平铺任务

当前 DAG 容易把所有任务平铺。建议改为两层：

- Phase：分析、设计、实现、验证、总结。
- Task：每个阶段下的具体工作。

示例：

```json
{
  "phases": [
    {
      "id": "analysis",
      "title": "理解现有项目",
      "tasks": ["scan-web", "scan-server", "scan-db"]
    },
    {
      "id": "implementation",
      "title": "实现功能",
      "tasks": ["backend-change", "frontend-change"]
    },
    {
      "id": "review",
      "title": "验证和审查",
      "tasks": ["run-tests", "review-diff"]
    }
  ]
}
```

前端展示也应按 phase 折叠，避免用户看到一大串任务。

### 5.4 Task Ledger 与 Progress Ledger

建议新增或强化两类状态。

Task Ledger：

- `runId`
- `goal`
- `assumptions`
- `constraints`
- `phases`
- `tasks`
- `agentAssignments`
- `artifactExpectations`
- `budget`

Progress Ledger：

- `completedTaskIds`
- `blockedTaskIds`
- `currentRisks`
- `latestFacts`
- `openQuestions`
- `nextActions`
- `replanHistory`

这可以存到 `orchestrator_runs.plan`、`workspace_tasks`、`execution_logs`，但最好再加一个 `orchestrator_run_events` 表或统一事件流。

### 5.5 Run Events：前端可视化的真实来源

建议引入事件模型：

```typescript
type RunEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'plan.created'; runId: string; plan: PlanSummary }
  | { type: 'task.started'; taskId: string; agentId: string }
  | { type: 'task.stream'; taskId: string; delta: string }
  | { type: 'blackboard.write'; taskId: string; key: string; summary: string }
  | { type: 'artifact.created'; taskId: string; artifactId: string }
  | { type: 'task.failed'; taskId: string; error: string }
  | { type: 'task.retried'; taskId: string; attempt: number }
  | { type: 'run.replanned'; runId: string; reason: string }
  | { type: 'run.completed'; runId: string }
```

所有 UI 进度、日志、时间线都从事件流推导。这样比直接改消息 metadata 更稳定。

### 5.6 Blackboard：从任意 JSON 变成 typed workspace memory

Blackboard 推荐分区：

```text
run/{runId}/facts/*
run/{runId}/decisions/*
run/{runId}/artifacts/*
run/{runId}/risks/*
run/{runId}/questions/*
run/{runId}/diffs/*
```

推荐 Schema：

```typescript
type BlackboardEntry =
  | FactEntry
  | DecisionEntry
  | ArtifactRefEntry
  | RiskEntry
  | OpenQuestionEntry
  | DiffSummaryEntry
```

每个 entry 必须包含：

- `schemaType`
- `summary`
- `sourceAgentId`
- `taskId`
- `confidence`
- `evidenceRefs`
- `createdAt`

这样 Synthesizer 可以做可靠汇总，Reviewer 可以追溯证据。

### 5.7 Agent Roster：常驻 Agent + 临时 Agent

建议区分两类 Agent：

#### Resident Agents

用户可见、可配置、长期存在：

- Orchestrator
- Architect
- Coder
- Reviewer
- Researcher
- QA

#### Ephemeral Workers

由 Orchestrator 临时创建，只服务于一次 run：

- `researcher-web-1`
- `frontend-scanner`
- `db-schema-reader`
- `test-fixer`

临时 Agent 不一定出现在主联系人列表里，但应出现在任务时间线里。这样既能借鉴 Kimi Swarm 的动态组织，又不会污染用户的 Agent 管理界面。

### 5.8 Agent 能力匹配

当前 profile 已有 `runtimeType`、`codeAgentType`、`capabilityTags`、`toolPermissions`、`sandboxPolicy`。建议增加运行时评分：

```typescript
interface AgentCapabilityScore {
  agentId: string
  taskType: string
  skillScore: number
  toolFitScore: number
  contextFitScore: number
  reliabilityScore: number
  costScore: number
  latencyScore: number
}
```

调度时不要只按角色名匹配，而是综合：

- 能否访问所需工具？
- 是否有写权限？
- 是否适合当前语言/框架？
- 最近失败率如何？
- 成本和速度是否合适？

### 5.9 Code Agent 协作协议

多 Code Agent 协作应有固定协议：

1. Orchestrator 创建 run。
2. 为每个写入任务创建 branch。
3. Worker 执行前读取 task contract。
4. Worker 执行后必须产出：
   - diff
   - touched files
   - test command
   - result summary
   - risk notes
5. Reviewer Agent 审查 diff。
6. ConflictResolver 检测并合并。
7. 用户确认后才进入主分支或工作区。

任务 contract 示例：

```json
{
  "taskId": "frontend-change",
  "goal": "实现任务进度面板",
  "allowedPaths": ["apps/web/src/**"],
  "forbiddenPaths": ["packages/db/**"],
  "expectedArtifacts": ["diff", "test-result"],
  "validationCommands": ["bun --filter @agenthub/web typecheck"]
}
```

这比“让 Agent 自己随便改”更适合比赛演示和真实使用。

### 5.10 Synthesizer：汇总不是总结，而是交付报告

Synthesizer 输出应固定为交付报告：

```text
1. 完成了什么
2. 每个 Agent 的贡献
3. 产生了哪些产物
4. 关键决策和依据
5. 已验证内容
6. 未解决风险
7. 用户下一步可选操作
```

对代码任务，必须包含：

- 文件变更列表。
- 测试结果。
- 是否有冲突。
- 是否需要人工确认。

### 5.11 Human-in-the-loop：审批点要少但关键

需要人工确认的节点：

- 执行写入型 Code Agent 前。
- 调用高风险工具前。
- 切换到 `danger-full-access` 前。
- 合并多个 Agent diff 前。
- 任务需求不明确但成本较高时。

不需要人工确认的节点：

- read-only 文件扫描。
- 生成计划草案。
- 生成临时摘要。
- 低风险 artifact demo。

UI 上不要弹太多确认框。推荐在 task card 内集中展示“待确认动作”。

### 5.12 Observability：每个 Agent 都要可追踪

借鉴 OpenAI Agents SDK tracing 的思路，AgentHub 的 execution logs 应覆盖：

- Run trace。
- Agent span。
- LLM generation。
- Tool call。
- Handoff。
- Guardrail / approval。
- Blackboard read/write。
- Artifact creation。

前端可做三个视图：

- 用户视图：任务进度 + 结果。
- 开发者视图：事件时间线 + 日志。
- 调试视图：prompt、工具调用、token、错误。

参考：[OpenAI Agents SDK tracing](https://github.com/openai/openai-agents-python/blob/main/docs/tracing.md)

---

## 6. 产品交互建议

### 6.1 群聊里的 Orchestrator 任务卡

任务卡应分四层：

1. **目标层**：用户目标、约束、是否需要确认。
2. **阶段层**：Analysis / Design / Build / Verify / Synthesize。
3. **任务层**：每个 task 的 Agent、状态、耗时、产物。
4. **事件层**：展开后看详细日志。

状态设计：

- `draft`：计划草案，等待确认。
- `ready`：计划确认，可执行。
- `running`：执行中。
- `waiting_user`：等待用户输入或审批。
- `replanning`：重规划中。
- `synthesizing`：汇总中。
- `completed`：完成。
- `failed`：失败但保留产物和日志。

### 6.2 Agent 联系人列表

联系人列表应区分：

- 常驻 Agent。
- 当前 Workspace Agent。
- 当前 Run 临时 Agent。
- 外部 Agent（未来 A2A）。

Agent card 展示：

- runtime。
- sandbox。
- tool permissions。
- 最近任务状态。
- 成功率 / 最近失败。
- 当前是否忙碌。

### 6.3 Run Timeline

Office / Orchestrator Runs 页面应展示：

```text
09:20 run.started
09:21 plan.created
09:22 task scan-web started by Researcher
09:22 task scan-server started by Architect
09:24 blackboard.write facts/current-architecture
09:25 artifact.created server-diff
09:26 task review-diff started by Reviewer
09:28 run.completed
```

这会比单纯聊天气泡更能体现“多 Agent 协作平台”。

---

## 7. 技术落地路线

### Phase 0：统一口径与演示闭环

目标：保证当前功能可稳定演示。

任务：

- 修正 `IMPLEMENTATION_STATUS.md` 中与代码不一致的内容。
- 明确已实现、可演示、路线图三类能力。
- 跑通一条标准 demo：
  - 创建 Workspace。
  - 创建 Agent Group。
  - `@orchestrator` 生成计划。
  - dispatch。
  - 展示任务进度。
  - 生成 artifact 和汇总。

### Phase 1：Run Events + 任务卡升级

目标：让 Orchestrator 过程可见。

任务：

- 新增 `orchestrator_run_events` 表或基于 execution_logs 统一事件模型。
- 服务端广播标准 `run:event`。
- 前端 task card 从事件流更新状态。
- Orchestrator Runs 页面展示 timeline。

### Phase 2：Ledger 化 Orchestrator

目标：把 Orchestrator 从静态 DAG 升级为动态 Run Manager。

任务：

- 引入 Task Ledger / Progress Ledger schema。
- Planner 输出 phase + task。
- Scheduler 执行中周期性更新 progress ledger。
- ReplanningEngine 把重试、替换 Agent、局部重规划写入 ledger。

实施状态（2026-05-27）：

- Phase 1 已完成第一阶段闭环：新增 `orchestrator_run_events` 表、`run:event` 广播、`GET /api/orchestrator-runs/:id/events`、Orchestrator Runs 时间线，以及关键 Engine 节点事件。
- Phase 2 已完成最小可交付切片：新增 `TaskLedger` / `ProgressLedger` 运行时 schema，持久化在 `orchestrator_runs.plan` 中，不新增额外表，避免过早扩大迁移面。
- Planner / task card / dispatch 现在兼容 `phases + tasks` 两层结构；旧的平铺 `tasks` 会自动补默认 phase。
- `emitRunEvent` 会把 `task.started/completed/failed/cancelled`、`blackboard.written`、`artifact.created`、`task.retrying`、`task.reassigned`、`run.replanned`、`conflict.*`、`run.completed/failed/cancelled` 增量折叠到 Progress Ledger。
- Orchestrator Runs 详情页新增 Progress Ledger 阶段进度区块；聊天任务卡增加 phase 标签，但仍保留 `task:update` / `blackboard:update` 作为任务卡状态来源。
- Phase 3 已完成最小可交付切片：新增 typed Blackboard value schema，覆盖 `fact`、`decision`、`risk`、`artifact_ref`、`diff_summary`、`test_result`、`task_output`。
- `Blackboard.write` 对带 `schemaType` 的 value 做 Zod 校验；无 `schemaType` 的历史/自由 JSON 仍兼容，避免打断现有黑板使用。
- Orchestrator 任务完成后会写入 typed `task_output`，并从任务摘要派生 `decision`、`diff_summary`、`artifact_ref`；`GET /api/orchestrator-runs/:id/blackboard` 可按 `schemaType` 查询。
- Synthesizer 已接收完整 typed Blackboard 条目作为结构化上下文；Orchestrator Runs 页面新增“结构化黑板”证据区，展示来源、贡献者、confidence 与版本。
- 用户接管能力已完成第一刀：`POST /api/orchestrator-runs/:id/cancel` 会取消活动 scheduler、把 run 置为 `cancelled`、收敛未完成任务状态、写入 `run.cancelled` 事件并刷新 Runs 详情页。
- 剩余增强：任务级 retry API、pause/resume、并发运行下 ledger 原子更新、Planner 输出 contract/validation 的强校验、typed schema 向共享契约包收敛。

### Phase 3：Blackboard typed schema

目标：让 Agent 产出可追溯、可合成、可审查。

任务：

- 定义 Fact / Decision / Risk / ArtifactRef / DiffSummary schema。
- Blackboard 写入时校验 schema。
- Synthesizer 只读取 typed entries。
- 前端显示“证据来源”和“贡献者”。

实施状态（2026-05-27）：

- 已在服务端新增 `blackboard-schemas.ts`，第一版 schema 覆盖事实、决策、风险、产物引用、diff 摘要、测试结果和任务产出。
- `Blackboard.write` 会校验 typed value 并存储校验后的规范化 JSON；`Blackboard.query` 支持 `schemaType` 过滤。
- Orchestrator Engine 已在 task completed 路径写入 typed `task_output`、`decision`、`diff_summary`、`artifact_ref`，同时保留原有 `blackboard:update` 广播。
- 新增 `GET /api/orchestrator-runs/:id/blackboard`，鉴权复用 run ownership；前端 API 和 Orchestrator Runs 页面已展示结构化证据。
- Synthesizer 汇总 prompt 已注入 typed Blackboard context，减少只靠 raw output 拼接的不可追溯问题。

### Phase 4：Code Agent 协作闭环

目标：让多 Agent 写代码可控。

任务：

- 任务 contract 增加 allowedPaths、expectedArtifacts、validationCommands。
- CodeAgentRuntime 执行后标准化 diff artifact。
- Reviewer Agent 自动审查 diff。
- ConflictResolver 结果进入 artifact card。
- 用户确认合并或放弃。

实施状态（2026-05-27）：

- 已完成 Phase 4 前两刀：Plan task 支持 `outputContract` 与 `validation`，dispatch 会把契约写入 `ExecutionPlan` / `TaskLedger`，不再只停留在文档字段。
- Planner / 群聊 task card 解析均已接受 `outputContract.requiredBlackboardWrites`、`requiredArtifacts`、`allowedPaths`、`acceptanceCriteria` 和 `validation.commands`、`requiresReview`。
- Orchestrator Engine 在任务完成后执行安全白名单内的 `validation.commands`，将每条命令结果写入 typed Blackboard `test_result`；失败命令会让任务进入失败/重试路径，非白名单命令会被标记为 `skipped`。
- Orchestrator Engine 会校验 `requiredArtifacts` 和 `allowedPaths`：缺少必需 artifact 或产物路径越界会写入 typed `risk` 并让任务失败，进入现有 retry/fallback/replan 路径。
- 群聊计划卡会展示每个任务的 allowed paths、required artifacts 和 validation commands；Runs 详情的 Progress Ledger 会展示阶段级 contract/validation 数量。
- Runs 页已有”结构化黑板”证据区，因此 `test_result` 会作为测试证据显示；后续可再做专门的 validation panel。
- **Reviewer 自动审查链路**（2026-05-27 新增）：`OrchestratorEngine.injectAutoReviewTasks()` 在 code 任务完成且 `requiresReview: true` 时自动注入 Reviewer 审查任务，审查 diff 质量和安全性。
- 尚未完成：Code Agent diff artifact 更严格标准化、用户确认合并/放弃动作、专门 validation/contract 详情面板。

### Phase 5：小规模动态 Swarm

目标：借鉴 Kimi，但以本地可控方式落地。

任务：

- Orchestrator 可为某个 phase 创建 ephemeral workers。
- 并发上限默认 3，可配置到 8。
- 每个临时 Worker 必须有短描述、任务边界和输出 schema。
- 适用场景先限制在 read-only research / scan / review，不直接写代码。

### Phase 6：MCP/A2A 扩展

目标：生态化，而不是过早复杂化。

任务：

- MCP：工具、资源、roots、prompt template。
- A2A：只用于远程 Agent 服务，不替代本地 RuntimeRegistry。
- Agent Card：为外部 Agent 定义能力、认证、成本、权限。

---

## 8. 推荐的比赛演示脚本

演示目标：让评委看到 AgentHub 不是“多开几个聊天窗口”，而是一个可观察的 AI 协作工作台。

### Demo：让 AgentHub 给自己加一个功能

用户输入：

```text
@orchestrator 给 Orchestrator Runs 页面增加一个运行时间线视图，
要求展示每个任务的 Agent、状态、产物和错误信息，
先分析现有代码，再给出实现并让 Reviewer 审查。
```

系统过程：

1. Orchestrator 生成计划：
   - Scan frontend routes。
   - Scan server run data。
   - Design timeline UI。
   - Implement frontend。
   - Review diff。
2. Architect / Researcher 并行只读扫描。
3. Coder 修改前端页面。
4. Reviewer 审查 diff。
5. Synthesizer 汇总：
   - 修改了哪些文件。
   - 测试是否通过。
   - 还存在什么风险。
6. 聊天里出现：
   - task card。
   - diff card。
   - review card。
   - final summary。

演示亮点：

- 群聊里可见多个 Agent。
- 任务并行和依赖清晰。
- 产物不丢失，直接内联。
- Code Agent 写入有边界和审查。
- 用户始终掌握确认权。

---

## 9. 评估指标

多 Agent 系统必须证明“多”是有价值的。

建议记录这些指标：

| 指标 | 说明 |
|---|---|
| Wall-clock time | 相比单 Agent 是否更快 |
| Success rate | 任务完成率 |
| Replan count | 重规划次数，过高说明规划不稳 |
| Tool call count | 成本和复杂度 |
| Token estimate | 成本评估 |
| Artifact completeness | 是否产出预期 artifact |
| Review issue count | Reviewer 发现的问题 |
| User intervention count | 用户被打断次数 |
| Merge conflict count | 多 Agent 写代码冲突频率 |

比赛演示时不需要全量指标，但至少要展示：

- 任务状态。
- 耗时。
- Agent 贡献。
- 产物。
- 风险。

---

## 10. 风险与反模式

### 10.1 反模式：Agent 越多越好

错误。Anthropic 的经验显示，多 Agent 成本高，且代码任务并不总是适合高度并行。AgentHub 应把并行用在真正可拆的地方。

### 10.2 反模式：让 Agent 自由群聊

多个 Agent 互相自由聊天容易变成 token 黑洞。AgentHub 应使用结构化任务、黑板、ledger 和 artifact，而不是无限消息互刷。

### 10.3 反模式：所有状态都塞进 message metadata

消息适合展示，不适合作为唯一状态源。运行状态应有独立 run events / ledgers，消息只引用这些状态。

### 10.4 反模式：过早完整 A2A

A2A 适合远程独立 Agent 服务。AgentHub 当前本地多 Agent 用 RuntimeRegistry + Blackboard 更直接。

### 10.5 反模式：Code Agent 直接改主分支

必须坚持分支隔离、diff artifact、Reviewer、用户确认。

---

## 11. 最小可落地设计

如果只做一轮优化，建议做这 6 件事：

1. **Run Event 标准化**：所有任务进度都写事件。
2. **任务卡 phase 化**：展示阶段、任务、Agent、状态、产物。
3. **Ledger schema**：在 orchestrator_runs.plan 中存 Task Ledger / Progress Ledger。
4. **Blackboard typed entries**：先支持 Fact、ArtifactRef、Risk、Decision。
5. **Code task contract**：限制路径、产物、验证命令。
6. **标准 demo 脚本**：固定一条“多 Agent 修改 AgentHub 自身”的闭环。

这 6 件事能最大化比赛观感，也能为后续真正的 Swarm、MCP、A2A 打基础。

---

## 12. 参考资料

- [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Kimi Help Center: K2.6 Agent Swarm](https://www.kimi.com/help/agent/agent-swarm)
- [AutoGen: Magentic-One](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html)
- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)
- [LangGraph fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance)
- [LangChain: Handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)
- [OpenAI Agents SDK: Agents and multi-agent patterns](https://openai.github.io/openai-agents-python/agents/)
- [OpenAI Agents SDK: Tracing](https://github.com/openai/openai-agents-python/blob/main/docs/tracing.md)
- [CrewAI introduction](https://docs.crewai.com/en/introduction)
- [CrewAI Flows](https://crewai.com/crewai-flows)
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP client concepts](https://modelcontextprotocol.io/docs/learn/client-concepts)
- [Google ADK: A2A introduction](https://adk.dev/a2a/intro/)

