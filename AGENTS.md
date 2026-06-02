# AgentHub

本文档给 AI Coding Agent 阅读。人类开发者可以先看 `README.md`，再看 `docs/当前状态与下一步路线.md`、`docs/当前多Agent协作架构.md`、`docs/场景角色团队协作调研.md`、`docs/角色提示词与动态组队设计.md`、`docs/专家库与开源角色Skill生态调研.md`、`docs/SpecKit契约与AGUI事件落地路线.md` 和 `docs/使用指南.md`。
更完整的分层设计和业内方案对比见 `docs/多Agent协作分层架构与业内对比.md`。

## 当前目标

AgentHub 是一个 IM 式多 Agent 协作平台，也是字节跳动 AI 全栈挑战赛项目。核心体验不是“一个模型假装多人说话”，而是：

- 用户在群聊里提出复杂目标。
- Orchestrator 先理解任务、生成动态 DAG 计划。
- 多个 Agent 在各自的任务子对话里真实执行。
- 主群聊只展示计划、进度、成员汇报、产物和最终综合结果。
- 用户可以进入任一子对话查看该 Agent 的完整执行过程。

不要再引入固定场景模板，例如“网站建设 Team 模板”。当前优先做通用多 Agent 协作能力，场景增强放到后续。

角色预设可以作为“创建 Agent 时的参考库”存在，但不能作为默认团队、默认关系或执行模板自动驱动运行。新工作区默认不自动注入 Orchestrator/Researcher/Designer/Builder/QA，也不支持 `classic` 团队模板或 `create-from-template` 入口。

角色设计要按 `docs/角色提示词与动态组队设计.md` 的组合模型推进：公共协作协议 + 角色背景 + 专属 Skill 包 + 任务上下文 + 输出契约。群聊目标可以用于智能推荐成员，但不能变成固定模板；已有群聊能力不足时，Orchestrator 可以提出补员申请，默认必须用户确认，不能静默拉新 Agent。

预装 Agent 模板和轻量专家团建议见 `docs/专家库与开源角色Skill生态调研.md`。可以借鉴 Claude Code subagents、BMAD、SuperClaude、awesome-cursor-skills、MCP server 生态等开源资产，但必须经过许可证、安全边界、质量和 AgentHub schema 适配；近期不做“我的专家”或完整专家市场，不要直接复制未审计 prompt 或默认启用第三方 MCP。

## 分层架构判断

修改代码前先确认自己正在改的是哪一层，不要把不同层的概念混用：

- 产品交互层：IM 群聊、Agent 私聊、任务子对话、任务看板、产物卡。
- 编排层：Orchestrator、Planner、DAG、TaskScheduler、Synthesizer、人工确认和运行生命周期。
- 通信协议层：A2A 负责 Agent 间 message/task/artifact 语义；AG-UI 负责运行事件到前端 UI 的桥接。
- 执行层：Codex CLI、Claude Code、OpenCode、Gemini CLI 是主要 Agent 基底；`llm` 只作为内部/兜底能力。
- 能力层：MCP、Skills、Rules、shell、文件系统、浏览器等是 Code Agent 能使用的工具能力，不是 Agent 类型。
- 工作区与状态层：系统默认工作空间根、`.agenthub/workdirs`、`.agenthub/handoff`、blackboard、execution logs、run events。

配置真相也要分层：

- `模型管理`：模型目录、端点、密钥、模型测试。
- `Coding Tools`：CLI 安装状态、原生 auth/config、平台级诊断。
- `Agent 配置`：唯一允许选择 `code agent × model × skills × sandbox` 组合的地方。

`内部 LLM 默认模型` 必须保持可见，且只作用于欢迎页动态提示、Orchestrator、Planner、Synthesizer 等内部模型链路。

AgentHub 不应该变成纯 CrewAI 式固定角色任务模板，也不应该直接变成只有后端图编排的 LangGraph wrapper。当前产品目标是：用 IM 产品体验承载多 Coding Agent 协作，用 DAG/checkpoint/event trace 等工程能力保证它可信、可看、可控。

## 关键交互边界

### 单聊

`direct + metadata.kind === "agent-direct"` 是全局 Agent 私聊，只出现在左侧“Agent 私聊”区域。

### 群聊

`group` 是用户和 Orchestrator/成员的主对话。主对话负责：

- 接收用户目标。
- 展示 Orchestrator 的思考、计划和调度状态。
- 展示成员任务结果汇报。
- 展示产物卡、任务看板、最终总结。

### 任务子对话

`direct + metadata.kind === "orchestrator-task"` 是群聊下的真实任务子对话。它必须：

- 绑定 `workspaceId`、`workspaceAgentId`、`orchestratorRunId`、`orchestratorTaskId`。
- 在左侧群聊展开后作为子项显示。
- 不出现在全局“Agent 私聊”里。
- 保存 Orchestrator 发给该 Agent 的任务提示和 Agent 真实输出。

### 已废弃入口

旧的 `workspace-agent-child`、`workspace / Agent` 历史子会话、自动补齐“未开始子会话”的 UI 都不再作为当前设计入口。不要恢复这类占位子会话，否则会造成左侧重复和真假执行混乱。

## 当前执行路径

```text
用户在群聊发消息
  -> messages.ts 判断意图
  -> 简单聊天：Orchestrator 直接回复
  -> 能力不足：Orchestrator 返回结构化 memberProposals，主群聊展示补员卡，用户确认后才创建/加入真实 Agent
  -> 复杂任务：生成动态计划和任务看板
  -> 用户确认/分发
  -> OrchestratorEngine.dispatch()
  -> Planner 生成或整理 DAG
  -> TaskScheduler 按依赖层调度
  -> 每个任务创建 orchestrator-task 子对话
  -> Orchestrator 将任务封装为 A2A message/send envelope
  -> TaskExecutionService 准备工作目录并经 LocalA2ATransport 派发
  -> 本地执行宿主适配到 LLM fallback / Code Agent
  -> 子对话保存完整过程
  -> 黑板写入任务摘要、产物、决策和 handoff（作为 A2A artifact metadata 扩展）
  -> 主群聊广播成员汇报和产物卡
  -> Synthesizer 生成最终总结
```

## A2A 通信边界

Agent 之间的任务分发统一以 A2A v0.3 `message/send` 为内部通信标准：

- Orchestrator 发给成员的任务必须先构造成 A2A `MessageSendParams`。
- 子对话中的 user message metadata 必须保存 `a2a` 请求信封。
- 成员输出消息 metadata 必须保存 A2A `responseMessage` 或 `responseTask`。
- 本地 LLM fallback 和 Code Agent 都通过 `agenthub-local` transport 承接 A2A envelope。
- A2A 是通信协议，不是 runtimeType；远程 A2A endpoint 应通过 `roleProfile.protocol = "a2a"` + `roleProfile.a2aEndpoint` 配置。
- `blackboard` 和 `.agenthub/handoff` 是 AgentHub 对 A2A artifact/metadata 的扩展，不是绕过 A2A 的第二套分工协议。

当前实现是“内部 A2A envelope + AgentHub local transport”。远程 A2A endpoint 可作为后续协议配置扩展，但不能恢复 `runtimeType = "a2a"`，也不能把 A2A 作为可创建的 Agent 类型展示给用户。

相关文件：

- `apps/server/src/services/protocols/a2a-internal.ts`: 内部 A2A envelope、message 和 task 映射。
- `apps/server/src/services/execution/local-a2a-transport.ts`: 本地 A2A transport，负责把 `message/send` 派发到本地 runtime。
- `apps/server/src/services/protocols/a2a-adapter.ts`: 对外 A2A AgentCard / Task / Artifact 映射。

## 工作目录与产物交接

当前不追求复杂 Git worktree 隔离，先保证“能干活、能看见产物、能接力”。

- 如果用户选择了项目工作区，AgentHub 使用该目录作为项目根。
- 写入型 Agent 会在项目根下创建 `.agenthub/workdirs/{runId}/{agentName}/{taskId}`。
- 每个 Agent 在自己的任务目录中执行，避免互相踩文件。
- 如果用户没有选择项目工作区，自动工作空间默认创建在系统用户数据目录下，例如 `%LOCALAPPDATA%\AgentHub\workspaces`，不能回落到 AgentHub 源码目录。
- 每个任务还会有自己的本地 sandbox root，位于系统缓存目录下的 `AgentHub/sandboxes/{runId}/{agentName-agentId}/{taskId}`，用于隔离 CLI 的 temp/cache/config 目录。
- 执行隔离通过 `SandboxProvider` 抽象承载；当前默认 provider 是 `docker-sandbox`，`local-workdir` 只作为兼容降级路径。`local-workdir` 会硬化本地 workdir、temp/cache/config env 和进程生命周期，但不会提供真正的 OS 网络或文件权限沙箱。
- 上游可交接文件会复制到 `.agenthub/handoff/{runId}/{taskId}/...`。
- 下游 Agent 只能优先读取黑板中明确给出的 `handoffPath`。
- 如果黑板只有 `filePath/path`，那只是上游记录，不能假设它存在于当前执行目录。

不要让下游 Agent 读取自己目录里臆造的相对路径，例如 `design/website-design-spec.md`，除非该文件真实存在或黑板给出 `handoffPath`。

## Code Agent 适配

统一入口在 `apps/server/src/services/code-agent-adapter.ts` 和 `apps/server/src/services/runtime/code-agent-runtime.ts`。

支持的本地 CLI：

- Codex CLI
- Claude Code
- OpenCode
- Gemini CLI

注意：

- 失败提示必须使用实际 adapter 名称，不要把 OpenCode 的错误写成 Codex CLI。
- CLI 可能已经生成了部分文件，但最后因为构建、验证、模型或 Base URL 失败而返回失败状态。此时要显示“部分产物已保留”，不要说“没有任何产物”。
- `AGENTHUB_CODE_AGENT_TIMEOUT_MS` 默认建议为 `600000`，即十分钟。
- MCP、Skills、Rules 是 Code Agent 的能力层，不是独立 runtimeType。
- Code Agent 的用户可选沙箱只保留 `workspace-write` 和 `danger-full-access`；不要再恢复 `read-only` 作为公开 code-agent 配置项。

“支持用户自建 Agent”指的是用户在这些 Coding Agent 基底上创建专家角色：设置名称、角色说明、系统提示词、工具权限、Skills/MCP 能力、沙箱策略和上下文策略。不要把它理解成新增一个普通 LLM 类型的聊天机器人。

## 数据模型要点

主要表：

- `sessions`: `direct` / `group` 会话，依赖 `metadata.kind` 区分私聊、群聊任务子对话和旧会话。
- `messages`: 聊天消息、任务结果消息、产物 metadata。
- `workspaces`: 项目工作区。
- `workspace_agents`: 工作区成员。
- `workspace_tasks`: DAG 任务、状态、进度、子会话、产物。
- `orchestrator_runs`: Orchestrator 调度生命周期。
- `blackboard_entries`: Agent 之间共享的结构化黑板。
- `execution_logs`: 执行追踪、工具调用、错误和 token 记录。

## 前端会话树规则

相关文件：

- `apps/web/src/lib/sessionTree.ts`
- `apps/web/src/components/chat/SessionList.tsx`
- `apps/web/src/stores/chatStore.ts`
- `apps/web/src/lib/ws.ts`

规则：

- “Agent 私聊”只显示 `agent-direct`。
- “群聊”显示 group parent。
- 群聊展开后只显示真实 `orchestrator-task` 子对话。
- 不再自动补齐 workspace member 占位入口。
- 不再显示 `workspace-agent-child` 旧设计入口。
- WebSocket 需要同时订阅主群聊和当前子对话，避免进度丢失。

## 常用命令

```bash
bun install
bun run dev
bun run dev:server
bun run dev:web
bun run typecheck
bun --filter @agenthub/server typecheck
bun --filter @agenthub/web typecheck
bun test
bun test tests/orchestrator-routing.test.ts
```

## 开发约束

- 新增路由使用 `AppError`，不要继续新增裸 `HTTPException`。
- 日志使用 `apps/server/src/lib/logger.ts`，不要新增 `console.log`。
- 对复杂目标的意图判断、分工、追加任务和最终内容生成必须来自 Orchestrator/Planner/Synthesizer 的模型输出；系统代码只做 schema 校验、权限校验、状态记录和透明错误呈现。
- Orchestrator 决策输出解析失败时要透明报错或提示检查模型配置，不允许用关键词启发式兜底成 `plan/reply/clarify`。
- 运行中补员只能来自 Orchestrator 明确输出的 `memberProposals`；前端只展示确认卡，后端只按用户确认创建/加入真实 workspace agent。
- 不要恢复静态兜底提示词或固定模板计划。快速提示、任务拆解、协作计划都应由模型动态生成；失败时可以提示用户重试或检查模型配置。
- 不要恢复静态 Agent 路由、关键词分工、自动 Researcher 注入、自动 QA/review/follow-up 任务注入。系统只能校验 Orchestrator/Planner 的显式选择，不能偷偷改派或追加任务。
- 不要恢复内置 `.agenthub/specs/*.spec.yml` 场景模板，也不要让 `ensureHarnessPresets()` 把 specs 自动复制到新工作区。Spec 后续只可作为用户显式创建的协作契约。
- 不要把旧 `GroupChatManager` 作为新路径入口。群聊统一从 `messages.ts` 进入 Orchestrator 路由。
- 不要把旧 Git 分支隔离写成当前默认事实。当前默认是项目工作区 + `.agenthub/workdirs` + `.agenthub/handoff`。
- 修改 UI 时要保持 IM 产品感：左侧树清晰、主群聊和子对话不重复、运行状态可见、产物入口明确。

## 重要文件

- `apps/server/src/routes/messages.ts`: 消息入口、意图判断、计划生成和分发入口。
- `apps/server/src/services/orchestrator/orchestrator-engine.ts`: Orchestrator 总控。
- `apps/server/src/services/orchestrator/planner.ts`: 动态 DAG 计划。
- `apps/server/src/services/orchestrator/task-scheduler.ts`: DAG 调度。
- `apps/server/src/services/execution/task-execution-service.ts`: 任务执行服务。
- `apps/server/src/services/execution/agent-workdir.ts`: Agent 工作目录。
- `apps/server/src/services/blackboard.ts`: 黑板。
- `apps/server/src/services/code-agent-adapter.ts`: CLI 适配。
- `apps/web/src/components/chat/TaskBoard.tsx`: 任务看板。
- `apps/web/src/components/chat/SessionList.tsx`: 左侧会话树。
- `apps/web/src/stores/chatStore.ts`: 聊天状态和 WS 事件消费。
