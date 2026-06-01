# 多 Agent 协作分层架构与业内对比

5.31

本文用于统一 AgentHub 的长期架构判断：我们要做的是 IM 式多 Coding Agent 协作工作台，而不是一个固定角色模板系统，也不是只暴露后端图编排 API 的框架。

当前工程事实总览见 `docs/当前状态与下一步路线.md`。本文侧重“为什么这样分层”和“和业内方案相比差在哪里”。

## 一句话定位

AgentHub 的核心路径是：

```text
用户在群聊提出复杂目标
  -> Orchestrator 动态理解和规划
  -> 多个 Coding Agent 在任务子对话里真实执行
  -> 主群聊持续展示计划、状态、成员汇报、产物和最终综合结果
```

其中：

- Codex CLI、Claude Code、OpenCode、Gemini CLI 是主要 Agent 基底。
- 用户自建 Agent 是在这些 Coding Agent 基底上配置角色、提示词、Skills/MCP、权限和上下文策略。
- A2A 是 Agent 间通信协议，不是 Agent 类型。
- AG-UI 是运行事件到前端 UI 的协议，不是编排器。
- MCP、Skills、Rules 是工具和能力层，不是 Agent 类型。
- LLM 是 Orchestrator/Planner/Synthesizer 和 fallback 能力，不是当前自建 Agent 的主要基底。

## 分层总览

```text
产品交互层
  群聊 / 私聊 / 任务子对话 / 任务看板 / 产物卡 / 停止与重试入口

编排规划层
  Orchestrator / Planner / DAG / TaskScheduler / Synthesizer / HITL

通信协议层
  A2A message/send / task / artifact / metadata
  AG-UI run event / step event / artifact event

Agent 身份层
  code-agent profile / llm fallback / role profile / permissions / context policy

执行运行时层
  Codex CLI / Claude Code / OpenCode / Gemini CLI / LLM runtime

能力工具层
  MCP / Skills / Rules / shell / filesystem / browser / document tools

工作区与状态层
  .agenthub/workdirs / .agenthub/handoff / blackboard / execution_logs / run_events
```

任何新功能都应该先判断落在哪一层。不要把协议层做成 Agent 类型，不要把工具层做成 runtime，不要让静态代码替 Orchestrator 做任务意图和分工判断。

## 1. 产品交互层

业内优秀形态：

- WorkBuddy / 讯飞 Agent Team：主群聊展示协调结果，成员在子任务里执行，用户可以看到每个成员产物。
- Kimi 群聊 / Kimi 集群类产品：强调多人协作感、成员状态、阶段性回报。
- Claude Code subagents：强调专门子 Agent、独立上下文和工具权限。

AgentHub 当前设计：

- `group` 是主群聊。
- `direct + metadata.kind = agent-direct` 是全局 Agent 私聊。
- `direct + metadata.kind = orchestrator-task` 是群聊下真实任务子对话。
- 主群聊显示计划、状态、成员汇报、产物和最终总结。
- 子对话保存 Orchestrator 任务提示和 Agent 真实输出。

当前差距：

- 运行开始后的前 10-20 秒必须有明确反馈，不能空白。
- 切换会话后主群聊和子对话状态不能丢。
- 子对话入口必须在任务创建后立即稳定可点击。
- 产物入口必须和任务看板、消息 metadata、子对话一致。

## 2. 编排规划层

业内优秀形态：

- LangGraph：强在图状态、handoff、supervisor、多 Agent workflow、checkpoint。
- Microsoft Agent Framework：强在 workflow、顺序/并发/交接、checkpoint、interrupt/resume。
- OpenAI Agents SDK：强在 handoff、guardrails、tracing。
- CrewAI：强在 Agent/Task/Crew 抽象，但容易走向固定角色和固定流程模板。

AgentHub 当前设计：

```text
messages.ts
  -> intentRouter
  -> Planner 生成动态 DAG
  -> OrchestratorEngine.dispatch()
  -> TaskScheduler 按依赖和并发执行
  -> Synthesizer 汇总
```

原则：

- Planner 输出是分工来源。
- 系统代码只校验 schema、权限、Agent 是否存在、依赖是否合法。
- 不允许关键词路由、自动 Researcher 注入、自动 QA/review/follow-up 任务覆盖模型计划。

当前差距：

- checkpoint/resume 还不够强。
- 取消、暂停、重试、跳过、改派需要形成统一 Run lifecycle。
- Planner 输出失败时应透明报错或重试，不应伪造静态计划。

## 3. 通信协议层

业内优秀形态：

- A2A：适合标准化 Agent 间 message、task、artifact、context。
- AG-UI：适合把运行事件标准化给前端，例如 run started、step started、tool call、artifact、run finished。
- MCP：适合把工具、资源、prompt 暴露给模型/Agent 使用。

AgentHub 当前设计：

```text
A2A message/send envelope
  -> LocalA2ATransport
  -> runAgentReply
  -> runtimeRegistry
  -> code-agent / llm
```

原则：

- Orchestrator 发给成员的任务必须先成为 A2A envelope。
- 子对话 user message metadata 保存 A2A 请求。
- 成员输出保存 A2A response message/task。
- Blackboard 和 handoff 是 AgentHub 对 A2A artifact/metadata 的扩展。
- 当前是内部 A2A envelope + local transport，不是完整远程 A2A server network。

当前差距：

- 远程 A2A endpoint 还没有形成完整接入闭环。
- AG-UI 目前是事件映射，不是完整 runtime。
- 前端还需要完全以 run events 驱动任务状态。

## 4. Agent 身份层

业内优秀形态：

- Claude Code subagents：角色、独立上下文、工具权限。
- OpenAI Agents SDK：Agent instruction、tools、handoff。
- CrewAI：Agent role、goal、backstory、tools。

AgentHub 当前设计：

```text
Agent = Coding Agent 基底
      + 名称/角色/说明
      + system prompt
      + Skills/MCP/Rules
      + tool permissions
      + sandbox policy
      + context policy
```

允许的 runtime 身份：

- `code-agent`：主路径，映射到 Codex CLI、Claude Code、OpenCode、Gemini CLI。
- `llm`：内部/兜底路径。

不允许的 runtime 身份：

- `a2a`：协议，不是 Agent 类型。
- `mcp`：能力层，不是 Agent 类型。
- `skill`：能力包，不是 Agent 类型。

## 5. 执行运行时层

业内优秀形态：

Coding Agent 产品的关键不是只调模型，而是能安全地读写文件、运行命令、调用工具、保留产物、处理中断。

AgentHub 当前设计：

- `code-agent-adapter.ts` 适配 Codex CLI / Claude Code / OpenCode / Gemini CLI。
- `code-agent-runtime.ts` 是统一 runtime 入口。
- `AGENTHUB_CODE_AGENT_TIMEOUT_MS` 开发期建议为 600000。
- CLI 失败但产出文件时，任务状态可以失败，但必须显示“部分产物已保留”。

当前差距：

- 需要更强的进程生命周期管理：PID 记录、停止、强杀、重启清理、stale run 扫描。
- 需要更细的失败分类：模型配置、鉴权、网络、构建、验证、超时、权限。
- 子对话应持续展示 CLI 真实执行状态，而不是只等最终消息。

## 6. 能力工具层

业内优秀形态：

- MCP：server 暴露 tools、resources、prompts。
- Skills：把某类任务的方法论、脚本、资源打包给 Agent。
- Rules：约束 Agent 行为、权限和项目规范。

AgentHub 当前设计：

- MCP/Skills/Rules 挂在 Code Agent profile 上。
- 不作为独立 Agent 类型展示。
- 不应该单独出现在 Planner 的 runtime 选择中。

当前差距：

- Agent 创建和编辑页需要更完整地管理 Skills/MCP。
- 执行时需要把所选 Skills/MCP 注入对应 CLI 配置。
- UI 需要展示 Agent 本次使用过哪些工具能力。

## 7. 工作区、黑板与产物层

业内优秀形态：

成熟多 Agent 系统一定有共享状态和产物层。LangGraph 使用图状态，A2A 使用 artifact，Coding Agent 产品通常使用真实工作目录。

AgentHub 当前设计：

```text
{projectRoot}/.agenthub/
  workdirs/{runId}/{agentName}/{taskId}/
  handoff/{runId}/{taskId}/
```

规则：

- 写入型 Agent 在自己的 workdir 执行。
- 上游可交接文件复制到 handoff。
- 下游优先读取黑板中的 `handoffPath`。
- `filePath/path` 只是记录，不能假设它存在于当前 workdir。

当前差距：

- 产物 source of truth 需要进一步统一。
- artifact card、task artifacts、message metadata、blackboard artifact ref 应互相可追踪。
- 需要清楚显示失败任务的部分产物。

## 8. 可观测与事件层

业内优秀形态：

- OpenAI Agents SDK：trace 记录 Agent、handoff、tool 调用。
- AG-UI：标准化 run/step/tool/artifact events。
- LangGraph/Microsoft：workflow state 和 checkpoint 可回放。

AgentHub 当前设计：

- `orchestrator_run_events` 记录 run/task/artifact/blackboard 事件。
- `ag-ui-adapter.ts` 把内部事件映射为 AG-UI 风格事件。
- WebSocket 把事件广播给前端。

当前差距：

- 前端还需要完全从事件流更新任务看板和子对话入口。
- 每个 run 需要可打开的 trace 页面。
- 需要记录耗时、token、成本、失败类别、CLI 命令摘要。

## 9. 人工介入层

业内优秀形态：

成熟系统支持用户在关键点暂停、批准、拒绝、补充信息、重试、改派、恢复。

AgentHub 当前设计：

- 已有用户确认/分发的入口。
- 已有取消信号和部分 shutdown cleanup。

当前差距：

- 执行中暂停/恢复还不完整。
- 任务级重试、跳过、改派需要前后端闭环。
- 用户补充信息应能进入对应 child session，并被 Orchestrator 纳入重新规划。

## 对业内方案的取舍

| 方案 | 值得学习 | 不应照搬 |
| --- | --- | --- |
| WorkBuddy / Kimi 群聊 | IM 体验、状态可见、成员产物可进 | 不要只做表演式群聊 |
| Claude Code subagents | 专家角色、独立上下文、工具权限 | 不要只局限在单 CLI 内 |
| LangGraph | DAG、状态、handoff、checkpoint | 不要把 AgentHub 变成纯后端图框架 |
| Microsoft Agent Framework | workflow、checkpoint、interrupt/resume | 不要牺牲 IM 产品体验 |
| OpenAI Agents SDK | handoff、guardrails、tracing | 不要把所有执行体退化成普通 LLM |
| CrewAI | Agent/Task/Crew 抽象易理解 | 不要恢复固定团队模板和静态分工 |
| A2A | 标准化 Agent 通信 | 不要把 A2A 当 Agent 类型 |
| AG-UI | 标准化前端运行事件 | 不要把它当编排器 |
| MCP | 标准化工具/资源/Prompt | 不要把 MCP 当 runtime |

## 下一阶段优先级

1. Run lifecycle：统一启动、取消、停止、重试、恢复、stale cleanup、PID 记录。
2. Event-driven UI：任务看板、子对话入口、产物卡全部由 run events 和真实 task state 驱动。
3. Checkpoint/resume：让 DAG、任务状态、child session、blackboard、artifact ref 可恢复。
4. Skills/MCP 闭环：Agent 配置、执行注入、工具调用展示、权限管理。
5. Trace 页面：从一次协作 run 反查所有任务、事件、产物、错误和耗时。

## 判断准则

新增设计如果符合以下判断，通常是正确方向：

- 用户能看见真实执行过程，而不是 Orchestrator 口头声称别人参与。
- Agent 间任务是 A2A envelope，而不是隐藏的第二套协议。
- 分工来自 Orchestrator/Planner，不来自静态关键词。
- Code Agent 是主执行体，LLM 是内部/兜底。
- MCP/Skills 增强 Code Agent 能力，不制造新 Agent 类型。
- 任务失败也能保留和展示部分产物。
- 用户可以停止、重试、进入子对话、查看 trace。
