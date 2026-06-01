# 当前多 Agent 协作架构

5.31

本文档记录 AgentHub 当前应遵守的多 Agent 协作设计。它用于统一产品、前端、后端和 Coding Agent 的判断，避免旧设计继续造成混乱。

当前事实总览见 `docs/当前状态与下一步路线.md`。
更完整的分层架构与业内方案对比见 `docs/多Agent协作分层架构与业内对比.md`。
Spec Kit 契约化和 AG-UI 事件收敛路线见 `docs/SpecKit契约与AGUI事件落地路线.md`。

## 设计目标

AgentHub 要做的是通用多 Agent 协作平台，而不是针对某个固定任务的 Team 模板。

用户体验应接近 WorkBuddy / Agent Team 类产品：

- 主群聊承载用户目标、Orchestrator 计划、调度进度、成员汇报和最终总结。
- 每个成员在自己的子对话里接收任务并输出。
- 用户可以查看每个成员的真实执行过程。
- 产物要能被主群聊看到，也能被下游 Agent 接力。
- 系统不再自动注入默认团队、经典模板或关键词路由，所有执行分工都应来自 Orchestrator/Planner 的模型输出。

## 当前分层架构

AgentHub 需要把以下层次分开设计：

| 层 | 我们的当前设计 |
| --- | --- |
| 产品交互层 | IM 群聊、全局 Agent 私聊、群聊下任务子对话、任务看板、产物卡 |
| 编排规划层 | Orchestrator 理解目标，Planner 生成动态 DAG，TaskScheduler 按依赖执行，Synthesizer 汇总 |
| 通信协议层 | A2A 作为 Agent 间 `message/send`、task、artifact 语义；AG-UI 作为运行事件到前端的桥接 |
| Agent 身份层 | `code-agent` 是主路径；`llm` 是内部/兜底；A2A/MCP/Skills/Rules 都不是 Agent 类型 |
| 执行运行时层 | Codex CLI、Claude Code、OpenCode、Gemini CLI 作为 Coding Agent 基底 |
| 能力工具层 | MCP、Skills、Rules、shell、文件、浏览器等作为 Code Agent 可用能力 |
| 协作契约层 | 用户显式提供的 Spec / Contract 只描述范围、产出、验收和路径边界，不做固定模板或意图路由 |
| 工作区与状态层 | 系统默认工作空间根、`.agenthub/workdirs`、`.agenthub/handoff`、local sandbox root、blackboard、execution logs、run events |

产品层应学习 WorkBuddy / Kimi 群聊 / Claude Code subagents 的“主对话可见、子任务可进、过程可信”；编排层应学习 LangGraph / Microsoft Agent Framework 的 DAG、checkpoint、resume、HITL；协议层应坚持 A2A / AG-UI / MCP 各管一层，不互相冒充。

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
- 内置 `.agenthub/specs/*.spec.yml` 场景模板，以及把 specs 自动复制到新工作区。
- `classic` 工作区模板、默认代码团队、自动 Researcher 注入、自动 QA/review/follow-up 任务注入。
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
  -> Orchestrator 生成 A2A message/send envelope
  -> TaskExecutionService 准备执行目录和 local sandbox lease
  -> LocalA2ATransport 派发给本地执行宿主
  -> 本地执行宿主适配 LLM fallback / Code Agent
  -> 写入黑板和产物（以 A2A artifact/metadata 扩展记录）
  -> 主群聊发布成员汇报
  -> Synthesizer 汇总最终结果
```

## A2A 作为 Agent 间通信标准

当前内部 Agent 通信不再把 A2A 只当成对外展示层。Orchestrator 分发给成员的任务会先转成 A2A v0.3 的 `message/send`：

- `Message.contextId` = 群聊主会话 ID。
- `Message.taskId` = `workspace_tasks.id`。
- `Message.referenceTaskIds` = 上游依赖任务 ID。
- `Message.metadata["agenthub.dev/a2a/internal"]` 记录 run、workspace、child session、发送方 Orchestrator 和接收方 Agent。
- 子对话 user message 保存 A2A 请求信封。
- 成员输出保存 A2A `responseMessage`，主群聊成员汇报保存 A2A `responseTask`。

内部 transport：

```text
A2A message/send
  -> LocalA2ATransport
  -> runAgentReply
  -> runtimeRegistry
  -> llm / code-agent
```

也就是说，Codex CLI、Claude Code、OpenCode、Gemini CLI 是当前主要 Agent 执行基底；普通 LLM 只作为 Orchestrator/Planner/Synthesizer 和 fallback 能力。MCP、Skills、Rules 是 Code Agent 可使用的工具/能力层，不是 Agent 类型。黑板和 handoff 只作为 A2A artifact/metadata 的 AgentHub 扩展存在，不能再承担隐藏分工或静态路由职责。

如果后续接入远程 A2A endpoint，也应作为协议层配置存在，例如 `roleProfile.protocol = "a2a"` 与 `roleProfile.a2aEndpoint`，不能恢复 `runtimeType = "a2a"`。

## Agent 身份模型

当前 `workspace_agents.runtimeType` 只有两类：

- `code-agent`：主路径。用户自建 Agent 是在 Codex CLI、Claude Code、OpenCode、Gemini CLI 等 Coding Agent 基底上配置角色、系统提示词、skills/MCP 能力、工具权限和沙箱策略。
- `llm`：兜底路径。用于纯文本能力、Orchestrator/Planner/Synthesizer 等内部模型调用或没有可用 Coding Tools 时的保障。

A2A、MCP、Skills、Rules 都不能作为 Agent 类型出现在 UI、数据库或 Planner 输出中。

## 工作目录

当前优先采用“一个项目工作区 + 每个 Agent 一个执行目录”的设计。这里的隔离是本地 workdir 隔离，不是 Docker/VM 级别的 OS 沙箱。

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
- 显式协作契约放在 `.agenthub/contracts/*.contract.json|yml`；旧的 `.agenthub/specs/*.spec.yml` 只作为历史残留，不再参与主路径。
- 如果用户未选择工作区，系统会在默认工作空间存储路径下自动创建一个可写工作区。
- 默认工作空间存储路径必须位于系统用户数据目录，例如 Windows 的 `%LOCALAPPDATA%\AgentHub\workspaces`，不能回落到 AgentHub 源码仓库。
- 用户可以在设置里修改默认工作空间存储路径，建议使用用户目录或单独数据盘目录，不要选择 AgentHub 项目源码目录。

执行隔离通过 `SandboxProvider` 抽象承载。当前可用 provider：

- `local-workdir`：默认路径，本机进程 + 独立 workdir/temp/cache/config。
- `docker`：容器路径，Code Agent CLI 会通过 `docker run` 在容器里执行。

云沙箱或远程开发容器可以作为后续 provider 接入，但在真正实现前不能把它们描述为已启用。

`local-workdir` 当前实际做了这些事：

- 为每个任务创建独立执行目录：`.agenthub/workdirs/{runId}/{agentName}/{taskId}`。
- 为每个任务创建独立本地沙箱根：系统缓存目录下的 `AgentHub/sandboxes/{runId}/{agentName-agentId}/{taskId}`。
- 为 Code Agent 子进程注入独立 `TMP/TEMP/TMPDIR`、`APPDATA/LOCALAPPDATA`、`XDG_*`、npm/bun cache 目录。
- Codex/OpenCode 的本次运行配置文件写入 sandbox config 目录，避免污染全局临时配置。
- 把 prompt 临时文件和 Codex last-message 文件放入本次沙箱 temp，而不是全局临时目录。
- 任务取消或超时时通过进程树 kill 处理子进程。

`local-workdir` 不能承诺的边界：

- 不能阻止本机进程访问网络；`networkPolicy` 在本地 provider 中只是声明，真正 enforcement 需要 Docker/cloud provider。
- 不能阻止恶意 CLI 读取沙箱外路径；它是工作目录和环境隔离，不是 OS 权限边界。
- 默认不强制改写 `HOME/USERPROFILE`，以免破坏 Codex / Claude Code / OpenCode 的本机登录态。需要更强 HOME 隔离时可设置 `AGENTHUB_SANDBOX_ISOLATE_HOME=true`，但应优先确保模型凭据从 AgentHub 设置注入。

`docker` provider 当前实际做了这些事：

- 需要设置 `AGENTHUB_SANDBOX_PROVIDER=docker` 和 `AGENTHUB_DOCKER_SANDBOX_IMAGE`。
- 镜像必须已经安装对应 CLI，例如 `codex`、`claude`、`opencode` 或 `gemini`，AgentHub 不在运行时临时安装。
- 将 Agent 的实际执行目录挂载到容器 `/workspace`，CLI 的 `--cd` / `--dir` 也改为 `/workspace`。
- 将本次任务的 temp/cache/config/data/home 目录分别挂载到容器路径，例如 `/tmp/agenthub`、`/home/agenthub/.cache`、`/home/agenthub/.config`。
- OpenCode prompt file、Codex last-message 文件和运行时配置会自动做 host path 到 container path 映射。
- `networkPolicy=disabled` 会映射到 Docker `--network none`；默认使用 `bridge`，也可通过 `AGENTHUB_DOCKER_NETWORK` 指定。
- 任务取消或超时时 kill 的是 `docker run` 进程树，容器使用 `--rm` 自动清理。

`docker` provider 仍需要注意：

- 镜像能力决定能不能跑；如果镜像里没有对应 CLI，会正常失败并显示 CLI 不存在。
- API Key 仍通过 AgentHub 的 env/model 配置注入容器，不建议把宿主机完整 home 目录挂进去。
- Windows Docker Desktop 对盘符、权限和中文路径可能更敏感；出现挂载失败时优先把默认工作空间放到普通英文路径测试。

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

前端运行态统一以 AG-UI 事件驱动任务看板、进度条、子对话入口和产物卡；旧的 `task_board:*` 事件只作为兼容输入，不再作为独立状态源。

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
- `apps/server/src/services/execution/local-a2a-transport.ts`
- `apps/server/src/services/protocols/a2a-internal.ts`
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
