# Tasks

- [x] Task 1: 系统架构总览设计 — 产出 `docs/02-系统设计/系统架构总览.md`
  - [x] 1.1 绘制逻辑架构图（分层架构：表现层/网关层/编排层/Harness层/适配器层/基础设施层），使用 Mermaid 图表
  - [x] 1.2 绘制物理架构图（部署拓扑：服务节点、数据库、缓存、沙箱、网络），使用 Mermaid 图表
  - [x] 1.3 设计核心数据流（用户消息 → IM会话 → Orchestrator → Agent → Diff → 预览 → 部署的完整链路）
  - [x] 1.4 定义各层职责边界与接口契约（层间通信协议、数据格式）

- [x] Task 2: 技术选型文档 — 产出 `docs/02-系统设计/技术选型方案.md`
  - [x] 2.1 前端技术栈对比选型（Next.js vs Vite+React vs 纯HTML，推荐 Next.js App Router）
  - [x] 2.2 后端运行时对比选型（Bun vs Node.js+Fastify vs Go，推荐 Bun 兼顾性能与生态）
  - [x] 2.3 数据库方案对比选型（PostgreSQL+pgvector vs SQLite vs MongoDB，推荐 PostgreSQL）
  - [x] 2.4 Agent 框架策略（自研轻量 Harness vs LangGraph vs CrewAI，推荐自研参考 Claude Code 架构）
  - [x] 2.5 沙箱方案对比选型（iframe+srcdoc vs WebContainer vs Docker，推荐 MVP 用 iframe）
  - [x] 2.6 实时通信方案（WebSocket vs SSE vs Socket.io，推荐 WebSocket 原生）
  - [x] 2.7 输出技术选型总览表和实施路线图

- [x] Task 3: 模块设计文档 — 产出 `docs/02-系统设计/模块详细设计.md`
  - [x] 3.1 IM会话模块设计（WebSocket连接管理、消息持久化、@指令解析器、多会话状态隔离）
  - [x] 3.2 Orchestrator编排模块设计（任务状态机、DAG计划生成、Agent路由表、失败降级策略、max_steps/max_tokens/max_duration/max_tool_calls四道硬闸）
  - [x] 3.3 Agent Harness引擎设计（AsyncGenerator Agent Loop、Tool Registry权限治理、四级上下文压缩管道、预算熔断机制、Memory系统（Working/Session/Long-term三层））
  - [x] 3.4 统一适配器层设计（IAgentAdapter接口定义、Claude Code适配器实现方案、Codex适配器实现方案、MCP协议桥接、故障切换机制）
  - [x] 3.5 代码Diff与版本管理设计（git worktree隔离机制、三路合并Diff视图、冲突检测与合并策略、Git操作封装）
  - [x] 3.6 网页预览沙箱设计（iframe+srcdoc沙箱、多设备视口切换、HMR热更新、安全隔离策略）
  - [x] 3.7 一键部署流水线设计（Build/Test/Deploy/Verify四阶段、部署状态追踪、健康检查、回滚机制）
  - [x] 3.8 基础设施模块设计（数据库Schema、Redis缓存策略、文件存储、日志与可观测性）

- [x] Task 4: 集成与部署标准 — 产出 `docs/02-系统设计/集成与部署规范.md`
  - [x] 4.1 REST API 接口规范（命名约定、请求/响应格式、错误码体系、分页标准）
  - [x] 4.2 WebSocket 消息协议（消息类型枚举、心跳机制、重连策略）
  - [x] 4.3 环境配置规范（开发/测试/生产环境、环境变量管理、密钥管理）
  - [x] 4.4 CI/CD 流水线设计（代码检查→测试→构建→部署自动化流程）

- [x] Task 5: 需求文档回写优化 — 调整 `docs/01-需求分析/` 相关文档
  - [x] 5.1 修正 `AgentHub-需求规格说明书-v1.0.md` 中适配器层定义（从模糊的"统一适配器"明确为"Agent平台适配器"）
  - [x] 5.2 补充 MVP 裁剪清单（标注 164 条需求中比赛 Demo 必须实现 vs 架构预留扩展）
  - [x] 5.3 统一命名规范（接口层驼峰命名 createdAt，数据库层映射为下划线 created_at）

# Task Dependencies
- Task 2 依赖 Task 1（技术选型需基于架构分层确定）
- Task 3 依赖 Task 1 & Task 2（模块设计需基于架构分层和技术选型）
- Task 4 依赖 Task 3（集成标准需基于模块接口确定）
- Task 5 可与 Task 1-4 并行（需求回写基于调研结论，不依赖设计产出）
- Task 1 和 Task 5 可并行启动