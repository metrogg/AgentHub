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
| UI / CSS | Tailwind CSS + Radix UI primitives + `@assistant-ui/react` |
| 状态管理     | Zustand                                                    |
| 数据库      | SQLite (`bun:sqlite`) + Drizzle ORM（WAL 模式）                |
| LLM 接入   | 自研流式客户端（OpenAI-compatible + Anthropic）                     |
| 共享契约     | Zod schemas + 常量（`packages/shared`）                        |
| 包管理器     | Bun（`bun.lock`）                                            |

## 项目结构

```
├── apps/
│   ├── server/          # Hono REST API + WebSocket 服务端
│   │   ├── src/
│   │   │   ├── index.ts           # 入口：种子默认用户、启动 Bun.serve、恢复未完成 Run
│   │   │   ├── app.ts             # Hono 应用：CORS、错误处理、路由挂载
│   │   │   ├── env.ts             # Zod 校验的环境变量配置
│   │   │   ├── middleware/auth.ts # 单用户模式（无鉴权，注入默认用户）
│   │   │   ├── routes/            # API 路由（Hono sub-routers）
│   │   │   │   ├── sessions.ts
│   │   │   │   ├── messages.ts    # 核心：统一消息路由（@mention / simpleReply / orchestratorPlan）
│   │   │   │   ├── workspaces.ts  # 核心：Workspace、Agent、任务、派发、汇总
│   │   │   │   ├── settings.ts
│   │   │   │   ├── coding-tools.ts# Codex / Claude Code / OpenCode 适配
│   │   │   │   ├── skills.ts
│   │   │   │   └── artifacts.ts
│   │   │   └── services/          # 业务逻辑层
│   │   │       ├── agent-runner.ts        # WebSocket 房间管理 + Agent 回复流
│   │   │       ├── llm-client.ts          # 多供应商 LLM 流式客户端
│   │   │       ├── llm.ts                 # 薄封装
│   │   │       ├── runtime/               # Agent Runtime 统一适配层
│   │   │       │   ├── agent-runtime.ts   # 统一接口定义
│   │   │       │   ├── runtime-registry.ts# Runtime 注册中心
│   │   │       │   ├── llm-runtime.ts     # LLM 对话 Runtime
│   │   │       │   ├── native-tool-runtime.ts # 原生只读工具 Runtime
│   │   │       │   ├── code-agent-runtime.ts  # Code Agent Runtime
│   │   │       │   └── index.ts
│   │   │       ├── orchestrator/          # Orchestrator 引擎
│   │   │       │   ├── orchestrator-engine.ts # 总控引擎：dispatch、resumeRun、Agent 自主性
│   │   │       │   ├── planner.ts         # Task DAG 生成器（异步）
│   │   │       │   ├── task-scheduler.ts  # 并发调度引擎
│   │   │       │   ├── task-graph.ts      # DAG 工具类
│   │   │       │   ├── synthesizer.ts     # LLM 智能聚合
│   │   │       │   ├── conflict-resolver.ts # 代码冲突检测与解决
│   │   │       │   ├── fallback-engine.ts # 失败降级引擎
│   │   │       │   ├── types.ts           # 共享类型定义（含 ClarificationRequest、AgentAutonomySignals）
│   │   │       │   └── index.ts
│   │   │       ├── git/                   # Git 分支隔离
│   │   │       │   └── branch-manager.ts  # 分支生命周期管理
│   │   │       ├── group-chat/            # @deprecated 旧群聊对话循环（已废弃，工具函数保留）
│   │   │       │   ├── group-chat-manager.ts