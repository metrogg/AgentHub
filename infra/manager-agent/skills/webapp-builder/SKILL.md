---
name: webapp-builder
description: Use when the user asks "build me a web app", "create a website", or wants a working frontend demo — decomposes into PM spec, architect, frontend dev, backend dev (optional), QA.
---

# Web App Builder (e.g. "build a Todo web app")

This is the **highest visual impact** demo scenario — produces a working previewable URL.

## When to Use

- User asks "build me X web app", "create a landing page for Y", "make me a dashboard"
- The output is a runnable web app or static site
- User expects to **click and see** the result
- 1-2 week scope for a single engineer

## Recipe

1. **Read** the user goal. Identify the type:
   - **Static site** (landing page, portfolio, docs) → 1 frontend dev + 1 reviewer
   - **Frontend-only SPA** (Todo, calculator, game) → 1 frontend dev + 1 reviewer
   - **Full-stack** (login, CRUD, DB) → PM + architect + frontend + backend + QA
2. **If full-stack**, dispatch in this order using `dependsOn`:
   - `pm-spec` (writes user stories + acceptance criteria)
   - `architect` (designs schema + API contract) — `dependsOn: [pm-spec]`
   - `frontend-dev` + `backend-dev` — `dependsOn: [architect]` (parallel)
   - `qa-reviewer` — `dependsOn: [frontend-dev, backend-dev]`
3. **Project workspace** must be selected. If user has no project, prompt them to create one (this matters because artifacts write to the workspace).
4. **For static / frontend-only** (recommended for demos), simplify to:
   - `frontend-dev` writes `index.html` + `style.css` + `app.js` to `{projectPath}/`
   - `qa-reviewer` opens the HTML, validates the result, writes a QA report
5. **Final reply in chat** must include the preview URL:
   - Static site: `http://localhost:5173/preview/{workspaceId}/` (AgentHub's built-in static serve)
   - Or the `/api/artifacts/preview-file?workspaceId=&path=index.html` link

## Worker Brief Template (Frontend Dev)

```yaml
kind: Task
spec:
  title: 实现 Todo Web App 前端
  description: |
    在 {projectPath} 下创建以下文件：
    - index.html — 包含 Todo 列表 UI、表单输入、完成/删除按钮
    - style.css — 简洁现代的样式
    - app.js — 用 localStorage 持久化的 todo 逻辑

    要求：
    - 移动端响应式
    - 无需后端，纯前端
    - 完成后必须写 result.md 报告包含：
      - 文件路径列表
      - 如何本地启动 (open index.html in browser)
      - 任何已知限制

    产物直接写到 {projectPath}/ 根目录，Manager 会自动扫描并注册为 artifact。
  worker: <frontend-dev-agent-id>
  sharedTaskRelativeRoot: .agenthub/shared/tasks/<task-id>
```

## QA Reviewer Brief Template

```yaml
kind: Task
spec:
  title: QA 验收
  description: |
    验收 frontend-dev 的工作：
    1. 用浏览器或 curl 打开 index.html 确认 UI 正常
    2. 检查 HTML/CSS/JS 语法
    3. 测试 add/delete/complete 功能
    4. 写 result.md 包含 PASS/FAIL 状态、问题清单、改进建议
  dependsOn: [frontend-dev]
  worker: <qa-reviewer-agent-id>
```

## Acceptance Criteria

- `index.html` actually opens in a browser without errors
- The chat timeline shows an `artifact.created` event for the HTML
- The final Manager message includes a clickable preview link
- All tasks have a `result.md` with STATUS: SUCCESS

## Common Mistakes

- Do NOT skip project workspace selection — without it, artifacts have no path
- Do NOT let frontend dev write to `shared/tasks/...` — write to workspace root
- Do NOT forget the reviewer — without it, broken code gets presented as "done"
- The static preview only works for HTML at the workspace root; SPAs with `npm run dev` need a deploy step (out of scope for now)
