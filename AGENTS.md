# AgentHub

> 本文档供 AI Coding Agent 阅读。如果你是人类开发者，请优先参考 `CLAUDE.md` 和 `docs/` 目录下的产品设计/技术设计文档。

## 项目概述

AgentHub 是一个**多 Agent 协作平台**（IM 式群聊交互），用户可以单独与 AI Agent 对话，也可以通过 Orchestrator 协调多个 Agent（架构师、实现者、审查者、研究员等）共同完成任务。项目为**字节跳动 AI 全栈挑战赛**参赛作品。

核心交互范式：

- **单聊（Direct）**：用户与一个 Agent 一对一对话。
- **群聊（Group）**：Workspace 级别的 Agent Group，支持 `@Agent名` 指定回复对象。
- **协调器（Orchestrator）**：`@orchestrator` 或系统自动判断复杂意图后触发，异步生成 Task DAG → 用户审阅 → 分发执行。支持并发调度、失败降级、Agent 自主提问/拒绝/进度报告、代码冲突处理。
- **实时任务看板（TaskBoard）**：在 `WorkspaceChatPage` 中展示 DAG 任务树，实时更新状态、进度条、Run 生命周期。

核心执行路径（统一路由）：

```
用户发消息 → intentRouter 判断意图
  ├── 简单问答 → handleSimpleReply() → Orchestrator 单 Agent 直接回复
  ├── 复杂任务 → generatePlanAndPushTaskBoard() → 异步生成 Task DAG → WebSocket 推送 task_board:plan_ready
  └── @Agent名  → 直接路由到指定 Agent 回复
```

## 技术栈

| 层面       | 技术选型                                                       |
| -------- | ---------------------------------------------------------- |
| 运行时      | Bun >= 1.1.0                                               |
| Monorepo | Bun workspaces (`apps/*`, `packages/*`)                    |
| 后端框架     | Hono + Bun.serve（HTTP + WebSocket 同一端口）                    |
| 前端框架     | React 18 + Vite + TypeScript                               |
| UI / CSS | Tailwind CSS + Radix UI primitives + `@assistant-ui/react`