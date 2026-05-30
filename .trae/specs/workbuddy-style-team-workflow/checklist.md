# Checklist

## P0: Agent 能默认产出真实文件

- [x] Task 1 验证：无 projectPath 的群聊中发送代码任务，Agent 能在 `storage/.agenthub/workspaces/{runId}/` 目录下产出文件
- [x] Task 1 验证：有 projectPath 的场景行为不变（Git worktree 隔离依然生效）
- [x] Task 1 验证：多次 Run 的工作目录互不冲突（不同 runId 不同目录）
- [x] Task 2 验证：发送"写一个贪吃蛇 HTML 游戏"→ 系统直接开始执行，不展示 Plan Card
- [x] Task 2 验证：发送"开发电商网站含用户系统+商品管理+订单"→ 仍走异步 Plan 流程
- [x] Task 3 验证：Agent 产出 index.html 后，聊天流中出现文件卡片（文件名 + 预览按钮 + 下载按钮）
- [x] Task 3 验证：点击预览按钮，HTML 文件能在右侧 iframe 正常渲染

## P1: WorkBuddy 风格交互体验

- [x] Task 4 验证：Run 执行中，左侧 Agent 标签页列出所有 Agent，状态指示正确
- [x] Task 4 验证：点击某 Agent 标签，主区域切换到该 Agent 的独立 child session 对话
- [x] Task 4 验证：默认展示"团长视角"——Orchestrator 汇总视图
- [x] Task 4 验证：Agent 状态变化时标签页实时更新（运行中→已完成）
- [x] Task 5 验证：Run 完成后出现结构化交付报告（状态横幅 + QA 审查 + 文件清单 + 功能完成清单）
- [x] Task 5 验证：交付报告内容与 Agent 实际产出一致
- [x] Task 6 验证：点击 HTML 文件卡片的"预览"，右侧面板 iframe 渲染正确

## P2: 开箱即用的预设团队

- [x] Task 7 验证：选择"软件开发团"模板后自动创建 4 个 Agent（产品经理/架构师/工程师/QA）
- [x] Task 7 验证：5 个模板全部可选且创建的 Agent 配置正确
- [x] Task 8 验证：工程师完成后系统自动创建 QA 任务
- [x] Task 8 验证：动态创建的任务出现在 TaskBoard 和 Agent 标签页
- [x] Task 8 验证：QA 任务完成后交付报告能体现 QA 审查结果
- [x] Task 9 验证：点击"导出产物 (ZIP)"按钮，浏览器触发 ZIP 下载
- [x] Task 9 验证：ZIP 包中包含所有 Agent 产出的文件

## 回归验证

- [x] 现有有 projectPath 的 workspace 行为不变
- [x] 现有 Plan 审批流程（复杂任务）行为不变
- [x] TypeScript 类型检查通过 (`bun run typecheck`)
- [x] Lint 通过 (`bun run lint`)