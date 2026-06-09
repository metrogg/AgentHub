# AgentHub 产品设计文档

## 1. 产品一句话

AgentHub 是一个本地优先的多 Agent 协作工作台。用户像在 IM 群聊里和团队沟通一样提出目标，Manager / Orchestrator 负责理解目标、追问、补员、拆解和汇总，多个真实 Worker Agent 在各自任务子对话和工作目录中执行，最终把进度、产物和结论回到主群聊。

代码依据：

- 首页与会话入口：`apps/web/src/pages/ChatPage.tsx`
- 会话树与 Agent 私聊 / 群聊 / 任务子对话分区：`apps/web/src/components/chat/SessionList.tsx`
- 主聊天界面、任务看板、产物侧栏：`apps/web/src/components/assistant-ui/Thread.tsx`
- 前端消息和任务状态投影：`apps/web/src/stores/chatStore.ts`
- Room-first 消息入口：`apps/server/src/routes/messages.ts`
- Room timeline 写入与参与者初始化：`apps/server/src/services/rooms/room-chat-bridge.ts`

## 2. 要解决的问题

当前 AI 工具常见问题是：单个模型假装完成所有角色，用户只能看到最终回答，看不到分工、过程和产物交接。复杂任务中，这会带来几个痛点：

1. **任务拆解不可见**：用户不知道 AI 如何理解目标、如何决定先后顺序。
2. **执行过程不可追踪**：多个子任务的状态、阻塞和失败不容易被观察。
3. **产物散落**：代码、文档、报告、图片等结果难以统一展示和复盘。
4. **上下文混乱**：一个 Agent 同时承担产品、研发、测试、写作等角色，容易互相污染。
5. **本地开发不可信**：用户希望 AI 能在本地项目里真实执行，但又需要权限、工作区和产物边界。

AgentHub 的设计目标是把复杂工作从“一轮问答”升级为“可观察、可协作、可交付的 AI 团队工作流”。

## 3. 目标用户

### 3.1 主要用户

- 独立开发者：希望用多个 Coding Agent 协作完成项目功能、修 bug、重构和文档。
- 小团队技术负责人：希望把需求拆成并行任务，并观察每个 Agent 的执行过程。
- 产品 / 运营 / 内容创作者：希望从一个目标生成文档、报告、PPT、表格等可交付产物。
- AI Agent 开发者：希望验证 Manager / Worker / Room / Artifact 的协作范式。

### 3.2 比赛演示用户画像

评委可以被设定为一个“需要快速把想法变成可交付成果的人”：他不想手动搭工作流，也不想只拿到一段模型回复，而是希望看到一个 AI 团队从沟通、拆解、执行到交付的完整过程。

## 4. 核心产品形态

AgentHub 采用 IM 式工作台，而不是传统表单式工作流编辑器。

### 4.1 首页工作台

首页提供一个统一输入框。用户可以：

- 直接发送任务，不提及 Agent 时默认由 Manager 接手。
- 使用 `@` 提及具体 Agent。
- 选择或自动创建工作空间。
- 使用“多 Agent”入口插入协作模式提示，例如智能编排、先组队、直接派活、复盘检查。

代码依据：`apps/web/src/pages/ChatPage.tsx`

### 4.2 左侧会话树

左侧会话树区分三类入口：

- Manager 私聊：与协调型 Agent 直接沟通。
- Worker 私聊：与单个 Worker Agent 沟通。
- Project 群聊：项目级群聊，承载多 Agent 协作主线。

群聊展开后只展示真实任务子对话，避免“假子会话”造成执行混乱。

代码依据：`apps/web/src/components/chat/SessionList.tsx`、`apps/web/src/lib/sessionTree.ts`

### 4.3 主群聊

主群聊负责展示：

- 用户目标
- Manager 的判断、计划和追问
- 成员加入 / 补员建议
- 任务看板和进度
- Worker 汇报
- 产物卡片
- 最终综合结论

代码依据：`apps/web/src/components/assistant-ui/Thread.tsx`

### 4.4 任务子对话

复杂任务会被拆到任务子对话中。每个 Worker 在自己的任务 room 中执行，用户可以进入查看完整过程，而主群聊保持干净，只展示计划、进度、汇报和最终结果。

代码依据：

- 任务子会话投影：`apps/web/src/stores/chatStore.ts`
- 任务线程服务：`apps/server/src/services/orchestrator/task-thread-service.ts`
- Worker 任务执行：`apps/server/src/services/worker-runtime/worker-runtime-service.ts`

### 4.5 产物与预览

AgentHub 不只展示聊天文本，还展示可交付文件。当前设计中，产物通过 ArtifactStore / SharedStorage 进入统一产物链路，并在前端以任务看板、产物卡、侧栏预览等方式呈现。

代码依据：

- 产物存储：`apps/server/src/services/orchestrator/artifact-store.ts`
- 产物控制：`apps/server/src/services/orchestrator/artifact-controller.ts`
- 前端产物预览：`apps/web/src/components/assistant-ui/Thread.tsx`

## 5. 核心流程

### 5.1 默认 Manager-first 流程

1. 用户在首页或群聊输入目标。
2. 前端创建或选择 workspace，并创建 group session。
3. 消息写入 Room timeline。
4. 如果没有明确提及 Worker，MatrixEventDispatcher 将消息交给 Manager。
5. Manager 判断：直接回答、追问、提出补员、拆解任务或最终汇总。

代码依据：

- 首页建 group session：`apps/web/src/pages/ChatPage.tsx`
- 发送消息：`apps/web/src/stores/chatStore.ts`
- 后端消息入口：`apps/server/src/routes/messages.ts`
- Room-first 写入：`apps/server/src/services/rooms/room-chat-bridge.ts`
- Manager 调度：`apps/server/src/services/rooms/matrix-event-dispatcher.ts`

### 5.2 多 Agent 执行流程

1. Manager 生成任务计划。
2. RunController 创建 run、task、task thread 等资源。
3. RoomController 确保任务 room 和参与者。
4. WorkerController 确保 WorkerInstance ready。
5. RuntimeLeaseController 创建运行租约。
6. WorkerRuntimeService 在任务 room 中执行 Code Agent。
7. Worker 把结果写回 task room，并登记产物。
8. Manager 读取任务结果、Room timeline 和 ArtifactStore，生成最终复盘。

代码依据：

- ManagerLoop：`apps/server/src/services/orchestrator/manager-loop.ts`
- RunController：`apps/server/src/services/orchestrator/run-controller.ts`
- WorkerController：`apps/server/src/services/orchestrator/worker-controller.ts`
- RuntimeLeaseController：`apps/server/src/services/orchestrator/runtime-lease-controller.ts`
- WorkerRuntimeService：`apps/server/src/services/worker-runtime/worker-runtime-service.ts`

## 6. 功能亮点

### 6.1 IM 式多 Agent 协作

用户不用先搭复杂工作流，直接在群聊里提出目标。系统把群聊、私聊、任务子对话组合成自然的协作界面。

### 6.2 Manager 默认接手

不提及 Agent 时，任务默认交给 Manager 判断。这符合真实团队协作：用户先找负责人，而不是一开始就选择具体执行人。

### 6.3 真实 Worker 执行

Worker 不只是 prompt 里的角色，而是可以绑定 Codex CLI、Claude Code、OpenCode、Gemini CLI 或 OpenClaw Worker 的运行实体。

### 6.4 Room-first 可追踪协作

Human、Manager、Worker 的消息和事件都进入 Room timeline，前端再从 timeline 和资源状态投影出消息、任务看板和产物。

### 6.5 任务看板与子对话

复杂任务不挤在主群聊里。主群聊看全局，子对话看执行细节，任务看板看状态。

### 6.6 本地优先与代码工作区

用户可以选择本地项目目录，也可以使用自动创建的本地 workspace。Agent 的执行目录、缓存、产物目录都有边界。

### 6.7 可交付产物导向

最终目标不是“回答完了”，而是交付代码、文档、表格、PPT、报告等可检查资产。

## 7. Demo 场景设计

### 场景一：Manager-first 智能编排

演示目标：

> 帮我做一个带表单验证的登录页，并输出实现说明。

演示步骤：

1. 首页输入任务，不手动指定 Agent。
2. 展示系统自动进入 Manager group。
3. Manager 解释任务理解和执行计划。
4. Manager 根据需要拆分给 Worker。
5. 前端显示任务看板、子对话和进度。
6. Worker 产出代码或说明。
7. Manager 汇总最终结果。

评委看到的价值：AgentHub 不是单轮聊天，而是从目标到执行再到复盘的协作系统。

### 场景二：指定 Worker 执行代码任务

演示目标：

> @Codex 给登录页面增加“记住密码”功能。

演示步骤：

1. 在群聊里 `@` 具体 Agent。
2. 展示消息被路由给对应 Worker。
3. 展示 Worker 执行状态和结果。
4. 展示代码 diff / 产物预览。

评委看到的价值：用户既可以让 Manager 自动调度，也可以直接点名 Worker。

### 场景三：文档 / PPT / 表格交付

演示目标：

> 帮我整理一份产品方案，并输出文档和表格。

演示步骤：

1. 选择“多 Agent - 先组队”。
2. Manager 提出需要的 Agent，例如调研、写作、表格整理、复盘。
3. 用户确认后执行。
4. 最终展示文档、表格和总结。

评委看到的价值：AgentHub 不局限于代码，也可以承载 Coze 风格的 AI 工作平台。

## 8. 比赛提交建议

建议视频控制在 3 分钟以内，采用一条主线：

1. 10 秒：说明 AgentHub 是本地优先的多 Agent 工作台。
2. 30 秒：首页输入目标，Manager 默认接手。
3. 60 秒：展示 Manager 计划、任务看板和 Worker 子对话。
4. 60 秒：展示 Worker 执行、产物卡和预览。
5. 20 秒：展示最终汇总和技术架构一句话。
6. 20 秒：总结亮点：IM 交互、真实 Worker、Room-first、产物交付、本地优先。

## 9. 当前边界

AgentHub 当前仍处于 alpha 阶段。比赛演示应聚焦已落地能力：

- 群聊 / 私聊 / 任务子对话
- Manager 默认接手
- 多 Agent 任务看板
- Worker Runtime 执行
- Room timeline 投影
- 产物登记和预览

不建议在比赛现场承诺完整专家市场、企业级云部署或完全成熟的权限系统；这些可以作为路线图展示。
