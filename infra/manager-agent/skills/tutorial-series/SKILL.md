---
name: tutorial-series
description: Use when the user asks for a multi-part tutorial, blog series, or "write a guide on X" — dispatches one writer per part with a code-runner + reviewer fan-in.
---

# Tutorial Series (e.g. "write a 5-part RAG tutorial")

This is the **most parallel** demo scenario — N writers work independently, code runner verifies, reviewer signs off.

## When to Use

- User asks "write a tutorial on X", "create a blog series about Y", "make a course on Z"
- 3-7 independent parts that share an audience/style
- Each part can be written independently
- Code samples must actually run

## Recipe

1. **Read** the user goal. Identify:
   - Topic + audience level (beginner / intermediate / advanced)
   - Number of parts (default 3 if not specified)
   - Whether code samples are needed
2. **Editor task (1)** — sets outline + style guide:
   - Part titles + 1-paragraph description each
   - Code style conventions (TypeScript vs JS, Python 3.x, etc.)
   - Cross-reference conventions
3. **Writer tasks (N, parallel)** — each writes one part:
   - Depends on editor (for the outline)
   - Writes `{sharedTaskRelativeRoot}/artifacts/part-{N}.md`
4. **Code runner (1)** — depends on all writers:
   - Executes every code snippet in every part
   - Verifies outputs match the prose
   - Writes `{sharedTaskRelativeRoot}/artifacts/verification-report.md`
5. **Reviewer (1)** — depends on all writers + code runner:
   - Checks consistency: terminology, formatting, no broken cross-refs
   - Writes final consolidated `index.md` linking all parts

## Brief Templates

### Editor
```yaml
kind: Task
spec:
  title: 设定教程大纲与风格指南
  description: |
    为"RAG 应用开发"5 篇教程设定大纲：
    - Part 1: 入门 — 什么是 RAG、为什么需要
    - Part 2: 基础实现 — 用 LangChain + Chroma
    - Part 3: 进阶 — 多文档、混合检索
    - Part 4: 生产化 — 性能、成本、监控
    - Part 5: 高级 — Agentic RAG、Multi-step

    输出：
    - outline.md（5 个 part 的标题、目标读者、关键内容点）
    - style-guide.md（代码风格、术语表）
  worker: <editor-agent-id>
```

### Writer
```yaml
kind: Task
spec:
  title: Part 2: 基础 RAG 实现
  description: |
    写 Part 2 markdown，遵循 editor 的 outline 和 style-guide。
    必须包含可运行代码（Python 3.10+）。
    写到 {sharedTaskRelativeRoot}/artifacts/part-2.md
  dependsOn: [<editor-task-id>]
  worker: <writer-2-agent-id>
```

### Code Runner
```yaml
kind: Task
spec:
  title: 验证教程代码可运行
  description: |
    顺序执行所有 part 的代码片段，验证输出。
    写 verification-report.md，包含每个代码片段的运行结果。
  dependsOn:
    - <writer-1-task-id>
    - <writer-2-task-id>
    - <writer-3-task-id>
    - <writer-4-task-id>
    - <writer-5-task-id>
  worker: <code-runner-agent-id>
```

### Reviewer
```yaml
kind: Task
spec:
  title: 一致性 review
  description: |
    检查所有 part 的术语、格式、交叉引用，生成最终 index.md。
  dependsOn:
    - <writer-1..5-task-ids>
    - <code-runner-task-id>
  worker: <reviewer-agent-id>
```

## Acceptance Criteria

- N writer tasks each produce a `part-N.md`
- Code runner produces `verification-report.md` with PASS entries
- Reviewer produces final `index.md` linking all parts
- User can click one preview link to see the full series

## Common Mistakes

- Do NOT let writers write to each other's task directories — each is isolated
- Code runner MUST depend on ALL writers (use `dependsOn` array)
- Reviewer's `index.md` is the user-facing deliverable — link it in the final chat reply
- If the user wants a static site, add a separate `static-site-builder` task after the reviewer
