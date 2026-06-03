# agent.md

Scope: `packages\shared`

Role: Shared TypeScript package consumed by apps and tests.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep changes inside this directory aligned with the owning layer and do not reintroduce legacy multi-agent shortcuts or duplicated session trees.
- Prefer existing local patterns and narrow, testable changes over broad rewrites.

Verification: Run `bun --filter @agenthub/server typecheck` or the relevant package typecheck plus targeted Bun tests.
