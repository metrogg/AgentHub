# Checklist

- [x] IntentRouter 独立文件创建且从 orchestrator 目录导出（`intent-router.ts` 导出 `intentRouter` 实例和 `generatePlanCardBackground`）
- [x] `assessComplexity()` 信号阈值可配置（默认 3，支持 `threshold` 参数传入）
- [x] `route()` 方法返回四种决策之一（DirectReply / OrchestratorPlan / ConversationLoop / NoOrchestrator）
- [x] Plan 卡片生成逻辑只有一套统一入口（`generatePlanCardBackground()`，内部调用 `buildDynamicOrchestratorPlan`）
- [x] `POST /orchestrator-plan` API 和 IntentRouter 自动触发走同一套 Plan 生成代码（`buildDynamicOrchestratorPlan`）
- [x] GroupChatManager 不再包含 `isComplexTask` 方法
- [x] GroupChatManager 不再包含 `triggerOrchestratorPlan` 方法
- [x] GroupChatManager 的 `handleMessage()` 只处理 `@mention` 轮转对话（移除复杂度判断和 Plan 触发）
- [x] `POST /:sessionId` 群聊分支先调用 `IntentRouter.route()` 再进入对应路径
- [x] IntentRouter 返回 `ConversationLoop` / `DirectReply` 时才进入 GroupChatManager
- [x] Replanning 上限改为 5（`currentAttempt > 5`）
- [x] Auto-Review 通过 `TaskScheduler.executePlan(autoReviewPlan)` DAG 方式调度，Verifier 之间可并行
- [x] 所有修改通过 `bun --filter @agenthub/server typecheck`
- [x] 所有修改通过 `bun run lint`（server 零错误）