# Checklist

- [x] `types.ts` 中 `CollaborationMode` 类型定义正确（`'pipeline' | 'mapreduce' | 'supervisor'`）
- [x] `ExecutionPlan` 接口包含可选 `collaborationMode` 字段
- [x] Planner LLM prompt 中包含模式选择指令
- [x] Planner Schema 中包含 `collaborationMode` 字段
- [x] `normalizeGeneratedPlan()` 校验 mode 有效性，无效时默认 `mapreduce`
- [x] `inferMode()` 启发式推断逻辑存在且合理
- [x] TaskScheduler Pipeline 模式下 concurrency=1
- [x] TaskScheduler Pipeline 模式广播 `phase:completed` 事件
- [x] TaskScheduler Supervisor 模式不因当前层完成而退出
- [x] OrchestratorEngine 根据 `collaborationMode` 选择执行策略
- [x] Supervisor 模式下 Orchestrator LLM 成功评估 Blackboard 并可能注入任务
- [x] Supervisor 模式最多追加 3 轮
- [x] `fallbackPlanAgents()` 固定模板标记为 `mapreduce`（3阶段 fallback 为 `pipeline`）
- [x] `bun --filter @agenthub/server typecheck` 通过
- [x] `bun run lint` server 零错误