# 多 Agent 系统 / Agent 集群设计

本文档记录 AgentHub 对 Mastra Agent Network 能力的迁移设计。参考源主要来自：

- `F:\Learning\mastra\mastra-main\packages\core\src\loop\network\index.ts`
- `F:\Learning\mastra\mastra-main\packages\core\src\stream\MastraAgentNetworkStream.ts`
- `F:\Learning\mastra\mastra-main\packages\playground\src\domains\agents\components\agent-settings.tsx`
- `F:\Learning\mastra\mastra-main\packages\playground\src\App.tsx`

## 概念映射

| Mastra 概念 | AgentHub 中文名 | 说明 |
| --- | --- | --- |
| Agent Network | Agent 集群 | 一个 routing agent 与多个 sub-agents 组成的协作运行单元 |
| Routing Agent | 调度 Agent / Supervisor | 负责判断任务是否自己处理、委派给成员、调用工具或回退 |
| Sub Agents | 成员 Agent | 承接研究、工具调用、审查、安全、发布等专门职责 |
| Network Route | 路由/交接规则 | 描述从哪个 Agent 到哪个 Agent、触发条件、模式和状态 |
| Network Run | 集群运行 | 一次多 Agent 协作执行，包含路由路径、延迟、Token 和摘要 |
| Network Stream Event | 集群流事件 | 对齐 `network-execution-event-*`，用于前端时间线和观测 |

## 支持拓扑

| 拓扑 | 场景 | AgentHub 状态 |
| --- | --- | --- |
| `supervisor` | 一个 routing agent 统一分派任务 | 已建模 |
| `pipeline` | 工具调用、质量检查、输出审查等线性流程 | 已建模 |
| `committee` | 多个审查 Agent 并行投票后汇总 | 已建模 |
| `swarm` | 多 Agent 自组织协作 | 预留 |

## 运行生命周期

1. 接收用户目标和请求上下文。
2. Routing Agent 读取共享记忆、可用成员、工具、工作流和策略。
3. 根据路由规则选择自己处理、委派、并行、审查或回退。
4. 成员 Agent 执行子任务，并把中间结果写回运行上下文。
5. Supervisor 汇总结果，必要时进入 HITL 暂停/恢复。
6. 写入运行历史、Trace、日志、评估结果和线程记忆。

## 当前落地

- 后端注册表：`apps/server/src/services/studio-registry.ts`
  - `StudioAgentCluster`
  - `StudioClusterMember`
  - `StudioClusterRoute`
  - `StudioClusterRun`
  - `listAgentClusters/getAgentCluster/runAgentCluster/updateAgentCluster`
- Studio API：`apps/server/src/routes/studio.ts`
  - `GET /api/studio/clusters`
  - `GET /api/studio/clusters/:clusterId`
  - `PATCH /api/studio/clusters/:clusterId`
  - `POST /api/studio/clusters/:clusterId/runs`
  - `GET /api/studio/clusters/:clusterId/tabs/:tab`
- Mastra 兼容 API：`apps/server/src/routes/mastra-compat.ts`
  - `GET /api/mastra/networks`
  - `GET /api/mastra/networks/v-next`
  - `GET /api/mastra/networks/:networkId`
  - `POST /api/mastra/networks/:networkId/generate`
  - `POST /api/mastra/networks/:networkId/stream`
- 前端模块：`apps/web/src/features/studio/ModuleWorkbench.tsx`
  - Agent 集群拓扑
  - 成员 Agent 负载、模型、工具和交接策略
  - 路由表与模式
  - 运行策略和运行历史

## 后续增强

- 将当前内存态集群持久化到数据库。
- 将 `network-execution-event-*` 接入真正的 SSE/WebSocket 流。
- 在 Agent 聊天页加入“使用集群运行”的模式开关，对齐 Mastra `chatWithNetwork`。
- 将 HITL 暂停/恢复与工具审批、Review Queue 串起来。
- 把集群运行接入真实 Mastra `agent.network()` 或本项目的 `agent-runner`。
