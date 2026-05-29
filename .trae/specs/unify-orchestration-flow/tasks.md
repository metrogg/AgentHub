# Tasks

- [x] Task 1: 创建 IntentRouter 独立服务
  - [x] 在 `apps/server/src/services/orchestrator/` 下新建 `intent-router.ts`
  - [x] 将 `isComplexTask()` 从 `group-chat-manager.ts` 迁入，整理为 `assessComplexity()` 方法
  - [x] 新增 `route()` 统一入口方法：返回路由决策（DirectReply / OrchestratorPlan / ConversationLoop / NoOrchestrator）
  - [x] 支持配置化阈值：默认 `signals >= 3`，允许 workspace 级别覆盖
  - [x] 导出 `intentRouter` 实例和 `generatePlanCardBackground` 函数

- [x] Task 2: 合并 Plan 生成路径
  - [x] 将 `triggerOrchestratorPlan()` 逻辑从 `group-chat-manager.ts` 迁出
  - [x] `buildDynamicOrchestratorPlan()` 是唯一的 Plan 构建入口
  - [x] 统一 loading 卡片插入和更新逻辑到 `generatePlanCardBackground()` 函数
  - [x] `POST /orchestrator-plan` 和 IntentRouter 触发都走 `buildDynamicOrchestratorPlan`

- [x] Task 3: GroupChatManager 瘦身
  - [x] 移除 `isComplexTask()` 方法（已迁至 IntentRouter）
  - [x] 移除 `triggerOrchestratorPlan()` 方法（已迁至统一 Plan 路径）
  - [x] 移除 `buildDynamicOrchestratorPlan` 导入
  - [x] `conversationLoop()` 中移除复杂度判断+Plan触发+系统提示分支
  - [x] `@mention` 轮转对话逻辑保持不变

- [x] Task 4: 更新 messages.ts 消息入口
  - [x] `POST /:sessionId` 中群聊分支调用 IntentRouter 做路由决策
  - [x] IntentRouter 返回 `OrchestratorPlan` 时调用 `generatePlanCardBackground()`
  - [x] IntentRouter 返回 `ConversationLoop` / `DirectReply` 时进入 GroupChatManager
  - [x] IntentRouter 返回 `NoOrchestrator` 时直接插入系统提示消息

- [x] Task 5: Replanning 上限收敛
  - [x] `currentAttempt > 20` → `currentAttempt > 5`
  - [x] 所有 7 种恢复策略共享同一计数器
  - [x] 添加单任务总时间超时保护：`TASK_TIMEOUT_MS * 5`（1500 秒）

- [x] Task 6: Auto-Review 并行化
  - [x] 重构 `injectAutoReviewTasks()`：改为 DAG 注入 + `scheduler.executePlan()`
  - [x] Verifier 依赖 code 任务，Reviewer 依赖 Verifier
  - [x] 多个 code 任务的 Verifier 之间并行执行
  - [x] 通过 TaskScheduler Semaphore(3) 控制并发

# Task Dependencies

- Task 3 依赖 Task 1 + Task 2（需要新的路由和 Plan 生成就位后再瘦身）
- Task 4 依赖 Task 1（需要 IntentRouter 就位后改造入口）
- Task 5 无依赖，可并行
- Task 6 无依赖，可并行