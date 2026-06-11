# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

Treat this as a single-context repo for now. There is no root `CONTEXT.md`, no `CONTEXT-MAP.md`, and no `docs/adr/` directory yet. Proceed silently when those files are absent.

The current authoritative context is carried by the existing project docs and root agent instructions:

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `docs/文档索引与权威口径.md`
- `docs/当前状态与下一步路线.md`
- `docs/AgentHub-HiClaw-lite开源内核重构方案.md`
- `docs/Agent运行时规范化与HiClaw对齐计划.md`
- `docs/AgentHub-vs-HiClaw-vs-ClawTeam-对比分析报告.md`
- `docs/OpenClaw接入指南.md`
- `docs/hiclaw-wiki.agent.final.md` when deep HiClaw alignment is relevant

## Consumer Rules

- Before changing orchestration, runtime, Matrix, task room, artifact, or lifecycle code, read the relevant root instructions and the HiClaw-lite docs above.
- Use the repo's own terms: Room, TimelineEvent, Run, Task, WorkerInstance, Artifact, RuntimeLease, Manager Runtime, Worker Runtime, ArtifactStore, SharedStorage, Controller Plane, and Matrix timeline.
- Do not reintroduce deprecated architecture paths such as DAG-first orchestration, `TaskExecutionService`, `LocalA2ATransport`, fixed team templates, fake timeline events, or `messages` table writes for new Room messages.
- If a future `CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/adr/` appears, treat it as the first stop for domain vocabulary and architectural decisions.
