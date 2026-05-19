# AgentHub 系统架构设计 Spec

## Why
在需求分析阶段完成后，需要将 164 条功能需求、90+ 条非功能指标转化为可落地的系统架构设计。本阶段参考 12 篇技术文章中提炼的 Harness Engineering 最佳实践（Agent Loop 异步生成器、Fail-Closed 工具系统、四级上下文压缩管道、git worktree 并行隔离、MCP 协议标准化等），结合开源项目（虾饺IM、OpenClaw、HiClaw、AutoGen、CrewAI）的架构参考，设计 AgentHub 的完整系统架构。

## What Changes
- 创建 **系统架构总览文档**：逻辑架构图（分层架构） + 物理架构图（部署架构） + 核心数据流设计
- 创建 **模块设计文档**：8 大核心模块的详细设计（IM 会话层、Orchestrator 任务编排、Agent Harness 引擎、统一适配器层、代码 Diff 引擎、网页预览沙箱、一键部署流水线、基础设施层）
- 创建 **技术选型文档**：前端/后端/数据库/中间件/Agent 框架/Sandbox 的方案对比与推荐
- 创建 **集成与部署标准**：接口规范、环境配置、CI/CD 流水线设计
- 基于技术文章洞察，可能需要**调整优化需求文档**中的部分定义（如适配器层定位、协议选型、数据流设计）

## Impact
- Affected specs: agenthub-requirements-analysis（部分需求定义可能需要回写调整）
- Affected code: 全新项目，尚无代码，设计文档将指导后续全部开发
- Affected docs: `docs/02-系统设计/` 目录下新建 4 份核心设计文档 + 可能回写 `docs/01-需求分析/` 中的适配器层定义

## ADDED Requirements

### Requirement: 系统架构总览设计
系统 SHALL 提供完整的逻辑架构图和物理架构图，清晰展示分层结构和部署拓扑。

#### Scenario: 开发者查阅架构全景
- **WHEN** 新成员加入项目需要理解系统整体结构
- **THEN** 能够通过架构总览文档快速掌握：分层设计（表现层/网关层/编排层/执行层/基础设施层）、各层核心组件、层间数据流

#### Scenario: 运维人员准备部署环境
- **WHEN** 需要规划服务器资源和网络拓扑
- **THEN** 能够通过物理架构图了解：服务部署节点、数据库集群、缓存层、沙箱环境、网络策略

### Requirement: Harness 引擎核心设计
系统 SHALL 采用 Harness Engineering 范式（参考 Claude Code/Codex 开源架构），实现 Agent Loop 异步生成器、Tool Registry 权限治理、四级上下文压缩、预算熔断机制。

#### Scenario: Agent 执行长任务时上下文管理
- **WHEN** 对话轮次超过 50 轮，上下文接近模型窗口限制
- **THEN** 系统自动触发四级压缩管道：Snip裁剪 → Micro缓存压缩 → 上下文折叠 → Auto摘要，渐进降级而不丢失关键信息

#### Scenario: Agent 调用工具时权限越界
- **WHEN** Agent 尝试调用未授权的工具（如直接写文件而非通过 Diff 流程）
- **THEN** Tool Registry 在 Fail-Closed 默认值机制下拒绝调用，记录审计日志

#### Scenario: Token 预算超限
- **WHEN** 单任务 Token 消耗超过预算的 95%
- **THEN** 系统触发熔断：压缩上下文 → 切换小模型 → 强制收束返回 partial result

### Requirement: Orchestrator 任务编排设计
系统 SHALL 实现中心化 Orchestrator，独占用五项决策权：任务生命周期管理、执行计划裁决、Agent 路由、失败处理、硬终止条件。Planner 输出声明式计划（DAG），Orchestrator 接管执行。

#### Scenario: 用户提出复合开发需求
- **WHEN** 用户输入"帮我开发一个带登录功能的 Todo 应用"
- **THEN** Orchestrator 生成 DAG 计划：[前端页面生成]→[后端 API 生成]→[数据库模型]→[代码审查]→[预览]→[部署]，识别前后端可并行执行

#### Scenario: 子 Agent 执行失败
- **WHEN** 后端 Agent 生成 API 时出错
- **THEN** Orchestrator 根据失败策略决定：重试(最多3次)→降级(跳过非关键步骤)→终止(通知用户)，而非让出错 Agent 自己决定

### Requirement: 统一适配器层设计
系统 SHALL 实现协议归一化适配器层。**关键修正**：根据比赛要求和文章调研，适配器层定位为 **Agent 平台适配器**（封装 Claude Code/Codex CLI 或 API，统一为 AgentHub 内部标准接口），而非 IM 平台适配器。IM 交互在表现层实现。

#### Scenario: 接入新的 Agent 平台
- **WHEN** 需要接入新的 Agent 平台（如 Gemini CLI）
- **THEN** 开发者只需实现 `IAgentAdapter` 接口（sendMessage / onMessage / getCapabilities），无需修改 Orchestrator 或 Harness 层代码

#### Scenario: Agent 平台故障切换
- **WHEN** Claude Code 服务不可用
- **THEN** 适配器层自动切换至备选 Agent 平台（Codex），对上层业务透明

### Requirement: IM 会话层设计
系统 SHALL 参考虾饺IM 架构实现 WebSocket 实时通信、@指令解析、多会话并行管理。支持 Session 级状态隔离、消息持久化、流式回复渲染。

#### Scenario: 多会话并行
- **WHEN** 用户同时打开 3 个会话（需求讨论/代码生成/部署监控）
- **THEN** 每个会话独立维护 WebSocket 连接、历史消息、Orchestrator 实例，互不干扰

#### Scenario: @指令触发 Agent 协作
- **WHEN** 用户在群聊中输入 "@FrontendAgent 请优化这个按钮样式"
- **THEN** 系统解析 @指令 → 路由到对应 Agent → Orchestrator 分配任务 → 流式返回结果

### Requirement: 代码 Diff 与版本管理设计
系统 SHALL 基于 git worktree 实现 Agent 并行操作隔离。参考调研文章中"一个任务 → 一个分支 → 一个 worktree → 一个 Agent"的隔离原则。Diff 展示采用三路合并视图。

#### Scenario: 两个 Agent 同时修改不同文件
- **WHEN** FrontendAgent 修改 App.tsx，BackendAgent 修改 server.ts
- **THEN** 两个 Agent 在各自 git worktree 中独立工作，修改完成后展示 Diff，用户逐个确认后合并

#### Scenario: Agent 修改冲突
- **WHEN** 两个 Agent 同时修改同一文件
- **THEN** 系统检测冲突，展示三路合并视图（Base/AgentA/AgentB），由用户决定最终版本

### Requirement: 网页预览沙箱设计
系统 SHALL 提供安全的代码预览能力。比赛 Demo 阶段推荐 **纯前端 iframe + srcdoc** 方案（类似 CodePen）预览静态前端项目；架构预留 WebContainer 扩展接口。

#### Scenario: 用户查看前端代码效果
- **WHEN** Agent 完成前端页面代码生成
- **THEN** 系统在独立 iframe 沙箱中渲染页面，用户可实时查看效果、调整视口尺寸

#### Scenario: HMR 热更新预览
- **WHEN** Agent 修改了 CSS 样式代码
- **THEN** 预览沙箱通过 HMR 机制自动刷新，用户即刻看到变化

### Requirement: 一键部署流水线设计
系统 SHALL 提供从代码确认到上线部署的端到端自动化流水线。参考字节全自动化实践经验，设计 Build→Test→Deploy→Verify 四阶段流水线。

#### Scenario: 用户触发一键部署
- **WHEN** 用户确认所有 Diff 修改后点击"一键部署"
- **THEN** 系统依次执行：依赖安装 → 构建打包 → 运行测试 → 部署到目标环境 → 健康检查验证 → 返回部署结果和访问 URL

### Requirement: 技术选型设计
系统 SHALL 基于比赛约束（单人/小团队、快速迭代、Demo 展示）和架构需求，完成所有技术栈的方案对比与选型决策。遵循"善用开源、最小依赖"原则。

#### Scenario: 技术选型评审
- **WHEN** 需要确定前端框架、后端运行时、数据库、Agent 框架
- **THEN** 技术选型文档提供 2-3 个方案的量化对比（性能/生态/学习成本/部署复杂度），给出明确推荐和备选方案

### Requirement: 需求文档回写调整
基于技术文章调研和架构设计过程中发现的问题，系统 SHALL 对 `docs/01-需求分析/` 中的部分定义进行回写优化。

#### Scenario: 适配器层定义修正
- **WHEN** 架构设计明确了 Adapter Layer 是 Agent 平台适配器
- **THEN** 回写需求文档中 `IAgentAdapter` 接口定义，明确其职责为封装 Agent 平台，IM 平台集成在表现层独立处理

#### Scenario: MVP 范围裁剪清单
- **WHEN** 基于技术选型和资源评估明确了比赛 Demo 可交付范围
- **THEN** 补充一份 MVP 裁剪清单，标注哪些功能是 Demo 必须实现、哪些是架构预留扩展
