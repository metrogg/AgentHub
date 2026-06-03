# agent.md

Scope: `apps\server\src\services\execution`

Role: Task execution, local A2A transport, sandbox provider, workdirs, and execution envelopes.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep changes inside this directory aligned with the owning layer and do not reintroduce legacy multi-agent shortcuts or duplicated session trees.
- Prefer existing local patterns and narrow, testable changes over broad rewrites.

Verification: Run `bun --filter @agenthub/server typecheck` or the relevant package typecheck plus targeted Bun tests.
