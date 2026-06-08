# Security Policy

AgentHub is an alpha-stage local-first AI workbench. It coordinates local services, Matrix rooms, model providers, coding-agent CLIs, workspaces, and generated artifacts. Please treat it as developer tooling that can execute code and access local files when configured to do so.

## Supported Versions

Security fixes are currently applied to the default branch only.

| Version | Supported |
| --- | --- |
| `main` / active development | Yes |
| Released packages | Not yet |
| Historical commits | No |

## Reporting a Vulnerability

Please do not open a public issue for an unpatched vulnerability.

Report security issues privately to the project maintainers. If no private security advisory channel is available for this repository, contact the maintainer through the repository owner profile and include:

- a concise summary,
- affected commit or version,
- reproduction steps,
- impact and prerequisites,
- any logs or proof-of-concept code with secrets removed.

We aim to acknowledge valid reports within 7 days. Because AgentHub is still alpha software, remediation timelines may vary by severity and project capacity.

## Security Model

AgentHub can run with powerful local capabilities:

- local workspace read/write access,
- shell access through coding-agent runtimes,
- local CLI configuration and caches,
- Matrix access tokens,
- model provider API keys,
- generated artifacts and logs,
- optional Docker containers and S3-compatible object storage.

The default local sandbox provider, `local-workdir`, isolates work directories, temp directories, cache directories, and per-agent environment variables. It is not an operating-system security boundary. It does not fully prevent a child process from reading other local paths or using the network.

Use Docker-backed sandboxes or a dedicated machine when running untrusted prompts, untrusted repositories, or untrusted generated code.

## Secrets and Credentials

Never commit:

- `.env` files,
- model provider API keys,
- Matrix access tokens,
- local CLI auth files,
- generated workspaces,
- runtime logs with prompts or credentials,
- MinIO/S3 credentials,
- database files containing local user data.

Use `.env.example` as the public configuration template.

## Responsible Use

Before enabling code execution:

1. Review the selected worker runtime.
2. Review the sandbox policy.
3. Use a disposable workspace for untrusted tasks.
4. Keep provider keys scoped and revocable.
5. Inspect generated artifacts before publishing or deploying them.

## Out of Scope

The following are generally out of scope unless they expose a concrete vulnerability in AgentHub itself:

- issues in third-party model providers,
- issues in external CLIs such as Codex CLI, Claude Code, OpenCode, Gemini CLI, or OpenClaw,
- vulnerabilities requiring local administrator access without additional AgentHub impact,
- denial-of-service reports against a local development instance without a realistic exploit path.

## Disclosure

Please give maintainers a reasonable window to investigate and patch before public disclosure. We appreciate concise, reproducible reports and coordinated disclosure.
