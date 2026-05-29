# AgentHub 架构重构：统一执行流 + 任务看板 + Agent 自主性 Spec

## Why

当前 AgentHub 存在六大架构问题，在"做深圳技术大学介绍网站"这类复杂场景下体验割裂：两条执行路径（GroupChatManager 对话循环 vs Plan Card DAG）让用户困惑；静态 Plan Card 无实时进度；Agent 被动执行无自主权；上下文混在一起不隔离；Plan 生成同步阻塞；Run 状态重启丢失。讯飞 AstronClaw 和 Kimi Claw 的经验表明：一条连贯路径 + 实时任务看板 + Agent 自主性是成熟多 Agent 产品的核心体验。

## What Changes

- **BREAKING**: 废弃 GroupChatManager 的 `conversationLoop()`（群聊多轮对话循环），统一为单入口 + 任务看板模式
- Plan 生成异步化：HTTP 立即返回 "正在分析..."，后台 LLM 生成后 WebSocket 推送
- Run 状态全量持久化到 DB，服务重启后可恢复未完成的 Run
- 新增实时任务看板（TaskBoard）替代静态 Plan Card，WebSocket 实时推送每个 Task 的状态变化
- Agent 获得自主权：可提问（`[CLARIFY]`）、拒绝（`[REJECT]`）、报告进度（`[PROGRESS]`）
- Task 上下文隔离：每个 Task 通过独立 child session + Blackboard 结构化传递，而非全量历史拼接
- 前端布局：群聊页面右侧新增任务看板面板（聊天流 + 看板并排）
- 数据库扩展：新增 `task_clarifications` 表、`orchestrator_run_controls` 表，扩展 `workspace_tasks` 字段

## Impact

- Affected specs: unify-orchestration-flow（扩展已完成的 IntentRouter 引入），add-collaboration-modes（无冲突）
- Affected code:
  - `apps/server/src/routes/messages.ts` — 消息入口重构，新增 `handleSimpleReply`、`handleComplexTask`、`generatePlanAndPush`
  - `apps/server/src/services/group-chat/group-chat-manager.ts` — 废弃 `conversationLoop()`，保留 `@mention` 提取工具函数
  - `apps/server/src/services/orchestrator/orchestrator-engine.ts` — 重写 `executeTask()` 支持 Agent 自主性，重写 `buildTaskPrompt()` 实现上下文隔离，新增 `resumeRun()` 持久化恢复
  - `apps/server/src/services/orchestrator/planner.ts` — Plan 生成异步化改造
  - `apps/server/src/services/orchestrator/types.ts` — 新增 Agent 自主性类型
  - `apps/server/src/services/agent-runner.ts` — 新增 `requestUserClarification()` 用户暂停等待机制
  - `apps/server/src/index.ts` — 启动时恢复所有 running 状态的 Run
  - `packages/shared/src/constants.ts` — 新增 `task_board:*` WebSocket 事件
  - `packages/db/src/schema.ts` — 新增表 + 扩展字段
  - `apps/web/src/components/TaskBoard.tsx` — 新增实时任务看板组件（**NEW**）
  - `apps/web/src/components/ClarificationCard.tsx` — 新增 Agent 提问交互组件（**NEW**）
  - `apps/web/src/pages/WorkspaceChatPage.tsx` — 新增群聊 + 看板布局页面（**NEW**）
  - `apps/web/src/components/assistant-ui/Thread.tsx` — 用 TaskBoard 替换 Plan Card，集成 ClarificationCard
  - `apps/web/src/stores/chatStore.ts` — 消费 `task_board:*` WebSocket 事件
  - `apps/web/src/lib/runtime.tsx` — 检测 `task_board` 消息类型
  - `apps/web/src/App.tsx` — 新增 WorkspaceChatPage 路由

## ADDED Requirements

### Requirement: Plan 生成异步化
系统 SHALL 在用户发送复杂任务消息后立即返回 HTTP 200，后台异步调用 LLM 生成 Plan，完成后通过 WebSocket `task_board:plan_ready` 事件推送到前端。

#### Scenario: 用户发复杂任务立即得到反馈
- **WHEN** 用户发送"做一个介绍深圳技术大学的网站"
- **THEN** 系统立即返回 "🔍 正在分析任务，生成执行计划..." 消息，不阻塞等待 LLM

#### Scenario: Plan 生成完成后推送
- **WHEN** 后台 LLM 完成 Plan 生成
- **THEN** WebSocket 推送 `task_board:plan_ready` 事件，包含 runId 和完整 plan 数据

#### Scenario: Plan 生成失败降级
- **WHEN** LLM 调用失败或超时
- **THEN** 更新占位消息为 "❌ 计划生成失败，请重试"，并使用 fallback 模板（Architect → Coder → Reviewer）

### Requirement: Run 状态持久化与恢复
系统 SHALL 将 Orchestrator Run 的全生命周期状态持久化到 `orchestrator_runs` 表和 `orchestrator_run_events` 表，支持服务重启后恢复未完成的 Run。

#### Scenario: 服务重启后恢复 Run
- **WHEN** 服务器重启后存在 `status=running` 的 Run
- **THEN** 系统自动从 DB 恢复引擎实例，将 `running` 状态的 Task 重置为 `pending`，继续调度执行

#### Scenario: 正常执行中状态持久化
- **WHEN** Task 状态变化（pending → running → done/failed）
- **THEN** 同步更新 `workspace_tasks.status` 和 `orchestrator_runs.plan` 中的 progress ledger

### Requirement: 实时任务看板
系统 SHALL 提供实时任务看板替代静态 Plan Card，通过 WebSocket 推送每个 Task 的状态变化。

#### Scenario: 任务看板初始化
- **WHEN** 前端收到 `task_board:plan_ready` 事件
- **THEN** 展示任务看板，包含阶段列表、每个阶段的 Task、依赖关系、状态指示

#### Scenario: 任务状态实时更新
- **WHEN** 后端 Task 状态变化（started/completed/failed/progress）
- **THEN** 前端任务看板实时更新对应 Task 的状态图标、进度百分比、摘要

#### Scenario: 任务看板控制操作
- **WHEN** 用户点击任务看板上的"暂停"按钮
- **THEN** 调用 `POST /orchestrator-runs/:id/cancel` 暂停 Run

### Requirement: Agent 自主性 —— 提问
Agent SHALL 能够在执行过程中向用户提问，系统暂停该 Task 等待用户回答后继续。

#### Scenario: Agent 信息不足时提问
- **WHEN** Agent 检测到任务描述缺少关键信息（如配色偏好、技术栈选择）
- **THEN** Agent 在回复中使用 `[CLARIFY]` 标记提问，系统暂停 Task，前端展示交互式问答卡片

#### Scenario: 用户回答后 Agent 继续执行
- **WHEN** 用户回答了 Agent 的澄清问题
- **THEN** 系统将答案注入 Task prompt，Agent 从暂停处继续执行

#### Scenario: 用户超时未回答
- **WHEN** Agent 提问后 5 分钟内用户未回答
- **THEN** Task 标记为 failed，原因："用户超时未回复"

### Requirement: Agent 自主性 —— 拒绝
Agent SHALL 能够拒绝不适合自己的任务，系统自动尝试切换到 fallback Agent。

#### Scenario: Agent 拒绝不合适的任务
- **WHEN** Agent 判断任务超出自己能力范围（如 Reviewer 被分配了编码任务）
- **THEN** Agent 使用 `[REJECT]` 标记拒绝，系统查找 fallback Agent 重新执行

#### Scenario: 无可用 fallback Agent
- **WHEN** Agent 拒绝且无 fallback Agent 可用
- **THEN** Task 标记为 failed，错误信息包含拒绝原因

### Requirement: Agent 自主性 —— 进度报告
Agent SHALL 能够在执行长任务时主动报告进度百分比。

#### Scenario: Agent 报告进度
- **WHEN** Agent 在执行中输出 `[PROGRESS: N%] 当前状态`
- **THEN** 系统解析进度百分比，更新 `workspace_tasks.progress_percent` 并通过 WebSocket 推送到前端任务看板

### Requirement: Task 上下文隔离
每个 Task SHALL 使用独立的 child session 执行，通过 Blackboard 结构化传递上游产出，而非拼接全量聊天历史。

#### Scenario: Task 获得上游结构化产出
- **WHEN** Task B 依赖 Task A（A 已完成）
- **THEN** Task B 的 prompt 包含：用户总目标 + 自己的任务描述 + Task A 在 Blackboard 中的 `task_output`、`decisions`、`artifacts` 条目（每条截断到 500 字符）

#### Scenario: Task 不看到无关历史
- **WHEN** Task 开始执行
- **THEN** Task 的 prompt 不包含其他不相关 Task 的完整输出或群聊中的闲聊消息

### Requirement: 前端布局 —— 群聊 + 看板并排
群聊页面 SHALL 在有活跃 Orchestrator Run 时展示左侧聊天流 + 右侧任务看板的并排布局。

#### Scenario: 有活跃 Run 时展示看板
- **WHEN** 当前群聊会话有活跃的 Orchestrator Run
- **THEN** 右侧展示 384px 宽的任务看板面板，左侧聊天流自动缩窄

#### Scenario: 无活跃 Run 时全宽聊天
- **WHEN** 当前群聊会话无活跃 Run
- **THEN** 聊天流占满全宽，不展示任务看板

## MODIFIED Requirements

### Requirement: 统一消息入口
`POST /:sessionId` 的消息入口 SHALL 不再分流到 GroupChatManager 对话循环。简单消息由 Orchestrator 单 Agent 回复，复杂消息进入异步 Plan → 任务看板 → DAG 执行流程。`@mention` 消息直接路由到指定 Agent。

#### Scenario: 简单消息直接回复
- **WHEN** 用户在群聊中发送简单消息（IntentRouter 判定为 ConversationLoop）
- **THEN** Orchestrator Agent 单次 `runAgentReply` 直接回复，不生成 Plan、不展示看板

#### Scenario: 复杂消息异步编排
- **WHEN** 用户在群聊中发送复杂消息（IntentRouter 判定为 OrchestratorPlan）
- **THEN** 立即返回 HTTP 200，后台异步生成 Plan → WebSocket 推送任务看板 → 用户可确认执行

#### Scenario: @mention 直接路由
- **WHEN** 用户在群聊中 @特定 Agent
- **THEN** 直接路由到该 Agent 的 child session 执行 `runAgentReply`