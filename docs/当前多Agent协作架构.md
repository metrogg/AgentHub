# 当前多 Agent 协作架构

5.31

本文档记录 AgentHub 当前应遵守的多 Agent 协作设计。它用于统一产品、前端、后端和 Coding Agent 的判断，避免旧设计继续造成混乱。

## 设计目标

AgentHub 要做的是通用多 Agent 协作平台，而不是针对某个固定任务的 Team 模板。

用户体验应接近 WorkBuddy / Agent Team 类产品：

- 主群聊承载用户目标、Orchestrator 计划、调度进度、成员汇报和最终总结。
- 每个成员在自己的子对话里接收任务并输出。
- 用户可以查看每个成员的真实执行过程。
- 产物要能被主群聊看到，也能被下游 Agent 接力。

## 会话模型

### Agent 私聊

全局私聊用于用户和单个 Agent 一对一交流。

识别方式：

```text
session.type = direct
metadata.kind = agent-direct
```

展示位置：左侧“Agent 私聊”。

### 群聊主会话

群聊是 Workspace 级别的协作入口。

识别方式：

```text
session.type = group
workspaceId != null
```

展示位置：左侧“群聊”。

职责：

- 接收用户目标。
- 展示 Orchestrator 计划。
- 展示任务看板。
- 展示 Agent 结果汇报。
- 展示产物卡和最终总结。

### 任务子对话

任务子对话是 Orchestrator 分发给某个 Agent 的真实执行上下文。

识别方式：

```text
session.type = direct
metadata.kind = orchestrator-task
workspaceId != null
workspaceAgentId != null
```

展示位置：对应群聊展开后的子项。

职责：

- 保存 Orchestrator 发给 Agent 的任务提示。
- 保存 Agent 的真实执行过程、流式输出、工具输出和最终消息。
- 作为任务看板“子对话”按钮的目标。

## 明确废弃的旧设计

以下设计不再作为当前产品路径：

- `workspace-agent-child` 作为群聊成员入口。
- 左侧群聊下自动补齐“未开始子会话”。
- `workspace / Agent` 形式的历史入口。
- 固定三段式模板作为正常计划来源。
- 将所有复杂请求伪装成 Orchestrator 一个人完成。

保留旧数据时，前端应隐藏这些入口，避免用户看到重复子对话。

## 执行路径

```text
用户发送群聊消息
  -> messages.ts 写入用户消息
  -> intentRouter 判断简单聊天或复杂任务
  -> 简单聊天：Orchestrator 直接回复
  -> 复杂任务：生成动态计划和任务看板
  -> 用户点击分发执行
  -> OrchestratorEngine.dispatch()
  -> Planner 生成/整理任务 DAG
  -> 为每个任务创建 orchestrator-task 子对话
  -> TaskScheduler 按依赖执行
  -> TaskExecutionService 准备执行目录
  -> Runtime 执行 LLM / Code Agent / Native Tool
  -> 写入黑板和产物
  -> 主群聊发布成员汇报
  -> Synthesizer 汇总最终结果
```

## 工作目录

当前优先采用“一个项目工作区 + 每个 Agent 一个执行目录”的设计。

```text
{projectRoot}/.agenthub/
  workdirs/
    {runId}/
      {agentName}/
        {taskId}/
  handoff/
    {runId}/
      {taskId}/
```

规则：

- 用户选择本地工作区后，项目根就是 `projectRoot`。
- 写入型 Agent 在 `.agenthub/workdirs/...` 中执行。
- 只读 Agent 可以读取项目根。
- 如果用户未选择工作区，系统自动创建一个可写工作区。
- 后续可以在系统设置中配置默认工作区存储路径。

## 产物和 handoff

Agent 产物有三层：

- 子对话消息 metadata 中的 artifacts。
- `workspace_tasks.artifacts` 中的任务产物记录。
- `blackboard_entries` 中的结构化摘要和 artifact ref。

对于需要被下游 Agent 使用的文件，Orchestrator 会尽量复制到：

```text
.agenthub/handoff/{runId}/{taskId}/...
```

下游提示词规则：

- 优先读取黑板中明确给出的 `handoffPath`。
- `filePath/path` 只是上游记录，不代表该路径存在于当前 Agent 工作目录。
- 不允许下游 Agent 读取自己目录里臆造的相对路径。

## 失败和部分产物

Code Agent 可能出现“已有产物但任务失败”的情况，例如：

- 生成了文件，但 `npm build` 或 Next.js prerender 失败。
- 写入了报告，但 CLI 最后因为模型、Base URL 或超时返回非零退出码。
- 验证命令失败。

这时状态应为失败，但 UI 必须说明：

- 最终结果未确认。
- 已保留部分产物。
- 产物可用于排查或后续接力。

不要把这种情况显示成“没有产物”。

## 前端展示规则

左侧：

- “Agent 私聊”：只显示全局 agent-direct。
- “群聊”：显示 group。
- 群聊展开：只显示真实 orchestrator-task 子对话。

主聊天区：

- 用户消息先出现。
- Orchestrator 应尽快给出计划/运行反馈。
- 任务看板显示每个 Agent 状态。
- Agent 完成或失败后在主群聊发布成员汇报。
- 产物卡应从消息 metadata 和任务看板中可见。

子对话：

- 点击任务看板或左侧子项应进入同一个 child session。
- 子对话必须有消息内容，不应是空白壳。

## 关键文件

- `apps/server/src/routes/messages.ts`
- `apps/server/src/services/orchestrator/orchestrator-engine.ts`
- `apps/server/src/services/orchestrator/planner.ts`
- `apps/server/src/services/orchestrator/task-scheduler.ts`
- `apps/server/src/services/execution/task-execution-service.ts`
- `apps/server/src/services/execution/agent-workdir.ts`
- `apps/server/src/services/blackboard.ts`
- `apps/server/src/services/code-agent-adapter.ts`
- `apps/web/src/lib/sessionTree.ts`
- `apps/web/src/components/chat/SessionList.tsx`
- `apps/web/src/components/chat/TaskBoard.tsx`
- `apps/web/src/stores/chatStore.ts`

## 后续优化方向

- 任务看板增加更细的 Agent 当前状态：排队、启动 CLI、运行中、写产物、验证中、失败但保留产物。
- 子对话和主群聊的产物入口统一。
- 对 Code Agent 失败做更精确分类：模型错误、鉴权错误、构建错误、验证错误、超时。
- 引入更标准的 Agent 通信协议或开源组件时，优先封装在 Runtime/Blackboard 层，不要破坏当前会话模型。

