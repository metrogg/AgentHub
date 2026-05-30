# AgentHub

本文档给 AI Coding Agent 阅读。人类开发者可以先看 `README.md`，再看 `docs/当前多Agent协作架构.md` 和 `docs/使用指南.md`。

## 当前目标

AgentHub 是一个 IM 式多 Agent 协作平台，也是字节跳动 AI 全栈挑战赛项目。核心体验不是“一个模型假装多人说话”，而是：

- 用户在群聊里提出复杂目标。
- Orchestrator 先理解任务、生成动态 DAG 计划。
- 多个 Agent 在各自的任务子对话里真实执行。
- 主群聊只展示计划、进度、成员汇报、产物和最终综合结果。
- 用户可以进入任一子对话查看该 Agent 的完整执行过程。

不要再引入固定场景模板，例如“网站建设 Team 模板”。当前优先做通用多 Agent 协作能力，场景增强放到后续。

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
  -> 复杂任务：生成动态计划和任务看板
  -> 用户确认/分发
  -> OrchestratorEngine.dispatch()
  -> Planner 生成或整理 DAG
  -> TaskScheduler 按依赖层调度
  -> 每个任务创建 orchestrator-task 子对话
  -> TaskExecutionService 准备工作目录
  -> AgentRuntime 调用 LLM / Code Agent / Native Tool
  -> 子对话保存完整过程
  -> 黑板写入任务摘要、产物、决策和 handoff
  -> 主群聊广播成员汇报和产物卡
  -> Synthesizer 生成最终总结
```

## 工作目录与产物交接

当前不追求复杂 Git worktree 隔离，先保证“能干活、能看见产物、能接力”。

- 如果用户选择了项目工作区，AgentHub 使用该目录作为项目根。
- 写入型 Agent 会在项目根下创建 `.agenthub/workdirs/{runId}/{agentName}/{taskId}`。
- 每个 Agent 在自己的任务目录中执行，避免互相踩文件。
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
- 不要恢复静态兜底提示词或固定模板计划。快速提示、任务拆解、协作计划都应由模型动态生成；失败时可以提示用户重试或检查模型配置。
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
