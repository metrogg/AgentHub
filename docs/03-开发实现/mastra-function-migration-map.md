# Mastra 功能迁移映射

本文档记录 `F:\Learning\mastra\mastra-main` 中 Studio/Playground 能力迁移到 AgentHub 的落点。

## 参考源

- `packages/playground`：Mastra Studio 的页面结构、导航、Agent 运行台、工作流、评估、日志、追踪、工作区等功能。
- `packages/playground-ui`：日志、追踪、过滤器、面板、设计系统与基础组件。
- `client-sdks/client-js/src/client.ts`：Mastra 客户端暴露的资源 API，是功能迁移的主要边界。
- `packages/core/src/workspace/tools`：工作区文件、命令、搜索、补丁等工具能力。

## 已落地到 AgentHub

| Mastra 能力 | AgentHub 落点 | 状态 |
| --- | --- | --- |
| `listAgents/getAgent` | `/api/studio/modules/agents`、`/api/studio/agents/:agentId`、Agent 聊天页 | 已接入 |
| Agent Chat | `/agents/:agentId/chat/new` | 已接入 |
| Agent Network / `agent.network()` | 工作室“Agent 集群”模块、`/api/studio/clusters`、`/api/mastra/networks` | 已接入 |
| Agent Editor | Agent 页“编辑器”标签，支持保存模型、提示词、工具、工作流、处理器、评分器、记忆、追踪 | 已接入 |
| Agent Evaluation | Agent 页“评估”标签，`POST /api/studio/agents/:agentId/evaluations` | 已接入 |
| Agent Review | Agent 页“审查”标签，`PATCH /api/studio/agents/:agentId/reviews/:reviewId` | 已接入 |
| Agent Traces | Agent 页“追踪”标签 | 已接入 |
| Memory Threads | Agent 页“记忆”标签、工作室“记忆”模块 | 已接入 |
| Tools | 工作室“工具”模块 | 已接入 |
| Workflows | 工作室“工作流”模块 | 已接入 |
| Processors | 工作室“处理器”模块 | 已接入 |
| MCP Servers | 工作室“MCP 服务”模块 | 已接入 |
| Prompt Blocks | 工作室“提示词”模块 | 已接入 |
| Request Context | 工作室“请求上下文”模块 | 已接入 |
| Workspace | 工作室“工作区”模块，含 Mastra 参考源码文件迁移辅助面板 | 已接入 |
| Scorers | 工作室“评分器”模块 | 已接入 |
| Datasets | 工作室“数据集”模块 | 已接入 |
| Experiments | 工作室“实验”模块 | 已接入 |
| Metrics | 工作室“指标”模块 | 已接入 |
| Traces | 工作室“追踪”模块 | 已接入 |
| Logs | 工作室“日志”模块 | 已接入 |
| Background Tasks | 工作室“后台任务”模块 | 已接入 |
| Schedules | 工作室“调度”模块 | 已接入 |
| Vectors/Embedders | 工作室“向量库”“嵌入模型”模块 | 已接入 |
| Tool/Processor Providers | 工作室“工具供应商”“处理器供应商”模块 | 已接入 |
| Builder Settings/System Packages | 工作室“设置”“资源”“Agent Builder”模块 | 已接入 |

## 当前实现方式

- 后端新增 `apps/server/src/services/studio-registry.ts`，作为 Mastra 功能边界的本地注册表和状态层。
- 后端新增 `apps/server/src/routes/studio.ts`，统一暴露工作室模块、动作、Agent 配置、评估、审查和事件。
- 后端新增 `apps/server/src/routes/mastra-compat.ts`，在 `/api/mastra/...` 下提供接近 Mastra client SDK 的资源接口。
- 前端新增 `apps/web/src/api/studio.ts`，工作室页面和 Agent 页面统一通过它访问 Studio API。
- `apps/web/src/pages/StudioModulePage.tsx` 已从静态表格升级为可查询、可筛选、可执行动作、可查看详情与事件的工作室模块页。
- `apps/web/src/features/studio/ModuleWorkbench.tsx` 为工作流、追踪、日志、数据集、评估、工具、MCP、记忆、调度等模块提供专用工作台视图。
- `apps/web/src/features/studio/ModuleWorkbench.tsx` 已加入 Agent 集群工作台，用于展示 topology、routing agent、sub-agents、路由、策略和运行历史。
- `apps/web/src/pages/ChatPage.tsx` 已从纯聊天页升级为 Mastra 风格 Agent 运行台。

## 后续增强

- 将 `studio-registry` 的内存状态持久化到数据库。
- 把工作流图、Trace Span 树、日志过滤器从列表形态升级为可钻取视图。
- 将 MCP、Tool、Workflow 的“运行”动作接入真实执行器。
- 将 Dataset/Experiment 与真实评估样本和评分结果打通。
- 将 Agent 集群运行接入真实 `agent.network()`、流式事件和 HITL 暂停/恢复。
