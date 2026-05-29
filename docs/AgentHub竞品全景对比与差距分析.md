# AgentHub 竞品全景对比与差距分析

> 本文基于 AgentHub 当前代码实现（2026-05-29），与 Kimi Agent Cluster、讯飞 AstronClaw、OpenAI Agents SDK、LangGraph、CrewAI、MetaGPT、Magentic-One、Coze 等主流多 Agent 产品/框架进行逐维度对比。

---

## 一、当前 AgentHub 架构速览

```
┌─────────────────────────────────────────────────────────────────────┐
│  交互层：IM 式群聊（单聊 / 群聊 / @mention / @orchestrator）           │
├─────────────────────────────────────────────────────────────────────┤
│  群聊协调层：GroupChatManager                                        │
│  - @mention 路由 · 复杂任务信号检测 · 轮询式对话循环                   │
├─────────────────────────────────────────────────────────────────────┤
│  编排引擎层：OrchestratorEngine (~1600 行)                           │
│  - Planner(LLM) → TaskScheduler(DAG) → Synthesizer                  │
│  - ConflictResolver · ReplanningEngine · FallbackEngine             │
│  - AgentRouter(评分制) · TaskContract · InputGuardrails             │
├─────────────────────────────────────────────────────────────────────┤
│  Agent 执行层：RuntimeRegistry                                        │
│  - LlmRuntime（流式包装）                                            │
│  - CodeAgentRuntime（codex/claude/opencode/gemini CLI 适配）          │
│  - NativeToolRuntime → 已升级为 MCP Runtime（真正的 MCP 客户端）    │
│  - A2aRuntime：❌ 有接口定义，零实现                                  │
├─────────────────────────────────────────────────────────────────────┤
│  状态层：Workspace State（文件 JSON）+ Blackboard（SQLite）          │
│  - Run Ledger：内存驻留，重启丢失                                    │
│  - Task Ledger / Progress Ledger：JSON 字段存于 orchestrator_runs  │
├─────────────────────────────────────────────────────────────────────┤
│  安全层：Git 分支隔离（worktree）+ SandboxPolicy 三级策略             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 二、竞品分类与核心特征

| 产品/框架 | 类型 | 核心哲学 | 协作拓扑 |
|---|---|---|---|
| **Kimi Agent Cluster** | 闭源产品 | 指挥官 + 300 子 Agent 水平扩展 | Star（协调器-工作者） |
| **讯飞 AstronClaw** | 闭源产品 | 一键组队，三种协作模式可选 | Pipeline / Map-reduce / Supervisor |
| **Kimi Claw 群组** | 闭源产品 | 人和 AI 在同一个 IM 群 | 群聊 + 协调员 |
| **OpenAI Agents SDK** | 开源框架 | 四大原语，零仪式 | Handoff 链（去中心化） |
| **LangGraph** | 开源框架 | 图状态机 | 有向图（DAG/循环） |
| **CrewAI** | 开源框架 | 组装你的团队 | 角色队列 |
| **MetaGPT** | 开源框架 | 软件公司模拟 | SOP 流水线（装配线） |
| **Magentic-One** | 开源研究系统 | 双账本通用协调 | Star（Orchestrator + 4 专家） |
| **Coze / 扣子** | 低代码平台 | 可视化编排 | 节点图 + 多 Agent 分发 |
| **Dify** | LLMOps 平台 | 应用开发平台 | 单 Agent + 工作流 |
| **AgentHub** | 开源产品 | IM 式工作台 + 本地执行 | 群聊 + DAG 编排 |

---

## 三、逐维度详细对比

### 3.1 交互范式

| 维度 | AgentHub | Kimi Claw 群组 | 讯飞 AstronClaw | Coze | OpenAI Agents SDK |
|---|---|---|---|---|---|
| **入口形态** | Web IM（类 Discord/Slack） | IM 群聊 | Web 对话 + 右侧任务板 | 低代码画布 | Python/TS 代码 |
| **用户触达** | `@Agent` 或 `@orchestrator` | `@Kimi` 或自然触发 | 自然语言一键触发 | 节点连接 | 代码调用 `Runner.run()` |
| **人机同群** | ✅ 支持 | ✅ 测试中的 Claw 群组 | ❌ 纯 AI 协作 | ❌ | ❌ |
| **执行中干预** | ✅ 可在 Orchestrator 执行中 `@mention` 切换 | 未知 | 未知 | ❌ | 需代码实现 |
| **Plan 确认** | ✅ 计划卡片，用户可确认/编辑/拒绝 | 自动执行 | 自动执行 | 工作流预定义 | 无内置确认 |
| **Plan 可视化** | ⚠️ 前端有卡片，无 DAG 图 | ✅ 进度条 + 子 Agent 状态 | ✅ 右侧任务板 | ✅ 画布 | ❌ |

**关键差距**：
- AgentHub 的 **Plan 可视化** 只有文字卡片，没有类似 Kimi/讯飞的**实时进度看板**和**DAG 拓扑图**。
- AgentHub 的 **执行中干预** 已经实现（`@mention` 切换），这是多数框架没有的能力，但 UX 还不够显性（用户不知道何时可以干预）。

---

### 3.2 Agent 角色与团队模型

| 维度 | AgentHub | Kimi Agent Cluster | MetaGPT | CrewAI | Magentic-One |
|---|---|---|---|---|---|
| **团队组建** | 用户手动创建 workspace + 选模板 | AI 自动组建（最多 300 子 Agent） | 固定 5 角色（PM/Architect/PM/Engineer/QA） | 用户代码定义 Role/Goal/Backstory | 固定 4 专家 + Orchestrator |
| **角色粒度** | 中等（Orchestrator/Researcher/Architect/Coder/Reviewer） | 极细（每个子任务一个 Agent） | 粗（完整软件公司） | 粗（研究员/写手/编辑） | 中等（Web/File/Coder/Terminal） |
| **动态扩缩** | ❌ 固定团队 | ✅ 运行时动态创建/销毁子 Agent | ❌ 固定 | ❌ 固定 | ❌ 固定（但可插拔） |
| **角色档案** | ✅ systemPrompt + capabilityTags + roleType + qualityGates | 未知 | ✅ Profile + Goal + Constraints + Skills | ✅ Role + Goal + Backstory | ✅ 系统提示词专业化 |
| **Agent 间关系** | ✅ 显式关系图（handoff_to/reviewed_by/reports_to/fallback_to） | 指挥官-队员 | 装配线顺序 | 隐式依赖 | Orchestrator 指派 |

**关键差距**：
- AgentHub 的 **动态扩缩** 能力为零。Kimi 的核心优势就是"需要多少 Agent 就创建多少"。AgentHub 应该支持 Orchestrator 在运行时动态创建临时子 Agent（ephemeral workers）。
- AgentHub 的 **qualityGates** 和 **roleProfile** 是定义层面的，**运行时并未真正执行**（只是描述性字段）。MetaGPT 的 SOP 是强制执行的——每个角色必须产出结构化文档才能交接。

---

### 3.3 任务编排与调度

| 维度 | AgentHub | Kimi Agent Cluster | LangGraph | MetaGPT | Magentic-One |
|---|---|---|---|---|---|
| **编排模型** | 中央 Orchestrator + DAG 调度 | 中央协调器 + 水平并行 | 图状态机（StateGraph） | SOP 流水线 | 双账本（Task + Progress） |
| **并行能力** | ✅ DAG 同层并发（max 3） | ✅ 300 子 Agent 并行 | ✅ 图节点并行 | ❌  mostly 串行装配线 | ❌ 串行指派 |
| **动态重规划** | ✅ ReplanningEngine（6 种策略） | ✅ 自动修复、重新分配 | ✅ 条件边路由 | ❌ 固定 SOP | ✅ 外循环重规划 |
| **循环检测** | ✅ TaskGraph 拓扑排序 + 环检测 | 未知 | ✅ 图级控制 | N/A | ✅ Progress Ledger 自检 |
| **停滞检测** | ❌ 无 | 关键步骤机制 | 需自定义 | N/A | ✅ 内循环计数器 ≥2 触发重规划 |
| **子任务生成** | LLM 一次性生成完整 DAG | 运行时动态拆分 | 预定义图 + 动态条件 | 预定义 SOP 阶段 | Orchestrator 逐步指派 |

**关键差距**：
- AgentHub 的 **停滞检测** 缺失。Magentic-One 的 Progress Ledger 每轮自反思 5 个问题（是否完成？是否循环？是否有进展？下一个谁？说什么？），这是 AgentHub 没有的。
- AgentHub 的 **Planner 是同步阻塞的**（`POST /orchestrator-plan` 等待 LLM 返回），Kimi/Magentic-One 都是异步流式生成计划。
- AgentHub 的 **DAG 是静态的**（生成后不变），Kimi 的协调器可以在执行中动态拆分/合并子任务。

---

### 3.4 状态管理

| 维度 | AgentHub | Magentic-One | Kimi | LangGraph | OpenAI Agents SDK |
|---|---|---|---|---|---|
| **全局状态** | Workspace State（文件 JSON） | Task Ledger + Progress Ledger | 上下文分片（Context Sharding） | StateGraph（持久化 checkpoint） | 无内置，需自建 |
| **共享内存** | Blackboard（SQLite，typed） | 双账本 | 协调器汇总关键结论 | 图状态 | 对话历史 |
| **状态持久化** | ❌ Run 内存丢失；Workspace State 文件级 | ✅ 账本持续更新 | 未知 | ✅ Checkpoint 持久化 | ❌ 需自建 |
| **并发安全** | ❌ Workspace State 文件 JSON 有竞争风险 | 单线程 Orchestrator 指派 | 各子 Agent 独立分片 | ✅ 状态图事务 | N/A |
| **状态查询** | Blackboard 支持 schemaType 过滤 | 账本结构化 | 未知 | 图状态快照 | 无 |

**关键差距**：
- AgentHub 的 **Workspace State 是文件级 JSON**，多 Agent 同时完成时可能互相覆盖。应该迁移到 SQLite（已有 Drizzle ORM）。
- AgentHub 的 **Run 状态是内存中的**（`activeEngines` Map），服务器重启全部丢失。Magentic-One 的账本和 LangGraph 的 checkpoint 都是持续持久化的。
- Kimi 的 **Context Sharding** 是非常聪明的设计——每个子 Agent 只保留自己的"小本子"，只把关键结论汇报给协调器。AgentHub 的 Blackboard 是全量写入，没有分片机制。

---

### 3.5 代码执行与安全

| 维度 | AgentHub | Kimi | MetaGPT | OpenHands / SWE-Agent |
|---|---|---|---|---|
| **代码执行** | ✅ 本地 CLI（codex/claude/opencode/gemini） | 未知（云端？） | 本地执行 | 本地 Docker/Sandbox |
| **隔离机制** | ✅ Git worktree 分支隔离 | 未知 | 无（直接写文件） | Docker 容器 |
| **产物收集** | ✅ Git diff 提取 artifact | 未知 | 直接写文件 | Git diff |
| **冲突解决** | ✅ ConflictResolver（3-way merge） | 交叉验证 | 无 | 无 |
| **人工确认** | ✅ Plan 确认 + 最终 squash merge 确认 | 未知 | 无 | 无 |
| **沙箱策略** | ✅ 三级：read-only / workspace-write / danger-full-access | 未知 | 无 | 容器级 |
| **自动审阅** | ✅ Verifier → Reviewer 链 | 未知 | 无 | 无 |

**AgentHub 的优势**：
- **Git 分支隔离 + 人工确认** 是 AgentHub 的差异化亮点。Kimi、MetaGPT、OpenAI Agents SDK 都没有这种"代码级安全闭环"。
- **ConflictResolver** 虽然功能还不完善（单变体自动合并有问题），但方向是对的。

**AgentHub 的问题**：
- **Workspace task dispatch 绕过了 GitBranchManager**（`task-execution-service.ts` 中 `needBranch = ... && !isSandboxPath(projectPath)`），sandbox workspace 不隔离。这是安全漏洞。

---

### 3.6 工具生态

| 维度 | AgentHub（新版） | OpenAI Agents SDK | Kimi | LangGraph | Coze |
|---|---|---|---|---|---|
| **工具协议** | ✅ MCP（真正的 MCP Client） | ✅ MCP（原生集成） | 未知 | 需适配 | 插件/工作流 |
| **工具数量** | 取决于连接的 MCP 服务器（可扩展至 100+） | 取决于 MCP 服务器 | 内置 | 取决于集成 | 平台内置 + 自定义 |
| **工具发现** | ✅ 运行时从服务器 listTools() | ✅ 运行时发现 | 未知 | 预定义 | 预定义 |
| **只读/写入** | ✅ 利用 MCP annotations.readOnlyHint | Guardrails 控制 | 未知 | 节点级控制 | 节点级控制 |
| **本地工具** | ✅ 文件系统、代码搜索、ripgrep | 取决于 MCP 服务器 | 未知 | 需自建 | 有限 |

**AgentHub 的优势**：
- 刚刚升级为 **真正的 MCP Runtime**，工具和 OpenAI Agents SDK 一样接入 MCP 生态。这是重大进步。

---

### 3.7 人机交互（Human-in-the-Loop）

| 维度 | AgentHub | Kimi | Magentic-One | LangGraph | Coze |
|---|---|---|---|---|---|
| **Plan 确认** | ✅ 确认 / 编辑 / 拒绝 | ❌ 自动执行 | ❌ 自动执行 | ✅ `interrupt` 节点 | ❌ 预定义 |
| **执行中暂停** | ⚠️ 可 `@mention` 切换，但不显式暂停 | 未知 | ❌ | ✅ `interrupt` | ❌ |
| **单任务重试** | ❌ 只能重试整个 run | 未知 | ❌ | ✅ 图节点重试 | ❌ |
| **跳过阻塞任务** | ❌ | 未知 | ❌ | ✅ 条件边绕过 | ❌ |
| **最终审阅** | ✅ 产物 diff + 确认合并 | ❌ | ❌ | 需自定义 | ❌ |

**关键差距**：
- AgentHub 的 **Human-in-the-Loop** 只有 Plan 确认和最终审阅两个节点，中间执行过程缺乏显式的暂停/继续/跳过能力。LangGraph 的 `interrupt` 机制允许在任何节点暂停等待人工输入。
- AgentHub 的 **Run 控制** 很弱：一旦开始执行，用户只能等或取消，不能"暂停后改计划再继续"。

---

### 3.8 可观测性

| 维度 | AgentHub | OpenAI Agents SDK | Kimi | Magentic-One | LangGraph |
|---|---|---|---|---|---|
| **Tracing** | ⚠️ Run Events（ SQLite + WebSocket） | ✅ 原生 OpenTelemetry + Dashboard | ✅ 实时进度条 | ✅ 双账本天然可追踪 | ✅ 图执行可视化 |
| **成本追踪** | ❌ 无 | ✅ 内置 | 未知 | 未知 | 需自建 |
| **Token 使用** | ❌ 无 | ✅ 内置 | 未知 | 未知 | 需自建 |
| **前端看板** | ⚠️ 任务卡片 | ✅ 进度条 + Agent 状态 | ✅ 右侧任务板 | ❌ | ✅ LangGraph Studio |

**关键差距**：
- AgentHub **完全没有成本/Token 追踪**。长期运行会导致不可控的 API 费用。OpenAI Agents SDK 和 LangGraph 都有内置或生态工具支持。
- AgentHub 的 **前端看板** 只有任务卡片，缺乏类似 Kimi 的**实时进度看板**和 LangGraph Studio 的**执行图可视化**。

---

### 3.9 持久化与可恢复性

| 维度 | AgentHub | LangGraph | Magentic-One | Kimi |
|---|---|---|---|---|
| **Run 持久化** | ❌ 内存丢失 | ✅ Checkpoint | ✅ 账本 | 云端持久 |
| **中断恢复** | ❌ 重启后 run 丢失 | ✅ 从 checkpoint 恢复 | ✅ 外循环重规划 | 未知 |
| **长时间运行** | ❌ 无 | ✅ 支持 | ✅ 支持 | ✅ 支持 |
| **历史查询** | ✅ orchestrator_runs 表 | ✅ 历史 checkpoint | ✅ 账本历史 | 未知 |

**这是 AgentHub 最严重的架构债务之一**。`activeEngines` 是内存 Map，Bun.serve 重启（代码热更新、崩溃、部署）= 所有进行中的 run 变成僵尸状态。

---

## 四、AgentHub 的核心优势（差异化竞争力）

1. **IM 式群聊 + 本地代码执行**：这是 AgentHub 最独特的定位。Kimi/讯飞是云端产品，OpenAI/LangGraph/CrewAI 是代码框架，Coze 是低代码平台。AgentHub 是**本地运行的、IM 式交互的、真正执行代码的**工作台。
2. **Git 分支隔离 + 人工确认闭环**：从代码安全角度，AgentHub 的 worktree 隔离 + diff 审阅 + squash merge 确认是比大多数框架更成熟的设计。
3. **@mention 路由 + 模式切换**：用户可以在 Orchestrator 执行中随时 `@Agent` 切换为直接对话，这种灵活性在竞品中很少见。
4. **真正的 MCP Runtime**：刚刚升级，工具生态可扩展性追平了 OpenAI Agents SDK。
5. **Typed Blackboard**：带有 schema 验证的共享状态，比纯消息传递更结构化。

---

## 五、AgentHub 的关键差距（按严重程度排序）

### 🔴 P0：致命缺陷

| # | 问题 | 影响 | 对标 |
|---|---|---|---|
| 1 | **Orchestrator runs 内存驻留**，重启丢失 | 生产环境不可用 | LangGraph Checkpoint、Magentic-One 账本 |
| 2 | **Planner 同步阻塞**，`POST /orchestrator-plan` 等待 LLM | 前端超时、用户体验差 | Kimi 流式生成、Magentic-One 异步外循环 |
| 3 | **Workspace State 文件级 JSON**，无事务、有竞争 | 多 Agent 同时完成时状态损坏 | Magentic-One 结构化账本、LangGraph StateGraph |
| 4 | **前端自动 dispatch**，用户无确认即执行 | 高风险操作未经人工审核 | LangGraph `interrupt`、AgentHub 自己的 Plan 卡片 |
| 5 | **DAG 依赖失败死锁**，上游失败后下游永远 pending | Scheduler 永不退出 | Magentic-One 停滞检测、LangGraph 条件边 |

### 🟡 P1：显著差距

| # | 问题 | 影响 | 对标 |
|---|---|---|---|
| 6 | **无成本/Token 追踪** | 不可控的 API 费用 | OpenAI Agents SDK Tracing |
| 7 | **无实时进度看板/DAG 可视化** | 用户看不到执行进展 | Kimi 任务板、LangGraph Studio |
| 8 | **无动态子 Agent 创建** | 无法根据任务复杂度自动扩缩团队 | Kimi 300 子 Agent、OpenAI Swarm |
| 9 | **qualityGates 未运行时执行** | 角色契约只是描述，不强制 | MetaGPT SOP 强制执行 |
| 10 | **Auto-review 在 DAG 外执行** | 无法利用 DAG 并行调度 | 应作为 DAG 节点内嵌 |
| 11 | **Context 注入粗暴**（全量上游输出截断） | Token 浪费、信息丢失 | Kimi Context Sharding |
| 12 | **GroupChatManager 无跨消息记忆** | 每次用户消息都重置 turnCount | Magentic-One 账本持续累积 |

### 🟢 P2：优化项

| # | 问题 | 影响 | 对标 |
|---|---|---|---|
| 13 | **A2A Runtime 未实现** | 无法与外部 Agent 互操作 | Google A2A Protocol |
| 14 | **ConflictResolver 自动合并非功能性** | 多 Agent 修改同一文件时无法自动解决 | 需完善 3-way merge |
| 15 | **无小型动态 Swarm（3-8 临时 worker）** | 广度搜索/并行调研场景效率低 | Kimi Agent Swarm |
| 16 | **Run 控制弱**（无暂停/继续/跳过单任务） | 用户控制力不足 | LangGraph `interrupt` |

---

## 六、改进路线图建议

### Phase 1：止血（1-2 周）—— 解决 P0 缺陷

1. **Run 持久化**：把 `activeEngines` 的 `ProgressLedger` 定期写入 `orchestrator_runs` 表，启动时恢复 `status === 'running'` 的 runs。
2. **Planner 异步化**：`POST /orchestrator-plan` 立即返回 runId，后台流式生成计划，前端轮询或 WebSocket 推送计划卡片。
3. **移除前端自动 dispatch**：`@orchestrator` 触发的计划先生成卡片，用户点击"确认执行"后才真正 dispatch。
4. **DAG 死锁修复**：TaskScheduler 检测失败任务的所有下游，标记为 `blocked` 或 `cancelled`。
5. **Workspace State 入库**：把 `workspace-state.json` 迁移到 SQLite 表，用事务保证并发安全。

### Phase 2：体验升级（2-3 周）—— 补齐 P1

6. **实时进度看板**：前端新增 Orchestrator Run 详情页，显示 DAG 拓扑图（节点状态：pending/running/completed/failed）。
7. **成本追踪**：在 `messages` 表或新增 `llm_calls` 表记录每次调用的 model、inputTokens、outputTokens、cost。
8. **动态子 Agent**：Orchestrator 在执行中可动态创建临时 Agent（如 `researcher-1`, `researcher-2`），执行完毕后销毁。
9. **Context Sharding**：大任务拆分为独立子上下文，各子 Agent 只保留自己的推理细节，只向协调器汇报关键结论。
10. **Auto-review 入 DAG**：把 Reviewer 作为 DAG 节点，而非调度器后注入。

### Phase 3：生态扩展（3-4 周）—— 追赶 P2

11. **A2A Runtime 实现**：接入 Google A2A Protocol，让 AgentHub Agent 能被外部调用，也能调用外部 A2A Agent。
12. **Run 控制增强**：暂停 → 修改计划 → 继续；跳过阻塞任务；单任务重试。
13. **小型 Swarm 模式**：对于搜索/调研类任务，支持一键创建 3-8 个并行子 Agent，结果汇总。
14. **Plan 模板市场**：预置常见任务的 Plan 模板（如"开发小游戏"、"写技术报告"），减少 LLM 生成的不稳定性。

---

## 七、一句话结论

> AgentHub 的 **差异化定位**（本地 IM 群聊 + 代码执行 + Git 安全闭环）是成立的，但 **基础架构成熟度**（状态持久化、异步编排、死锁处理）远低于生产级框架（LangGraph、Magentic-One）。当前最紧迫的不是加功能，而是**把 P0 缺陷修复到能用**——否则 DEMO 再华丽，评委一测就知道是"演示级"而非"产品级"。
