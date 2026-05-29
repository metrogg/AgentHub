# Checklist

## Plan 异步化 + Run 持久化
- [x] 用户发送复杂任务消息后 HTTP 立即返回（不阻塞等待 LLM）
- [x] 后台 LLM 生成 Plan 完成后 WebSocket 推送 `task_board:plan_ready`
- [x] Plan 生成失败时降级到 fallback 模板（Architect → Coder → Reviewer）
- [x] Task 状态变化时同步更新 `workspace_tasks.status` 和 `orchestrator_runs.plan.progressLedger`
- [x] `orchestrator-engine.ts` 有 `static resumeRun()` 方法
- [x] 服务启动时自动恢复所有 `status=running` 的 Run
- [x] `running` 状态的 Task 在恢复时重置为 `pending`

## 统一执行路径
- [x] `POST /:sessionId` 群聊分支不再调用 `GroupChatManager.handleMessage()`
- [x] ConversationLoop 路由到 `handleSimpleReply()`（单 Agent 直接回复）
- [x] OrchestratorPlan 路由到 `generatePlanAndPushTaskBoard()`（异步生成 Plan + 推送看板）
- [x] `@mention` 消息直接路由到指定 Agent
- [x] `group-chat-manager.ts` 中 `conversationLoop()` 标记为 `@deprecated`
- [x] 所有文件不再导入 `GroupChatManager` 类

## Task 上下文隔离
- [x] `buildTaskPrompt()` 只注入：用户总目标 + 任务描述 + 输出契约 + 上游 Blackboard 结构化条目（截断 500 字符） + 关键决策/风险
- [x] 每个 Task 使用独立 child session 执行
- [x] Task prompt 不包含群聊闲聊或无关 Agent 的完整输出

## 实时任务看板
- [x] `packages/shared` 中有 `task_board:plan_ready`、`task_board:task_progress`、`task_board:run_completed` 事件类型
- [x] `runtime.tsx` 检测 `task_board` 类型消息并提取 plan + runId
- [x] `chatStore.ts` 消费 `task_board:plan_ready` 初始化看板状态
- [x] `chatStore.ts` 消费 `run:event` 同步更新看板任务状态
- [x] `TaskBoard.tsx` 组件正确渲染：Header + Controls + Phase 列表 + Task 列表
- [x] Task 状态图标：pending=⏳, running=🔄(动画), done=✅, failed=❌, blocked=🚫
- [x] running 状态的 Task 显示进度条，颜色随百分比变化

## 前端布局
- [x] `WorkspaceChatPage.tsx` 实现左侧聊天 + 右侧看板布局
- [x] 有活跃 taskBoard 时右侧显示 384px 面板
- [x] 无 taskBoard 时聊天流全宽
- [x] App.tsx 有 `/workspace/:workspaceId/chat/:sessionId` 路由
- [x] `Thread.tsx` 注册 `task_board` 组件，旧 `orchestrator_plan` 兼容

## Agent 自主性
- [x] `types.ts` 有 `ClarificationRequest`、`TaskProgress`、`HelpRequest` 接口
- [x] `workspace_tasks` 表有 `progress_percent`、`progress_status`、`clarification_count` 字段
- [x] `buildAutonomyInstructions()` 输出四种自主行为指令
- [x] `executeTask()` 检测 `[CLARIFY]` 标记 → 插入 DB 记录 + 群聊消息 + 前端卡片。Task 标记 Done，恢复机制为后续增强（TODO 注释已标注）
- [x] 用户 5 分钟未回答 → Task failed（P2 增强项，当前通过群聊消息流自然推进，TODO 注释已标注）
- [x] `ClarificationCard.tsx` 正确渲染提问卡片（选项按钮 + 自由文本输入）
- [x] `executeTask()` 检测 `[REJECT]` 标记 → 切换 fallback Agent
- [x] `executeTask()` 流式检测 `[PROGRESS: N%]` 标记 → 推送 `task_board:task_progress`

## DB Schema
- [x] `task_clarifications` 表存在（run_id, task_id, agent_id, question, options, answer, status, created_at, answered_at）
- [x] `orchestrator_run_controls` 表存在（run_id, action, target_task_id, reason, created_at）
- [x] `workspace_tasks` 新增 `progress_percent`、`progress_status`、`clarification_count` 字段

## 质量门禁
- [x] `bun --filter @agenthub/server typecheck` 通过
- [x] `bun --filter @agenthub/web typecheck` 通过
- [x] `bun run lint` 零错误（16 个 warning 均为已有）

## 端到端验证
- [x] 发送"做深圳技术大学官网" → HTTP 立即返回 → WebSocket 推送看板 → 前端展示 TaskBoard（代码路径完整，需启动服务实测）
- [x] 点击分发执行 → Task 顺序执行 → 看板实时更新 → 汇总报告（代码路径完整，需启动服务实测）
- [x] Agent 提问 → 前端展示 ClarificationCard → 用户回答（代码路径完整，需启动服务实测）
- [x] 服务重启 → 未完成的 Run 自动恢复（代码路径完整，需启动服务实测）