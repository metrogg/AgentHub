# Tasks

## Phase 1: P0 — Agent 能默认产出真实文件

- [x] Task 1: 解耦 projectPath，创建默认工作目录
  - [x] 1.1 在 `agent-execution-envelope.ts` 新增 `resolveDefaultWorkDir(runId)` 函数，路径为 `{projectRoot}/storage/.agenthub/workspaces/{runId}/`
  - [x] 1.2 修改 `buildExecutionCwd()`：当 `projectPath` 为 null 且 `sandboxPolicy !== 'read-only'` 时，使用默认工作目录而非报错
  - [x] 1.3 修改 `orchestrator-engine.ts` 的 `executeTask()`：当 `projectPath` 为 null 时不跳过执行，而是传入默认工作目录
  - [x] 1.4 修改 `branch-manager.ts`：当 `projectPath` 为 null 时跳过 Git 分支逻辑，但不阻断流程
  - [x] 1.5 验证：无 projectPath 的群聊中，Agent 能在默认目录产出 .html/.js/.css 文件

- [x] Task 2: 简单任务跳过 Plan 直接执行
  - [x] 2.1 在 `intent-router.ts` 新增 `ComplexityLevel` 枚举：`SIMPLE` / `MODERATE` / `COMPLEX`
  - [x] 2.2 新增 `assessComplexity()` 方法：单文件/单功能 → SIMPLE；多文件但模式固定 → MODERATE；多阶段/架构决策 → COMPLEX
  - [x] 2.3 修改 `messages.ts` 路由逻辑：SIMPLE 任务调用新函数 `dispatchSimpleTask()` 直接执行；MODERATE 用模板 Plan；COMPLEX 走现有异步 Plan 流程
  - [x] 2.4 新增 `dispatchSimpleTask()`：直接用 `buildSimpleFallbackPlan` 生成计划 → 立即 dispatch，跳过 Plan 展示和用户确认
  - [x] 2.5 验证：发送"写一个贪吃蛇 HTML 游戏"，系统直接开始执行而非展示 Plan Card

- [x] Task 3: Agent 产物落地为文件 + 前端文件卡片
  - [x] 3.1 修改 `orchestrator-engine.ts` 的 `executeTask()`：Agent 完成后扫描工作目录，收集产出文件列表写入 `artifacts` 字段
  - [x] 3.2 新增前端组件 `FileCard.tsx`：文件图标（按扩展名）、文件名、文件大小、"预览"按钮（HTML/MD/SVG）、"下载"按钮
  - [x] 3.3 修改 `Thread.tsx`：注册 `file_card` 消息部件，渲染 `FileCard`
  - [x] 3.4 新增 API `GET /api/artifacts/:runId/:filename`：读取工作目录文件返回给前端（预览/下载用）
  - [x] 3.5 验证：Agent 产出 index.html 后，聊天流中出现文件卡片，可点击预览和下载

## Phase 2: P1 — WorkBuddy 风格交互体验

- [x] Task 4: 左侧 Agent 标签页
  - [x] 4.1 新建 `AgentTabs.tsx` 组件：左侧垂直标签列表，显示 Agent 名 + 角色图标 + 状态指示（运行中脉冲动画/已完成绿勾/失败红叉）
  - [x] 4.2 修改 `WorkSpaceChatPage.tsx` 布局：左侧 AgentTabs（w-48） + 中间聊天流（flex-1） + 右侧预览面板（可选）
  - [x] 4.3 在 `chatStore` 新增 `selectedAgentTab` 状态和 `agentTabs` 列表
  - [x] 4.4 修改 `Thread.tsx`：当选中某 Agent 标签时，加载该 Agent 的 child session 消息而非群聊消息
  - [x] 4.5 默认视图"团长视角"：展示 Orchestrator 的汇总消息 + 各 Agent 状态概览
  - [x] 4.6 验证：Run 执行中，左侧显示所有 Agent 标签，点击切换查看独立对话

- [x] Task 5: 结构化交付报告组件
  - [x] 5.1 新建 `DeliveryReport.tsx` 组件：顶部状态横幅（✅/⚠️/❌）、QA 审查摘要行、文件清单表格（文件名+大小）、功能完成清单（checkbox 列表）
  - [x] 5.2 修改 `orchestrator-engine.ts` 的 `synthesizeAndReport()`：输出结构化 JSON 而非纯文本（status / qaResult / files / checklist）
  - [x] 5.3 修改 `Thread.tsx`：注册 `delivery_report` 消息部件，渲染 `DeliveryReport`
  - [x] 5.4 验证：Run 完成后，聊天流中出现结构化交付报告而非纯文本摘要

- [x] Task 6: HTML/Markdown 产物内嵌预览
  - [x] 6.1 在 `WorkspaceChatPage.tsx` 右侧新增可收起的预览面板，iframe 渲染 HTML 产物
  - [x] 6.2 `FileCard` 的"预览"按钮触发打开右侧预览面板
  - [x] 6.3 Markdown 产物使用 `react-markdown` 渲染（项目已有依赖的话）
  - [x] 6.4 验证：点击文件卡片的"预览"，右侧面板渲染可交互的 HTML 页面

## Phase 3: P2 — 开箱即用的预设团队

- [x] Task 7: 5 个预设专家团模板
  - [x] 7.1 在 `agent-role-presets.ts` 新增 `TEAM_TEMPLATES`：定义 5 个预设团（软件开发/内容创作/数据分析/网站搭建/调研报告），每个包含 agent 列表 + review 关系 + 默认 goal
  - [x] 7.2 新增 API `POST /api/workspaces/create-from-template`：选择模板 → 创建 workspace + 自动创建所有 Agent + 配置关系
  - [x] 7.3 前端 workspace 创建界面新增"选择模板"步骤：5 个模板卡片（图标 + 名称 + 包含的 Agent 列表 + 适用场景描述）
  - [x] 7.4 验证：选择"软件开发团"模板，自动创建产品经理+架构师+工程师+QA 四个 Agent

- [x] Task 8: 团长动态交接能力
  - [x] 8.1 在 `orchestrator-engine.ts` 新增 `detectAndCreateFollowUpTasks()`：每完成一个任务后，团长检测产出物类型，决策是否创建后续任务
  - [x] 8.2 新增规则引擎：代码文件产出 → 创建 QA 审查任务；Markdown 产出 → 创建润色任务；代码 + 测试文件 → 创建 Reviewer 任务
  - [x] 8.3 动态创建的任务追加到 TaskGraph，调度器继续执行
  - [x] 8.4 前端 TaskBoard 和 Agent 标签页实时更新新增的任务
  - [x] 8.5 验证：工程师完成后，系统自动创建 QA 任务并开始执行

- [x] Task 9: 产物导出（ZIP 下载）
  - [x] 9.1 新增 API `GET /api/artifacts/:runId/download`：扫描工作目录，压缩为 ZIP，返回文件流
  - [x] 9.2 在 `DeliveryReport` 组件底部新增"导出产物 (ZIP)"按钮
  - [x] 9.3 验证：点击导出按钮，浏览器触发 ZIP 文件下载

## Task Dependencies

```
Phase 1: Task 1 (projectPath解耦) ──┐
                                    ├──→ Task 3 (文件卡片) 依赖 Task 1
Phase 1: Task 2 (跳过Plan) ─────────┘
                                    ↓
Phase 2: Task 4 (Agent标签页) ── 可并行
Phase 2: Task 5 (交付报告)   ── 可并行
Phase 2: Task 6 (内嵌预览)   ── 依赖 Task 3
                                    ↓
Phase 3: Task 7 (预设模板)   ── 可并行
Phase 3: Task 8 (动态交接)   ── 可并行
Phase 3: Task 9 (产物导出)   ── 依赖 Task 3
```

- Task 1 和 Task 2 可并行
- Task 3 依赖 Task 1
- Task 4、5 可并行（不互相依赖）
- Task 6 依赖 Task 3
- Task 7、8、9 可在 Phase 1+2 完成后并行