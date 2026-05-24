# AgentHub 当前实现口径

本文档用于比赛冲刺期间统一“已实现能力”和“后续规划”的表述，避免演示材料承诺超过当前代码。

## 已落地技术栈

- 前端：Vite + React + TypeScript + Tailwind CSS + assistant-ui 相关组件。
- 后端：Bun + Hono + TypeScript。
- 数据：SQLite + Drizzle ORM，本地 `storage/agenthub.db`。
- Agent 运行：普通 LLM Agent、Code Agent CLI 适配入口、Native read-only Agent 工具循环。
- 本地模式：当前默认是单用户 Demo，`authMiddleware` 注入 `default-user`，未实现生产级登录、权限、团队租户隔离。

## 已实现演示能力

- 会话列表支持新建、搜索、置顶、归档、本地持久化偏好和最近活跃排序；消息收发支持 Markdown/代码高亮、WebSocket 流式回复和取消。
- Agent 回复支持 `metadata.artifacts` 结构化产物渲染，当前已内联展示网页预览、Diff、文件附件和部署状态卡片；比赛演示可通过“预览 / diff / 部署 / 文件”类指令触发 Demo 卡片。
- 模型配置、连接测试、Codex/Claude Code/OpenCode 本机 CLI 探测与配置入口。
- 统一 Code Agent adapter catalog 已暴露到 API，可展示 Codex、Claude Code、OpenCode 的安装、配置、执行开关和就绪原因；自动执行仍受本地安全开关与 Agent 高风险确认控制。
- 工作区绑定本地项目文件夹，创建 Agent 成员与任务，派发任务到独立会话。
- Agent Group 群聊、`@orchestrator` 任务卡、任务分发、汇总会话；支持在群聊中通过“创建/添加/新建 Agent”生成可编辑 Agent 草案并确认加入当前 Agent Group。
- 聊天侧栏会在当前项目中展示 Agent 联系人，包含 Orchestrator 与自建 Agent 的名称、角色、运行时和能力标签，可点击提及或打开 Agent 子会话。
- Native read-only Agent 可通过只读工具理解工作区文件，不会修改文件。

## 明确作为后续规划

以下能力在当前代码中不是完整可演示实现，路演时应表述为路线图或扩展方向：

- Next.js / Express 重构。
- Sandpack iframe 真预览与 Vercel/Netlify 一键部署闭环。
- 完整 MCP/A2A 协议互操作。
- NATS、Redis Streams、Mem0、OpenTelemetry 等生产级基础设施。
- 多用户登录、团队权限、云端持久化运行队列。

## 安全边界

- API Key 会保存到本机 SQLite `settings` 表；只应填写比赛演示需要的本地凭据。
- Code Agent 自动执行默认关闭：`AGENTHUB_ENABLE_CODE_AGENT_EXECUTION=false`。
- 如需开启 Code Agent 写入能力，只在受控的本地测试仓库中开启，并保持 Agent 的 `approvalRequired` 默认开启，避免误改真实项目。
