**AgentHub 飞书形态设计文档**\
版本：v0.1\
定位：AgentHub for Feishu\
目标：把 AgentHub 从“自研 IM 多 Agent 平台”扩展为“嵌入飞书群聊的多 Agent 协作编排器”。

> 状态：历史方案草稿，部分 runtime/协议边界已过期。当前权威路径请以 `docs/当前多Agent协作架构.md` 为准。

**1. 背景与结论**\
AgentHub 当前已经具备 Orchestrator、Runtime、Code Agent、Git 分支隔离、Artifact、Workspace、Web/Desktop 控制台等核心能力。继续完整自研 IM 会消耗大量产品和前端成本，且企业协作场景天然发生在飞书、企微、钉钉这类办公 IM 中。

飞书开放平台已经支持应用机器人接收消息、发送消息、回复消息、交互卡片、卡片回调、长连接事件等能力，因此 AgentHub 可以新增一种产品形态：

`飞书群聊 = 协作入口 AgentHub Server = 多 Agent 编排内核 AgentHub Desktop/Web = 本地执行与管理控制台`

结论：**可行，且适合作为比赛 Demo 的主叙事之一**。不建议推翻现有 Web IM，而是把飞书作为企业协作入口，把现有 Web/Desktop 降级为配置、执行、调试和产物详情控制台。

**2. 产品定位**\
AgentHub for Feishu 是一个飞书应用机器人。用户在飞书群中 @AgentHub 描述任务，AgentHub 自动生成执行计划，调度多个 Agent 协作，最后把结果、风险、产物摘要回写到群聊。

一句话：

> *在飞书群里召唤一个 AI 项目经理，它能拆任务、派 Agent、跑代码、审查结果，并把产物沉淀到 AgentHub 控制台。*

适用场景：

- 产品/研发群中快速拆解需求
- 代码仓库中的小功能实现、审查、重构
- 文档、方案、报告类多 Agent 协作
- 项目群里的任务进度总结
- 比赛 Demo 中展示“企业协作场景下的多 Agent 编排”

**3. 非目标**\
第一阶段不做：

- 不替代飞书原生 IM
- 不读取群内所有历史消息作为默认能力
- 不在飞书卡片里展示完整代码 diff
- 不做完整 SaaS 多租户商业化
- 不做飞书审批、日历、文档、知识库的深度集成
- 不在飞书中 token 级流式输出 Agent 回复

原因：飞书消息有频控，官方发送消息接口对同一用户和同一群组均有限频要求；飞书更适合承载摘要、状态和交互确认，完整工程细节仍应在 AgentHub 控制台展示。参考官方发送消息文档：**[![](https://open.feishu.cn/favicon.ico)发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)**。

**4. 飞书能力调研**\
关键能力如下：

**能力**

**用途**

**可行性**

接收消息事件 im.message.receive\_v1

用户在群里 @AgentHub 触发任务

可行

发送消息

回写计划、状态、总结

可行

回复消息

把结果挂到原始任务消息下

可行

交互卡片

展示 Plan、Dispatch、状态、产物

可行

卡片回调

用户点击“开始执行/取消/打开详情”

可行

长连接事件

本地 Demo 不依赖公网 webhook

可行

tenant access token

调用飞书 OpenAPI

必需

官方资料：

- **[![](https://open.feishu.cn/favicon.ico)接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)**
- **[![](https://open.feishu.cn/favicon.ico)发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)**
- **[![](https://open.feishu.cn/favicon.ico)回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply?lang=zh-CN)**
- **[![](https://open.feishu.cn/favicon.ico)配置卡片交互](https://open.feishu.cn/document/feishu-cards/configuring-card-interactions?lang=zh-CN)**
- **[![](https://open.feishu.cn/favicon.ico)卡片回传交互回调](https://open.feishu.cn/document/feishu-cards/card-callback-communication?lang=zh-CN)**
- **[![](https://open.feishu.cn/favicon.ico)tenant\_access\_token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal?lang=zh-CN)**

**5. 总体架构**\
推荐新增 Feishu Integration Layer，不侵入 Orchestrator 主体。

`Feishu Group / DM   ↓ message event / card callback Feishu Gateway   ↓ normalized command AgentHub Application Service   ↓ Workspace / Session / OrchestratorRun   ↓ Planner → TaskScheduler → RuntimeRegistry → Agent Runtime   ↓ Synthesizer / ConflictResolver / Artifact Store   ↓ Feishu Card / Message Reply / AgentHub Detail URL`

当前 AgentHub 中可复用：

- OrchestratorEngine.createPlan
- OrchestratorEngine.startRun
- TaskScheduler
- RuntimeRegistry
- LlmRuntime
- CodeAgentRuntime
- Skills / MCP / Rules 能力层
- GitBranchManager
- workspaceTasks
- orchestratorRuns
- messages.metadata.artifacts
- Web/Desktop 设置页、代码工具页、Workspace 绑定能力

新增的只是“飞书适配层”。

**6. 交互流程**\
核心流程：

`用户在飞书群输入： @AgentHub 帮我给当前项目加一个登录页，并做代码审查  1. 飞书推送消息事件 2. AgentHub 解析 chat_id、message_id、open_id、文本 3. 检查该 chat_id 是否已绑定 Workspace 4. 未绑定：回复绑定项目卡片 5. 已绑定：调用 Orchestrator 生成 Plan 6. 发送 Plan 卡片 7. 用户点击“开始执行” 8. 卡片回调进入 AgentHub 9. AgentHub 立即 ACK，并异步启动 run 10. 执行中更新状态卡片 11. 完成后发送 Summary 卡片 12. 用户点击“查看详情”进入 AgentHub Web/Desktop`

卡片回调要求服务端在 3 秒内响应，所以执行任务不能同步跑在回调请求里，必须采用“立即响应 + 后台任务”的模式。参考：**[![](https://open.feishu.cn/favicon.ico)卡片回传交互回调](https://open.feishu.cn/document/feishu-cards/card-callback-communication?lang=zh-CN)**。

**7. 命令设计**\
第一阶段支持最小命令集：

`@AgentHub 帮我实现 xxx @AgentHub /plan xxx @AgentHub /status @AgentHub /cancel <runId> @AgentHub /bind @AgentHub /help`

解析规则：

- 含 /plan：只生成计划，不执行
- 普通自然语言：生成计划卡片，等待用户确认
- /status：查询当前群最近一个 run
- /cancel：取消尚未完成的 run
- /bind：返回绑定 Workspace 的卡片或链接
- /help：返回使用说明

不建议第一版做复杂 slash command 注册，直接从文本解析即可。

**8. Workspace 映射**\
飞书群与 AgentHub Workspace 的关系：

`feishu_chat_id -> workspace_id -> group_session_id -> project_path`

推荐策略：

- 一个飞书群默认绑定一个 Workspace
- 一个 Workspace 可以被多个飞书群绑定，但第一版不开放
- 群未绑定 Workspace 时，只允许 /bind 和 /help
- 绑定动作在 AgentHub 控制台完成，避免在飞书里暴露本地路径

**9. 数据库设计**\
新增表建议：

`feishu_tenants - id - tenant_key - app_id - app_secret_encrypted - access_token_cache - token_expires_at - created_at - updated_at  feishu_chat_bindings - id - tenant_key - chat_id - chat_type - workspace_id - group_session_id - created_by_open_id - created_at - updated_at  feishu_message_links - id - tenant_key - chat_id - feishu_message_id - agenthub_message_id - session_id - run_id - task_id - kind - created_at  external_event_dedup - id - source - event_id - event_type - received_at`

external\_event\_dedup 必须有。飞书事件可能重试，点击按钮也可能重复触发，Orchestrator dispatch 必须幂等。

**10. 后端模块设计**\
建议目录：

`apps/server/src/services/feishu/   feishu-client.ts   feishu-token-store.ts   feishu-event-normalizer.ts   feishu-command-parser.ts   feishu-card-renderer.ts   feishu-run-reporter.ts   feishu-binding-service.ts   feishu-dedup.ts  apps/server/src/routes/feishu.ts`

职责：

- feishu-client.ts：封装发送消息、回复消息、更新卡片、获取 token
- feishu-token-store.ts：缓存 tenant\_access\_token
- feishu-event-normalizer.ts：把飞书事件转成内部事件
- feishu-command-parser.ts：解析 /plan、/status、自然语言任务
- feishu-card-renderer.ts：生成飞书卡片 JSON
- feishu-run-reporter.ts：监听 Orchestrator 状态并更新飞书
- feishu-binding-service.ts：维护 chat\_id -> workspace
- feishu-dedup.ts：事件幂等

**11. API 设计**\
新增服务端 API：

`POST /api/feishu/events - 飞书 webhook 事件入口 - 处理 URL 校验、消息事件、机器人进群事件等  POST /api/feishu/card-callback - 飞书卡片按钮回调 - 只做校验、幂等、任务入队、快速响应  GET /api/feishu/status - 返回飞书集成状态 - app_id 是否配置、token 是否可用、事件模式  POST /api/feishu/chats/:chatId/bind - 绑定飞书群到 Workspace  DELETE /api/feishu/chats/:chatId/bind - 解绑`

如果采用长连接事件，/api/feishu/events 可以只作为生产 webhook 备用，本地 Demo 由 server 启动时运行 event worker。

**12. 卡片设计**\
第一版四种卡片足够：

1. **绑定卡**
   - 标题：该飞书群尚未绑定 AgentHub Workspace
   - 内容：说明需要绑定本地项目
   - 按钮：打开控制台绑定
2. **Plan 卡**
   - 目标
   - Agent 分工
   - Task DAG 简表
   - 预计产物
   - 风险提示
   - 按钮：开始执行、取消、打开详情
3. **Run 状态卡**
   - run 状态：planning/running/synthesizing/completed/failed
   - 任务列表：pending/running/done/failed
   - 最近事件
   - 按钮：刷新、取消、打开详情
4. **Summary 卡**
   - 总结
   - 修改文件数
   - 关键产物
   - 风险
   - 下一步
   - 按钮：查看 Diff、打开预览、查看日志

飞书卡片只展示摘要；完整 diff、日志、preview 仍进入 AgentHub 控制台。

**13. 状态同步策略**\
不要 token 级同步。建议：

`Agent token stream -> AgentHub 内部 message:stream 阶段性聚合 -> Feishu RunStatusCard update 最终结果 -> Feishu SummaryCard`

更新节奏：

- 状态变化立即更新
- 长任务每 5-10 秒最多更新一次
- 每个 Agent 完成时更新一次
- 最终 Synthesizer 完成后发 Summary

这样符合飞书消息频控，也避免群聊刷屏。

**14. Orchestrator 改造点**\
现有 Orchestrator 需要抽象一个 reporter：

`interface RunReporter {   onRunStarted(event): Promise<void>   onTaskStarted(event): Promise<void>   onTaskCompleted(event): Promise<void>   onTaskFailed(event): Promise<void>   onRunCompleted(event): Promise<void>   onRunFailed(event): Promise<void> }`

已有 WebSocket reporter 继续服务当前 Web UI；新增 FeishuRunReporter 负责更新飞书卡片。这样不会把飞书逻辑写进 OrchestratorEngine。

**15. 权限与安全**\
MVP 建议最小权限：

- 开启机器人能力
- 接收机器人消息事件
- 发送/回复单聊、群组消息
- 卡片回调
- 可选：获取机器人所在群列表

不建议默认申请“获取群组中所有消息”。第一版只响应 @AgentHub，降低权限敏感度。

安全要求：

- app\_secret 加密存储
- tenant\_access\_token 只缓存，不写明文长期日志
- 所有飞书 event 做签名/校验
- 事件幂等
- 卡片 callback 做用户权限校验
- Code Agent 写入仍受 sandboxPolicy 控制
- 飞书群用户不能绕过 AgentHub 的 Workspace 绑定和本地执行确认

**16. 本地 Demo 方案**\
比赛演示推荐：

`AgentHub Desktop 启动   -> 启动本地 server   -> 启动 Feishu 长连接事件 worker   -> 飞书群 @AgentHub   -> 本地 AgentHub 执行任务   -> 飞书群收到卡片和总结`

优点：

- 不需要公网域名
- 不需要 ngrok
- 更符合“本地桌面多 Agent 工作台”
- 演示链路稳定

生产形态再切到 webhook：

`Feishu OpenAPI webhook -> Cloud AgentHub Gateway -> User Desktop Runner`

**17. 实施计划**\
P0：飞书基础连通，1-2 天

- 配置飞书应用机器人
- 新增飞书 env
- 接收 @AgentHub
- 发送文本回复
- 建立 chat\_id -> workspace\_id 绑定

P1：Plan 卡闭环，2-3 天

- 解析自然语言任务
- 调用 createPlan
- 渲染 Plan 卡
- 处理“开始执行”按钮
- 创建 orchestrator\_run

P2：Run 状态与总结，2-4 天

- 新增 RunReporter
- 实现 FeishuRunReporter
- 状态卡限频更新
- Summary 卡回写
- 详情链接跳转 Web/Desktop

P3：产物闭环，3-5 天

- Diff 详情页 URL
- Preview URL
- 日志详情页
- 飞书 Summary 卡展示产物索引
- /status、/cancel

P4：完善安全与演示体验，2-3 天

- 事件幂等
- token cache
- callback 权限校验
- 失败重试
- 演示脚本和种子数据

**18. 风险与应对**

**风险**

**影响**

**应对**

飞书消息频控

不能实时刷 token

只做阶段性卡片更新

卡片回调超时

用户点击失败

3 秒内 ACK，后台异步执行

本地服务无公网地址

webhook 难调试

Demo 用长连接事件

权限申请复杂

上线周期变长

MVP 只响应 @机器人

Code Agent 执行不可控

误改项目

保留 sandboxPolicy、approvalRequired、Git 分支隔离

飞书卡片不适合复杂 diff

展示受限

只展示摘要，详情跳 AgentHub

多次点击 Dispatch

重复执行

callback 幂等，run 状态锁

**19. 推荐比赛叙事**\
不要说“我们改用飞书，所以不用做 IM”。

更好的说法：

> *AgentHub 支持两种形态：*
>
> 1. *自带 Web/Desktop 工作台，适合本地调试和产物查看。*
> 2. *飞书协作入口，适合真实企业团队在已有群聊中召唤多 Agent。*
>
> *我们的核心不是聊天 UI，而是多 Agent 编排、任务 DAG、Code Agent 执行、Git 分支隔离和产物闭环。飞书形态证明 AgentHub 可以嵌入真实办公流。*

**20. 最终建议**\
把飞书形态列为 AgentHub 的“企业协作入口”，不要替换现有架构。当前最务实的落地方式是：

`先做飞书入口 MVP 保留 Web/Desktop 控制台 复用现有 Orchestrator 和 Runtime 用卡片承载计划、确认、状态、总结 用 AgentHub 页面承载 diff、preview、logs`
