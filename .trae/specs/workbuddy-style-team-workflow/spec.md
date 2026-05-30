# WorkBuddy 风格专家团流程改造 Spec

## Why

AgentHub 当前的多 Agent 协作流程存在三个核心问题：1) 必须绑定 projectPath 才能让 Agent 写文件，无目录时只能"聊天"不能"干活"；2) 用户发起任务需要经历"等 Plan 生成 → 审阅 → 点分发"三步，启动链路太长；3) Agent 的产物只存在数据库文本消息里，用户看不到真实文件。对比 WorkBuddy 专家团"输入需求 → 直接开干 → 产出真实文件 + 可预览"的体验，差距明显。

## What Changes

### P0：Agent 能默认产出真实文件（3 项）
- **解耦 projectPath**：无 projectPath 时默认创建临时工作目录，Agent 可在其中读写文件
- **简单任务跳过 Plan**：单文件/单功能任务直接 dispatch，不再等 LLM 生成 Plan + 用户审阅 + 手动分发
- **Agent 产物落地为文件**：Code Agent 产出的代码文件写入磁盘，前端展示为可预览/下载的文件卡片

### P1：WorkBuddy 风格交互体验（3 项）
- **左侧 Agent 标签页**：在 WorkspaceChatPage 左侧展示 Agent 列表，支持一键切换查看各 Agent 的独立对话
- **结构化交付报告**：替代现有文本摘要，改为表格化交付报告组件（状态 + QA + 文件清单 + 功能列表）
- **产物内嵌预览**：HTML/Markdown 产物支持右侧 iframe 预览

### P2：开箱即用的预设团队（3 项）
- **5 个预设专家团模板**：软件开发团、内容创作团、数据分析团、网站搭建团、调研报告团
- **团长动态交接能力**：Orchestrator Agent 支持在运行中动态创建后续任务（如工程师完成→自动创建 QA 任务）
- **产物下载/导出**：支持将 Agent 产出的文件打包下载或导出到指定目录

## Impact

- Affected specs: architecture-overhaul (消息路由、TaskBoard)
- Affected code:
  - `apps/server/src/services/orchestrator/orchestrator-engine.ts` — 解耦 projectPath、团长动态交接
  - `apps/server/src/services/execution/agent-execution-envelope.ts` — 默认工作目录逻辑
  - `apps/server/src/routes/messages.ts` — 简单任务跳过 Plan
  - `apps/web/src/pages/WorkspaceChatPage.tsx` — 左侧 Agent 标签页 + 右侧预览
  - `apps/web/src/components/TaskBoard.tsx` — 新增交付报告组件、文件卡片
  - `apps/web/src/stores/chatStore.ts` — Agent 标签页状态
  - `packages/shared/src/agent-role-presets.ts` — 5 个专家团预设
  - `packages/db/src/schema.ts` — 产物文件记录（按需）

---

## ADDED Requirements

### Requirement: Agent 默认工作目录
当 workspace 未绑定 projectPath 时，系统 SHALL 自动为每个 Run 创建临时工作目录，Agent 可在其中自由读写文件。目录路径为 `{项目根}/storage/.agenthub/workspaces/{runId}/`，所有 Agent 共享该目录（文件级别冲突由 Agent 自行避免）。

#### Scenario: 无 projectPath 的群聊创建代码产物
- **GIVEN** workspace 的 projectPath 为 null
- **WHEN** 用户发起一个需要生成 HTML 文件的任务
- **THEN** 系统在 `storage/.agenthub/workspaces/{runId}/` 创建目录
- **AND** Code Agent 的 cwd 指向该目录
- **AND** Agent 产出的文件（如 index.html）写入该目录
- **AND** 前端展示文件卡片（文件名 + 路径 + 预览按钮）

#### Scenario: 有 projectPath 时保持现有行为
- **GIVEN** workspace 的 projectPath 为 "/home/user/my-project"
- **WHEN** 用户发起代码任务
- **THEN** 系统继续使用 Git worktree 隔离机制，不改变现有行为

### Requirement: 简单任务跳过 Plan 审批
系统 SHALL 在 intentRouter 中增加任务复杂度分级（SIMPLE / MODERATE / COMPLEX）。SIMPLE 任务（单文件、单功能、模式明确）跳过 Plan 生成 + 用户审阅步骤，直接 dispatch 执行。

#### Scenario: 简单任务直接执行
- **GIVEN** 用户在群聊中发送"帮我写一个贪吃蛇游戏的 HTML 页面"
- **WHEN** intentRouter 判定为 SIMPLE 复杂度
- **THEN** 系统直接调用 OrchestratorEngine.dispatch() 执行
- **AND** 不生成 Plan Card，不等待用户审阅
- **AND** Agent 直接产出文件并推送给前端

#### Scenario: 复杂任务仍走 Plan 流程
- **GIVEN** 用户发送"开发一个电商网站，包含用户系统、商品管理、订单系统"
- **WHEN** intentRouter 判定为 COMPLEX 复杂度
- **THEN** 系统走现有异步 Plan 生成 + TaskBoard 展示 + 用户确认分发流程

### Requirement: Agent 产物文件卡片
前端 SHALL 在聊天流中展示 Agent 产出的文件卡片，包含文件名、文件类型图标、文件大小、预览按钮（HTML/MD/SVG 类型）和下载按钮。

#### Scenario: HTML 文件产物展示与预览
- **GIVEN** Agent 产出了一个 index.html 文件
- **WHEN** 文件路径写入 message.metadata.artifacts
- **THEN** 聊天流中渲染文件卡片，显示 "index.html" + HTML 图标
- **AND** 点击"预览"按钮，右侧面板以 iframe 渲染该 HTML

#### Scenario: 代码文件产物展示
- **GIVEN** Agent 产出了一个 app.py 文件
- **WHEN** 文件路径写入 message.metadata.artifacts
- **THEN** 聊天流中渲染文件卡片，显示 "app.py" + Python 图标
- **AND** 点击"查看"按钮，展开代码预览（语法高亮）
- **AND** 提供"下载"按钮

### Requirement: Agent 标签页切换
WorkspaceChatPage SHALL 在左侧（聊天流区域左侧）展示 Agent 标签页列表，每个标签显示 Agent 名称、角色图标、状态（运行中/已完成/失败）。用户点击标签可切换到该 Agent 的独立对话视图。

#### Scenario: 查看单个 Agent 的执行详情
- **GIVEN** 一个有 4 个 Agent 正在执行的 Run
- **WHEN** 用户点击"工程师"标签
- **THEN** 主区域展示工程师的独立 child session 对话
- **AND** 对话中包含：任务 prompt、Agent 输出、产物文件卡片
- **AND** 其他 Agent 的标签保留在左侧，状态实时更新

#### Scenario: 团长视角（默认视图）
- **GIVEN** WorkspaceChatPage 加载
- **WHEN** 未选中任何 Agent 标签
- **THEN** 默认展示"团长视角"——Orchestrator 的汇总视图
- **AND** 显示任务分配记录、各 Agent 状态概览、交付报告

### Requirement: 结构化交付报告
Run 完成后，系统 SHALL 生成结构化交付报告（替代纯文本汇总），包含：交付状态（✅/⚠️/❌）、QA 审查结果、文件清单（含路径和大小）、功能完成清单。

#### Scenario: 软件开发任务完成
- **GIVEN** 一个包含"工程师"和"QA"的 Run 执行完毕
- **WHEN** Synthesizer 完成汇总
- **THEN** 前端渲染交付报告组件
- **AND** 显示：交付状态 ✅ | QA 审查 PASS | 文件列表（index.html, style.css） | 功能完成清单（10/10）

### Requirement: 预设专家团模板
系统 SHALL 提供 5 个预设专家团模板，用户创建 workspace 时可一键选择，自动创建对应角色和配置的 Agent。

#### Scenario: 选择软件开发团模板
- **GIVEN** 用户在创建 workspace 界面
- **WHEN** 用户选择"软件开发团"模板
- **THEN** 自动创建 4 个 Agent：产品经理（read-only）、架构师（read-only）、工程师（workspace-write）、QA（read-only）
- **AND** 自动配置 Agent 间的 review 关系（工程师 → QA）
- **AND** workspace 的 goal 自动填充为模板默认描述

### Requirement: 团长动态交接
Orchestrator Agent（团长）SHALL 支持在 Run 执行过程中动态检测任务完成状态，并自动创建后续任务。不需要在 Plan 阶段预先定义所有步骤。

#### Scenario: 工程师完成后自动触发 QA
- **GIVEN** Run 只有一个"写代码"任务
- **WHEN** 工程师 Agent 完成任务并输出代码文件
- **THEN** 团长检测到代码文件产出，自动创建"QA 审查"任务
- **AND** QA 任务自动分配并开始执行
- **AND** 前端 TaskBoard 和 Agent 标签页实时更新

### Requirement: 产物导出
用户 SHALL 可以一键导出 Agent 团队产出的所有文件，支持下载 ZIP 包或复制到指定目录。

#### Scenario: 导出为 ZIP
- **GIVEN** Run 完成后产生了 3 个文件
- **WHEN** 用户点击"导出产物"按钮
- **THEN** 系统将产物目录打包为 ZIP 并触发浏览器下载

---

## MODIFIED Requirements

### Requirement: 统一消息路由（修改自 architecture-overhaul）
原架构中的 `handleSimpleReply()` 路径 SHALL 被修改为：SIMPLE 复杂度任务不再走 `handleSimpleReply()`，而是直接进入 OrchestratorEngine.dispatch()。只有非任务型闲聊才走 `handleSimpleReply()`。

#### Scenario: 简单任务不再走 Orchestrator 单聊回复
- **GIVEN** 用户发送"做一个贪吃蛇游戏"
- **WHEN** intentRouter 判定为 SIMPLE 复杂度任务
- **THEN** 走 `dispatchSimpleTask()` 而非 `handleSimpleReply()`
- **AND** Agent 能在临时工作目录中产出文件