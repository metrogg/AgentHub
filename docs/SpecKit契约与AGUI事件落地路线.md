# Spec Kit 契约与 AG-UI 事件落地路线

最后更新：2026-06-01

本文记录 AgentHub 下一步的两条主线：

1. 把 Spec Kit 的思路落到 `.agenthub/contracts` 的质量门和产物链。
2. 把运行时事件完全收敛到 AG-UI，让任务看板、进度、子对话入口和产物卡都由事件驱动。

## 1. 结论先行

AgentHub 不应该把 Spec Kit、LangGraph、CrewAI、AutoGen 整套搬进来。我们只吸收它们成熟的分层思想：

| 外部经验 | AgentHub 吸收 | AgentHub 不照搬 |
| --- | --- | --- |
| Spec Kit | 产物链、质量门、checklist、计划-执行-分析分层 | 固定场景模板、trigger 路由 |
| LangGraph / Microsoft Agent Framework | DAG、checkpoint、resume、human-in-the-loop | 纯后端编排而没有 IM 体验 |
| OpenAI Agents SDK | handoff、guardrails、tracing | agents-as-tools 替代真实子对话 |
| AutoGen / CrewAI | team state、speaker/task selection、termination condition | 固定角色团队和关键词分工 |
| Claude Code / OpenHands / Cursor | 子 Agent、sandbox、进程生命周期、产物可见 | 让一个 Agent 假装多人 |

AgentHub 的分层应保持为：

```text
Spec Kit 思想 -> .agenthub/contracts 协作契约 / 质量门 / 产物链
A2A -> Agent 间任务通信
AG-UI -> 运行事件到前端 UI 的唯一实时协议
MCP / Skills / Rules -> Code Agent 能力层
```

## 2. Contract 该做什么

Contract 是“用户或项目显式给出的协作契约”，不是模板，也不是路由器。

### 2.1 Contract 允许表达

- scope: 允许和禁止修改的路径边界
- outputs: 期望的产物链、必需产物、必需黑板写入
- quality: 验收标准和质量门
- capabilities: 期望的 Skills / Tools / MCP / Rules

### 2.2 Contract 不允许表达

- `triggers`
- `phases`
- `requiredAgents`
- `synthesis`
- 任何按关键词自动命中固定场景的字段

### 2.3 推荐 schema

```yaml
contract:
  id: delivery-contract
  name: 通用交付契约
  version: 1.0.0

  scope:
    description: 本工作区允许 Agent 修改的范围
    allowedPaths:
      - src/**
      - docs/**
    forbiddenPaths:
      - .env
      - node_modules/**

  outputs:
    artifactChain:
      - 需求理解或调研记录
      - 实施计划
      - 可交付文件或代码
      - 验证记录
      - 最终总结
    requiredArtifacts:
      - final-report
    requiredBlackboardWrites:
      - delivery/summary

  quality:
    acceptanceCriteria:
      - 说明完成了哪些用户目标
      - 标明失败任务和部分产物
      - 给出可复现的验证方式
    qualityGates:
      - 关键产物必须能追溯到 runId、taskId、agentId、childSessionId
      - 验证失败时必须保留部分产物并说明失败原因
```

## 3. 产物链怎么用

产物链解决的是“下游接什么”和“主群聊展示什么”。

```text
用户目标
  -> Planner DAG
  -> 每个任务 outputContract
  -> 子对话真实输出
  -> blackboard task_output / artifact_ref
  -> .agenthub/handoff 可交接文件
  -> 主群聊产物卡
  -> Synthesizer 最终总结
```

规则：

- `artifactChain` 只作为 Planner 上下文和 UI 展示，不是固定阶段模板。
- `requiredArtifacts` 必须能在某个任务的 outputContract 里找到承接。
- 下游要接力的文件必须进入 `.agenthub/handoff/{runId}/{taskId}`。
- 产物卡必须能追溯到 `runId`、`taskId`、`agentId`、`childSessionId` 和文件路径。

## 4. 质量门怎么落地

质量门不是自动追加一个 QA Agent，而是 Orchestrator / Planner 必须显式考虑、系统可校验、UI 可展示的约束。

第一阶段：

- `acceptanceCriteria` 和 `qualityGates` 进入任务 `outputContract.acceptanceCriteria`
- `allowedPaths` / `forbiddenPaths` 用于任务输出路径校验
- `requiredArtifacts` / `requiredBlackboardWrites` 用于任务结果校验
- 失败时透明展示 contract violation，不生成静态兜底总结

第二阶段：

- Contract editor
- Run 级别的 contract compliance 面板
- 质量门失败后的人工确认、重试、改派

## 5. AG-UI 为什么要收敛

当前前端还残留旧的任务板兼容事件，但新路径必须只有一个 source of truth：

```text
OrchestratorRunEvent
  -> buildAgUiEventsFromRunEvent()
  -> WsEvent.AgUiEvent
  -> chatStore.applyAgUiEventToState()
  -> TaskBoard / AgentTabs / ArtifactCards / SessionList
```

### 5.1 必须解决的 UI 问题

| 用户问题 | AG-UI 事件层要提供什么 |
| --- | --- |
| 发消息后空白 | `RUN_STARTED` 或 `agenthub.run.status` 立即显示 planning/running |
| 不知道谁在思考 | `agenthub.task.status` 带 `agentId` / `agentName` / `status` |
| 子对话入口点不开 | `agenthub.task.status` 带稳定 `childSessionId` |
| 切换后进度丢失 | 事件回放接口可恢复 task board |
| 产物产出了但主群聊没显示 | `agenthub.artifact.created` 带 `taskId` / `childSessionId` |
| 任务失败但有部分产物 | 失败和产物是分离事件，不能互相清空 |

### 5.2 新路径事件

- `RUN_STARTED`
- `CUSTOM:agenthub.plan.created`
- `CUSTOM:agenthub.run.status`
- `CUSTOM:agenthub.task.status`
- `CUSTOM:agenthub.artifact.created`
- `CUSTOM:agenthub.blackboard.written`
- `RUN_FINISHED`
- `RUN_ERROR`

旧的 `task_board:*` 只能保留为兼容输入，先转成 AG-UI payload，再进入 store reducer。

## 6. 第一阶段实施顺序

1. 清理 Contract 主路径，只认 `.agenthub/contracts`。
2. 扩展 Contract schema：`artifactChain` 和 `qualityGates`。
3. 把质量门合并进 Planner 的任务 outputContract。
4. 补 AG-UI event replay 和前端 reducer 测试。
5. 逐步收敛旧的 `task_board:*` 主动广播。
6. 最后再补 UI：Contract 状态、产物链、Run trace、失败保留产物。

