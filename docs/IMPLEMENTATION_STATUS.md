# AgentHub 当前实现口径

本文档用于比赛冲刺期间统一"已实现能力"和"后续规划"的表述，避免演示材料承诺超过当前代码。

## 已落地技术栈

- 前端：Vite + React + TypeScript + Tailwind CSS + assistant-ui 相关组件。
- 后端：Bun + Hono + TypeScript。
- 数据：SQLite + Drizzle ORM，本地 `storage/agenthub.db`。
- Agent 运行：Runtime 统一适配层（`llm` / `code-agent` / `mcp`），通过 `RuntimeRegistry` 根据 Agent profile 自动路由。
- Orchestrator 引擎：DAG 任务图生成、拓扑排序分层并发调度（默认 max 3）、失败降级、LLM 智能聚合、代码冲突检测与解决。
- Git 分支隔离：每个非 read-only Agent 任务自动切出 `agenthub/{runId}/{agentKey}/{taskId}` 分支，执行完毕后提取 diff，支持多 Agent 冲突检测。
- 本地模式：当前默认是单用户 Demo，`authMiddleware` 注入 `default-user`，未实现生产级登录、权限、团队租户隔离。

## 已实现演示能力

- 会话列表支持新建、搜索、置顶、归档、本地持久化偏好和最近活跃排序；消息收发支持 Markdown/代码高亮、WebSocket 流式回复和取消。
- Agent 回复支持 `metadata.artifacts` 结构化产物渲染，当前已内联展示网页预览、Diff、文件附件和部署状态卡片；比赛演示可通过"预览 / diff / 部署 / 文件"类指令触发 Demo 卡片。
- 模型配置、连接测试、Codex/Claude Code/OpenCode 本机 CLI 探测与配置入口。
- 统一 Code Agent adapter catalog 已暴露到 API，可展示 Codex、Claude Code、OpenCode 的安装、配置、执行开关和就绪原因；自动执行由 Agent 的 `sandboxPolicy` 控制（`read-only` / `workspace-write` / `danger-full-access`）。
- 工作区绑定本地项目文件夹，创建 Agent 成员与任务，派发任务到独立会话。
- Agent Group 群聊、`@orchestrator` 任务卡、任务分发、汇总会话；支持在群聊中通过"创建/添加/新建 Agent"生成可编辑 Agent 草案并确认加入当前 Agent Group。
- 聊天侧栏会在当前项目中展示 Agent 联系人，包含 Orchestrator 与自建 Agent 的名称、角色、运行时和能力标签，可点击提及或打开 Agent 子会话。
- Native read-only Agent 可通过只读工具理解工作区文件，不会修改文件。
- **Orchestrator 调度**：`@orchestrator` 触发后，LLM 生成 Task DAG，按依赖层级并发执行，失败支持重试和 fallback Agent 降级，最终由 LLM 聚合为统一报告发到群聊。
- **Git 分支隔离**：Code Agent 在独立分支执行代码变更，多 Agent 并发修改同一文件时自动检测冲突，支持自动合并或 LLM 3-way merge（冲突检测框架就绪，base 内容从 git 获取待完善）。
- **Synthesizer**：替代原有字符串拼接汇总，调用 LLM 智能整合各 Agent 产出，消除重复、标注贡献者、指出风险。

## 明确作为后续规划

以下能力在当前代码中不是完整可演示实现，路演时应表述为路线图或扩展方向：

- Next.js / Express 重构。
- Sandpack iframe 真预览与 Vercel/Netlify 一键部署闭环。
- 完整 MCP/A2A 协议互操作。
- NATS、Redis Streams、Mem0、OpenTelemetry 等生产级基础设施。
- 多用户登录、团队权限、云端持久化运行队列。
- FallbackEngine 深度集成：当前仅记录 `error_log`，未实现自动重试/切换 fallback agent 的闭环调度。
- 前端进度面板：未消费 `task:update` WebSocket 事件展示 DAG 执行进度（不影响现有功能）。

## 安全边界

- API Key 会保存到本机 SQLite `settings` 表；只应填写比赛演示需要的本地凭据。
- Code Agent 自动执行默认开启：`AGENTHUB_ENABLE_CODE_AGENT_EXECUTION=true`。
- 实际隔离由 Agent 的 `sandboxPolicy` 控制：
  - `read-only`：不切分支，只读取文件
  - `workspace-write`：切独立 Git 分支，执行后提取 diff
  - `danger-full-access`：同样走分支隔离，但允许更多操作
- 如需演示 Code Agent 写入能力，只在受控的本地测试仓库中操作，并保持 Agent 的 `approvalRequired` 默认开启，避免误改真实项目。
- 隔离分层：AgentHub Git 分支层 → CLI 工具自带 OS 级沙箱（Seatbelt/seccomp/Landlock）。
