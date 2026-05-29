# Tasks

- [x] Task 1: 类型定义 — CollaborationMode
  - [x] 在 `types.ts` 中新增 `CollaborationMode = 'pipeline' | 'mapreduce' | 'supervisor'`
  - [x] `ExecutionPlan` 接口新增可选字段 `collaborationMode?: CollaborationMode`
  - [x] 通过 `bun --filter @agenthub/server typecheck` 确认无类型错误

- [x] Task 2: Planner 模式选择 — LLM prompt + normalize
  - [x] 修改 `planner.ts` 中 `generateWithLlm()` 的 system prompt，加入模式选择指令
  - [x] Schema 中新增 `collaborationMode` 字段
  - [x] `normalizeGeneratedPlan()` 读取并校验 mode，无效时默认 `mapreduce`
  - [x] 在 Planner 类中新增 `inferMode()` 方法：LLM 失败时基于关键词做启发式推断
  - [x] 关键词推断规则：有序词(先...然后)→pipeline / 并行词(同时)→mapreduce / 调研词→supervisor

- [x] Task 3: TaskScheduler mode-aware 行为
  - [x] `executePlan()` 接受可选 `collaborationMode` 参数
  - [x] Pipeline 模式：`setConcurrency(1)` 覆盖默认并发
  - [x] Pipeline 模式：每阶段所有任务完成后广播 `phase:completed`（通过 signal/回调）
  - [x] MapReduce 模式：保持默认行为不变
  - [x] Supervisor 模式：scheduler 保持运行态（不因为当前层完成而退出），等待 `addTasksToRun()`

- [x] Task 4: OrchestratorEngine Supervisor 模式集成
  - [x] `startRun()` 中根据 `plan.collaborationMode` 选择执行策略
  - [x] Supervisor 模式：在每组 Worker 任务完成后，调用 Orchestrator LLM 评估 Blackboard
  - [x] 评估 prompt：给定当前 Blackboard 数据+已完成的 task，判断是否需要追加任务
  - [x] 若需要追加：调用 `buildDynamicOrchestratorPlan` 生成补充 task，通过 `scheduler.addTasksToRun()` 注入
  - [x] 最多追加 3 轮（防止无限循环），每轮完成后重新评估
  - [x] 所有追加轮次完成后进入 Synthesizer 汇总

- [x] Task 5: plan-generator 透传 mode
  - [x] `buildDynamicOrchestratorPlan()` 返回的结果中包含 `collaborationMode`
  - [x] `fallbackPlanAgents()` 生成的固定模板默认标记为 `mapreduce`
  - [x] `generatePlanCardBackground()`（intent-router.ts）不做改动，自动透传

- [x] Task 6: 类型检查 + lint
  - [x] `bun --filter @agenthub/server typecheck` 全部通过
  - [x] `bun run lint` server 零错误

# Task Dependencies

- Task 2 依赖 Task 1（类型定义先行）
- Task 3 依赖 Task 1
- Task 5 依赖 Task 1
- Task 4 依赖 Task 1 + Task 2 + Task 3 + Task 5（Supervisor 模式需要完整的 plan 生成链路）
- Task 6 依赖所有前序任务