# 统一多Agent编排流程 Spec

## Why

当前 AgentHub 存在两条职责交叉的多Agent路径——GroupChatManager（群聊轮转）和 OrchestratorEngine（DAG 编排），导致用户发一条复杂任务消息时 Plan 卡片和 Agent 回复同时出现。核心问题：**缺少统一的 Intent Router 做分流决策**，GroupChatManager 承担了不该承担的编排触发职责。需要将路径理顺，对齐讯飞 AstronClaw 和 Kimi Agent Swarm 的设计理念。

## What Changes

- **BREAKING**: 从 GroupChatManager 中移除 `isComplexTask()` 和 `triggerOrchestratorPlan()`，群聊只负责 `@mention` 轮转对话
- 新增独立 `IntentRouter` 服务，统一所有消息的路由决策
- 合并两套重复的 Plan 生成路径（`triggerOrchestratorPlan` + `POST /orchestrator-plan`）为一套
- Replanning 上限从 20 次收敛到 5 次，单任务最坏阻塞从 100 分钟降到 25 分钟
- Auto-Review（Verifier + Reviewer）从串行改为通过 TaskScheduler 并行调度

## Impact

- Affected specs: orchestration-flow, group-chat
- Affected code:
  - `apps/server/src/services/group-chat/group-chat-manager.ts` — 瘦身
  - `apps/server/src/services/orchestrator/` — 新增 intent-router.ts，合并 plan 生成
  - `apps/server/src/routes/messages.ts` — 路由入口统一
  - `apps/server/src/services/orchestrator/orchestrator-engine.ts` — Replanning 上限调整，Auto-Review 并行化

## ADDED Requirements

### Requirement: Intent Router 统一分流
系统 SHALL 提供独立的 IntentRouter 服务，在消息进入时统一决策路由路径。

#### Scenario: 复杂任务自动路由到编排
- **WHEN** 用户在群聊中发送复杂任务消息（无需 @orchestrator）
- **THEN** IntentRouter 评估复杂度后自动触发 Orchestrator Plan 生成

#### Scenario: @Agent 消息路由到单 Agent 回复
- **WHEN** 用户在群聊中 @特定 Agent
- **THEN** IntentRouter 路由到 DirectReply 路径，不触发编排

#### Scenario: 简单消息由 Orchestrator 直接回复
- **WHEN** 用户在群聊中发送简单询问（无 @、非复杂任务）
- **THEN** Orchestrator Agent 直接回复，不生成 Plan 卡片

### Requirement: Plan 生成路径唯一
系统 SHALL 只保留一套 Plan 生成逻辑，无论通过 IntentRouter 自动触发还是 API 手动触发。

#### Scenario: 自动触发 Plan 生成
- **WHEN** IntentRouter 判定需要编排
- **THEN** 调用统一的 `createOrchestratorPlan()` 生成 Plan 卡片

#### Scenario: API 手动触发 Plan 生成
- **WHEN** 前端调用 `POST .../orchestrator-plan`
- **THEN** 调用同一套 `createOrchestratorPlan()` 逻辑

## MODIFIED Requirements

### Requirement: GroupChatManager 职责收敛
GroupChatManager SHALL 只负责 `@mention` 轮转对话，不再承担复杂度判断和 Plan 触发职责。

#### Scenario: @mention 轮转
- **WHEN** 用户在群聊中 @Agent 并得到回复，Agent 回复中又 @另一个 Agent
- **THEN** GroupChatManager 自动让被 @的 Agent 接力回复

### Requirement: Replanning 上限收敛
Replanning 引擎 SHALL 将最大重试次数从 20 次收敛到 5 次。

#### Scenario: 任务失败触发 Replanning
- **WHEN** 任务执行失败
- **THEN** 最多重试 5 次（含 retry/substitution/replan/split 等策略总和）

### Requirement: Auto-Review 并行化
Auto-Review 链路（Verifier → Reviewer）SHALL 通过 TaskScheduler 以 DAG 方式并行调度，而非独立串行调用。

#### Scenario: 多个 Code 任务完成后的审查
- **WHEN** 多个 code 任务的 Verifier 和 Reviewer 任务就绪
- **THEN** TaskScheduler 按 DAG 依赖关系并发执行，最多 3 个并行