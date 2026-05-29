# 三协作模式（Phase 2）Spec

## Why

当前 AgentHub 只有一种执行模式——DAG 拓扑调度，无论任务特征如何都走同一条路径。讯飞 AstronClaw 的成功经验表明：不同类型的任务适合不同的协作模式。引入 Pipeline（流水线）、MapReduce（映射归约）、Supervisor（监督者）三种语义化协作模式，让 Planner 根据任务特征自动选择，提升执行效率与用户体验。

TaskScheduler 已有良好的基础设施支持三种模式：
- `addTasksToRun()` — 支持 Supervisor 动态注入任务
- `setConcurrency()` — 支持 Pipeline 串行限制
- `ExecutionPlan.phases` — 已有但未用的阶段字段

## What Changes

- 新增 `CollaborationMode` 类型（`pipeline | mapreduce | supervisor`）
- Planner LLM prompt 增加模式选择指令，`normalizeGeneratedPlan` 读取 mode 字段
- Pipeline 模式：TaskScheduler 强制 concurrency=1，严格顺序执行，每阶段完成后广播阶段事件
- MapReduce 模式：Worker 并行层 → Synthesizer 汇总（当前 DAG 的自然子集，显式标注即可）
- Supervisor 模式：Orchestrator LLM 监控 Blackboard 中间结果，动态调用 `addTasksToRun()` 注入新任务
- 后端所有计划生成和 dispatch 处传递 mode 字段
- 前端 Plan 卡片支持 mode 显示（仅后端透传，前端由同事维护）

## Impact

- Affected specs: orchestration-flow
- Affected code:
  - `apps/server/src/services/orchestrator/types.ts` — 新增 CollaborationMode
  - `apps/server/src/services/orchestrator/planner.ts` — LLM prompt + normalize 读取 mode
  - `apps/server/src/services/orchestrator/task-scheduler.ts` — mode-aware 行为
  - `apps/server/src/services/orchestrator/orchestrator-engine.ts` — Supervisor 模式集成
  - `apps/server/src/services/orchestrator/plan-generator.ts` — 透传 mode
  - `apps/web/src/components/assistant-ui/Thread.tsx` — Plan 卡片 mode 徽章（同事维护）

## ADDED Requirements

### Requirement: CollaborationMode 类型定义
系统 SHALL 支持三种协作模式枚举，Planner 生成计划时输出模式标注。

#### Scenario: Pipeline 模式识别
- **WHEN** 任务有明确的先后工序（如"先设计架构，再开发API，最后写测试"）
- **THEN** Planner 输出 `collaborationMode: "pipeline"`

#### Scenario: MapReduce 模式识别
- **WHEN** 任务可拆解为多个独立维度（如"同时调研竞品A、B、C，最后汇总报告"）
- **THEN** Planner 输出 `collaborationMode: "mapreduce"`

#### Scenario: Supervisor 模式识别
- **WHEN** 任务过程不确定，需要根据中间结果动态调整（如"深度调研某个技术，发现新方向后追加调研"）
- **THEN** Planner 输出 `collaborationMode: "supervisor"`

### Requirement: Pipeline 串行执行
Pipeline 模式下，TaskScheduler SHALL 强制 concurrency=1，严格按阶段顺序执行。

#### Scenario: Pipeline 阶段推进
- **WHEN** Pipeline 模式下当前阶段所有任务完成
- **THEN** 广播 `phase:completed` 事件，自动推进到下一阶段

### Requirement: MapReduce 显式标注
MapReduce 模式下，多个 Worker 并行执行后由 Synthesizer 汇总，当前 DAG 调度已支持此模式，仅需 Planner 显式标注。

### Requirement: Supervisor 动态注入
Supervisor 模式下，OrchestratorEngine SHALL 在关键节点调用 Orchestrator LLM 评估 Blackboard 状态，根据评估结果调用 `addTasksToRun()` 动态注入新任务。

#### Scenario: Supervisor 补采任务
- **WHEN** 某 Worker 完成调研后发现某维度数据不足
- **THEN** Orchestrator LLM 评估后动态注入新的调研任务

## MODIFIED Requirements

### Requirement: Planner 输出 mode 字段
Planner SHALL 在 LLM prompt 中要求模型选择协作模式，并在 `normalizeGeneratedPlan` 中读取并校验 mode 字段。

#### Scenario: LLM 返回 mode
- **WHEN** LLM 成功生成计划
- **THEN** `normalizeGeneratedPlan` 输出中包含有效的 `collaborationMode`

#### Scenario: LLM 未返回 mode（兼容）
- **WHEN** LLM 返回的计划中没有 mode 字段或值无效
- **THEN** 默认回退为 `mapreduce`（与当前 DAG 行为一致）