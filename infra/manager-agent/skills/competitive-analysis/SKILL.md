---
name: competitive-analysis
description: Use when the user asks for a competitive comparison, market analysis, or "compare X vs Y vs Z" — decomposes into one research analyst per product and a synthesizer.
---

# Competitive Analysis (e.g. "compare Linear vs Jira vs Asana")

This is the **fastest demo scenario** — embarrassingly parallel research + convergent synthesis.

## When to Use

- User asks "compare A vs B", "which is better", "help me choose between"
- Goal is a decision/recommendation, not code
- 2-5 products / vendors / approaches to compare
- Output: a structured report with comparison table + recommendation

## Recipe

1. **Read** the user goal. Identify the products/options to compare (max 5).
2. **Confirm the workspace**. If user picked no project workspace, pick one (auto workspace) before dispatching.
3. **Dispatch N research analysts** (one per product) + **1 synthesizer**:
   - Each analyst gets: the product name + a research checklist
   - Synthesizer gets: dependsOn all analysts + cross-comparison brief
4. **Write the run goal** to the room: e.g. "Compare Linear, Jira, Asana for 10-person eng team. Deliver: comparison report with recommendation."
5. **Use `agenthub apply -f` per task** with `kind: Task` and `spec.dependencies` on the synthesizer task.
6. **Wait for all to complete**, then `agenthub run status --id <run-id>`.
7. **In the manager's final reply**: link the synthesizer's report artifact via `/api/artifacts/file?workspaceId=&path=` so the user can preview it inline.

## Per-Analyst Task Brief Template

```yaml
kind: Task
metadata:
  name: research-linear
spec:
  title: 研究 Linear
  description: |
    调研 Linear（linear.app）的以下维度：
    1. 定价模型和 10 人团队年费估算
    2. 核心功能：issue tracking、cycles、projects、roadmap、Triage AI
    3. 与 GitHub/Slack 的集成深度
    4. 用户口碑（G2、Capterra 评分、Twitter 反馈）
    5. 迁移成本（从 Jira 迁出的实际工作量）
  worker: <linear-analyst-agent-id>
  sharedTaskRelativeRoot: .agenthub/shared/tasks/<task-id>
  deliverableFormat: result.md 必须包含 STATUS/SUMMARY/DELIVERABLES/NOTES
```

## Synthesizer Task Brief Template

```yaml
kind: Task
metadata:
  name: synthesize-report
spec:
  title: 综合对比报告
  description: |
    基于上游 3 位研究员的结果，生成最终的对比报告（markdown）。
    必须包含：
    1. 三列对比表（功能 / 定价 / 集成 / 口碑）
    2. 10 人工程团队的 TCO 估算
    3. 迁移成本评估
    4. 最终推荐 + 理由
  dependsOn:
    - research-linear
    - research-jira
    - research-asana
  worker: <synthesizer-agent-id>
```

## Acceptance Criteria

- Each analyst's `result.md` has concrete numbers, not vague claims
- Synthesizer produces one final `index.md` that's the user-facing report
- The chat timeline shows the synthesizer's `artifact.created` event with a clickable preview link

## Common Mistakes

- Do NOT make the synthesizer wait for all analysts sequentially — use `dependsOn` so it runs once the others complete
- Do NOT let analysts write to each other's task directories — they are independent
- Do NOT skip the comparison table — users expect a side-by-side
- The final reply in chat must include the artifact preview link, not just say "done"
