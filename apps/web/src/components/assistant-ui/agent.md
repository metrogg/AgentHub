# agent.md

Scope: `apps\web\src\components\assistant-ui`

Role: Assistant UI chat thread, composer, preview, attachments, selection, and message rendering.

Guidelines:
- Read the repository root `AGENTS.md` before editing here.
- Keep changes inside this directory aligned with the owning layer and do not reintroduce legacy multi-agent shortcuts or duplicated session trees.
- Prefer existing local patterns and narrow, testable changes over broad rewrites.

Verification: Run `bun --filter @agenthub/web typecheck` and targeted Bun tests for touched utilities/components.
