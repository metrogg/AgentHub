# agent.md

Scope: `apps`

Role: Monorepo application packages: web, server, desktop, and Android.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep changes inside this directory aligned with the owning layer and do not reintroduce legacy multi-agent shortcuts or duplicated session trees.
- Prefer existing local patterns and narrow, testable changes over broad rewrites.

Verification: Run the narrowest relevant typecheck or test for the files changed here.
