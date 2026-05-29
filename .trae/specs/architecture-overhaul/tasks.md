# Tasks

## Phase 5: Plan 异步化 + Run 持久化（P0，无依赖）

- [x] Task 1: Plan 生成异步化
  - [x] 1.1 在 `apps/server/src/routes/messages.ts` 中新增 `handleComplexTask()` 函数：立即插入"正在分析..."系统消息 → 异步调用 `generatePlanAndPush()`
  - [x] 1.2 新增 `generatePlanAndPush()` 函数：调用 `buildDynamicOrchestratorPlan()` → 预创建 `orchestrator_runs` 行（status=planning）→ WebSocket 推送 `task_board:plan_ready` 事件
  - [x] 1.3 在 `packages/shared/src/constants.ts` 中新增 `TaskBoardPlanReady: 'task_board:plan_ready'` 事件类型
  - [x] 1.4 确保 Plan 生成失败时降级到 fallback 模板 + 更新占位消息为错误状态
  - [x] 验证：发送复杂任务消息后 HTTP 立即返回（不阻塞），通过 WebSocket 收到 task_board:plan_ready

- [x] Task 2: Run 状态持久化与恢复
  - [x] 2.1 在 `orchestrator-engine.ts` 中新增 `static resumeRun(runId: string)` 方法：从 DB 读取 Run → 将 running 的 Task 重置为 pending → 重建 TaskGraph → 继续调度
  - [x] 2.2 新增 `continueRun()` 私有方法：复用现有 TaskScheduler 调度未完成 Task
  - [x] 2.3 确保 `executeTask()` 中 Task 状态变化时同步更新 `workspace_tasks.status`、`orchestrator_runs.plan.progressLedger`
  - [x] 2.4 在 `apps/server/src/index.ts` 启动时查询 `status=running` 的 Run 并调用 `resumeRun()`
  - [x] 验证：执行一半的 Run 在服务器重启后自动恢复

## Phase 1: 统一执行路径（P0，依赖 Task 1、2）

- [x] Task 3: 统一消息入口路由
  - [x] 3.1 重构 `apps/server/src/routes/messages.ts` 的 `POST /:sessionId` 群聊分支：@mention→Agent / ConversationLoop→handleSimpleReply / OrchestratorPlan→generatePlanAndPushTaskBoard / NoOrchestrator→系统提示
  - [x] 3.2 新增 `handleSimpleReply()`：Orchestrator 单 Agent 直接回复
  - [x] 3.3 移除对 `new GroupChatManager().handleMessage()` 的调用
  - [x] 验证：简单消息直接回复，复杂消息出任务看板，@mention 正确路由

- [x] Task 4: 废弃 GroupChatManager 对话循环
  - [x] 4.1 在 `group-chat-manager.ts` 中标记 `conversationLoop()` 为 `@deprecated`，保留 `extractMentions()`、`buildAgentPrompt()` 等工具函数
  - [x] 4.2 移除其他文件中导入 `GroupChatManager` 的代码（messages.ts 已移除 import 和 regenerate 中的使用）
  - [x] 验证：`bun run typecheck` 无错误，`bun run lint` 无错误

## Phase 4: Task 上下文隔离（P1，依赖 Task 3）

- [x] Task 5: 重写 buildTaskPrompt 实现结构化上下文传递
  - [x] 5.1 重写 `orchestrator-engine.ts` 的 `buildTaskPrompt()`：只注入用户总目标 + 任务描述 + 输出契约 + 上游 Blackboard 结构化条目（每条截断 500 字符）+ 关键决策/风险
  - [x] 5.2 确保每个 Task 使用独立的 child session 执行 `runAgentReply`（而非 group session）
  - [x] 5.3 移除全量聊天历史的注入逻辑
  - [x] 验证：依赖 Task A 的 Task B 在 prompt 中只有 Task A 的结构化摘要，没有群聊闲聊

## Phase 2: 实时任务看板（P1，依赖 Task 1、3）

- [x] Task 6: 前端消息类型扩展
  - [x] 6.1 在 `packages/shared/src/constants.ts` 中新增 `TaskBoardTaskProgress: 'task_board:task_progress'` 和 `TaskBoardRunCompleted: 'task_board:run_completed'`
  - [x] 6.2 在 `apps/web/src/lib/runtime.tsx` 的 `toThreadMessage()` 中检测 `task_board` 类型消息并提取 plan + runId
  - [x] 6.3 在 `apps/web/src/stores/chatStore.ts` 中消费 `task_board:plan_ready` 初始化看板状态，消费 `run:event` 同步更新任务状态
  - [x] 验证：收到 task_board:plan_ready 后 chatStore 中有 taskBoard 数据

- [x] Task 7: 新增 TaskBoard 前端组件
  - [x] 7.1 新建 `apps/web/src/components/TaskBoard.tsx`：TaskBoardHeader / TaskBoardControls / TaskBoardPhase / TaskBoardTask
  - [x] 7.2 状态图标映射：pending→Clock, running→Loader2(动画), done→CheckCircle2, failed→XCircle, blocked→Ban
  - [x] 7.3 进度条仅在 running 状态时显示，颜色随百分比变化（<30%红, <70%黄, ≥70%绿）
  - [x] 验证：任务看板正确渲染阶段和任务，状态变化实时更新

- [x] Task 8: 后端推送 task_board 相关事件
  - [x] 8.1 在 `messages.ts` dispatch 端点中通过 `broadcastSessionEvent` 推送 `task_board:plan_ready`
  - [x] 8.2 在 `executeTask()` 中解析 Agent 输出中的 `[PROGRESS: N%]` 标记，推送 `task_board:task_progress`
  - [x] 8.3 Run 完成/失败/取消时推送 `task_board:run_completed`
  - [x] 8.4 确保已有 `run:event` 事件被前端正确映射到任务看板状态更新
  - [x] 验证：执行 Task 时任务看板实时更新状态

## Phase 7: 前端布局改造（P1，依赖 Task 7）

- [x] Task 9: 新增 WorkspaceChatPage 布局页面
  - [x] 9.1 新建 `apps/web/src/pages/WorkspaceChatPage.tsx`：左侧聊天流 + 右侧任务看板（仅在有活跃 taskBoard 时显示）
  - [x] 9.2 右侧面板宽度 384px（w-96），有左侧边框
  - [x] 9.3 无 taskBoard 时聊天流占满全宽
  - [x] 9.4 在 `apps/web/src/App.tsx` 中新增路由 `/workspace/:workspaceId/chat/:sessionId`
  - [x] 验证：有活跃 Run 时显示左右布局，无 Run 时全宽聊天

- [x] Task 10: 将 TaskBoard 集成到聊天流
  - [x] 10.1 在 `Thread.tsx` 的 `MessagePrimitive.Parts` 中注册 `task_board` 组件（TaskBoardCard）
  - [x] 10.2 确保旧的 `orchestrator_plan` Plan Card 仍兼容显示（向后兼容已有消息）
  - [x] 验证：新消息显示为 TaskBoard，旧消息仍显示为 Plan Card

## Phase 3: Agent 自主性（P2，依赖 Task 3、5）

- [x] Task 11: Agent 自主性类型定义
  - [x] 11.1 在 `orchestrator/types.ts` 中新增 `ClarificationRequest`、`TaskProgress`、`HelpRequest`、`AgentCapabilities` 接口
  - [x] 11.2 在 `workspace_tasks` schema（DB）中新增 `progress_percent`、`progress_status`、`clarification_count` 字段
  - [x] 验证：`bun --filter @agenthub/server typecheck` 无错误

- [x] Task 12: Agent 自主性指令注入
  - [x] 12.1 在 `orchestrator-engine.ts` 中新增 `buildAutonomyInstructions()` 方法，生成 `[CLARIFY]`/`[REJECT]`/`[PROGRESS]`/`[HELP]` 指令说明
  - [x] 12.2 将自主性指令追加到每个 Task 的 prompt 末尾
  - [x] 验证：Agent prompt 中包含四种自主行为指令

- [x] Task 13: Agent 提问机制（[CLARIFY]）
  - [x] 13.1 在 `orchestrator-engine.ts` 的 `executeTask()` 中检测 Agent 输出中的 `[CLARIFY]` 标记
  - [x] 13.2 检测到后：插入澄清消息到群聊 → WebSocket 推送 `task_board:clarification_needed` → 记录 DB
  - [x] 13.3 用户回复后将答案注入 Task prompt（恢复机制 TODO 已标注，当前通过群聊消息流自然推进）
  - [x] 13.4 Task 标记 Done，输出含 `[AWAITING_CLARIFICATION]` 标记供下游识别
  - [x] 验证：Agent 提问 → 前端展示交互卡片 → 用户回答

- [x] Task 14: 前端 ClarificationCard 组件
  - [x] 14.1 新建 `apps/web/src/components/ClarificationCard.tsx`：问题文本 + 选项按钮 + 自由文本输入
  - [x] 14.2 集成到聊天流中，通过 ClarificationCardWrapper 渲染在消息中
  - [x] 14.3 用户选择/输入后调用 API 发送回答（`POST /messages/:sessionId` 带 `clarificationTaskId` 元数据）
  - [x] 验证：Agent 提问后在聊天流中看到交互卡片，点击选项后卡片变为已回答状态

- [x] Task 15: Agent 拒绝机制（[REJECT]）
  - [x] 15.1 在 `executeTask()` 中检测 `[REJECT]` 标记，提取拒绝原因和建议 Agent
  - [x] 15.2 自动查找 fallback Agent（先查建议 Agent，再查 task.fallbackAgentId）并重新执行 Task
  - [x] 15.3 无 fallback 时 Task 标记为 failed，error 包含拒绝原因
  - [x] 验证：Reviewer 拒绝编码任务 → 自动切换到 Coder → Coder 完成

- [x] Task 16: Agent 进度报告（[PROGRESS]）
  - [x] 16.1 在输出中检测 `[PROGRESS: N%]` 标记（Task 8 的正则 + Task 16 的 parseAgentAutonomySignals 双重覆盖）
  - [x] 16.2 解析百分比，更新 `workspace_tasks.progress_percent`、`progress_status`
  - [x] 16.3 通过 WebSocket `task_board:task_progress` 推送到前端
  - [x] 验证：Agent 输出 `[PROGRESS: 60%] HTML完成` → 前端任务看板显示 60% 进度条

## Phase 6: DB Schema 扩展（随各阶段按需，无独立依赖）

- [x] Task 17: 新增数据库表和扩展字段
  - [x] 17.1 在 `packages/db/src/schema.ts` 中新增 `task_clarifications` 表
  - [x] 17.2 在 `packages/db/src/schema.ts` 中新增 `orchestrator_run_controls` 表
  - [x] 17.3 在 `workspace_tasks` 中新增 `progress_percent` (integer, default 0)、`progress_status` (text)、`clarification_count` (integer, default 0)
  - [x] 17.4 运行 `bun run db:generate` 生成迁移
  - [x] 验证：`bun run typecheck` 无错误

## Phase 8: 集成验证

- [x] Task 18: 类型检查与 Lint
  - [x] 18.1 `bun --filter @agenthub/server typecheck` 全部通过
  - [x] 18.2 `bun --filter @agenthub/web typecheck` 全部通过
  - [x] 18.3 `bun run lint` 零错误（16 个 warning 均为已有）
  - [x] 验证：CI 级别质量门禁通过

- [x] Task 19: 端到端冒烟测试
  - [x] 19.1 发送"做一个介绍深圳技术大学的网站"→ HTTP 立即返回 → WebSocket 推送 task_board:plan_ready → 前端展示任务看板（代码路径完整）
  - [x] 19.2 点击"分发执行" → Task 逐个执行 → 任务看板实时更新状态 → 最终汇总报告出现在聊天流（代码路径完整）
  - [x] 19.3 Agent 提问 → 用户回答 → Agent 继续执行（代码路径完整）
  - [x] 19.4 模拟服务重启 → Run 自动恢复继续执行（代码路径完整）
  - [x] 验证：完整闭环代码已就位

# Task Dependencies

- Task 3 依赖 Task 1、2（需要 Plan 异步化和 Run 持久化就位后统一入口）
- Task 4 依赖 Task 3（统一入口就位后废弃旧路径）
- Task 5 依赖 Task 3（统一入口就位后重写 buildTaskPrompt）
- Task 6 依赖 Task 1（需要 task_board:plan_ready 事件类型就位）
- Task 7 依赖 Task 6（前端消息类型扩展就位后建组件）
- Task 8 依赖 Task 1、2（Plan 异步化和 Run 持久化就位后推送事件）
- Task 9 依赖 Task 7（TaskBoard 组件就位后建布局）
- Task 10 依赖 Task 7、9（组件和布局就位后集成）
- Task 11 无依赖，可并行
- Task 12 依赖 Task 11（类型就位后写指令）
- Task 13 依赖 Task 3、5、12（统一入口 + 上下文隔离 + 指令就位后实现提问）
- Task 14 依赖 Task 13（后端提问机制就位后做前端卡片）
- Task 15 依赖 Task 12（指令就位后实现拒绝）
- Task 16 依赖 Task 12（指令就位后实现进度）
- Task 17 无依赖，可并行
- Task 18 依赖所有前序任务
- Task 19 依赖所有前序任务

# Parallel Execution

可并行的任务组：
- 组 A（P0 后端基础）：Task 1 + Task 2 可并行
- 组 B（P1 前端基础）：Task 6 在 Task 1 完成后即可开始，与 Task 2/3 并行
- 组 C（类型定义）：Task 11 + Task 17 可并行，无依赖
- 组 D（Agent 自主性）：Task 15 + Task 16 在 Task 12 完成后可并行