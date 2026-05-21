FROM oven/bun:1.3.14

ARG CODEX_CLI_VERSION=0.133.0
ARG CLAUDE_CODE_VERSION=2.1.146
ARG OPENCODE_VERSION=1.15.7

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git nodejs npm openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN bun install -g \
    "@openai/codex@${CODEX_CLI_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "opencode-ai@${OPENCODE_VERSION}" \
    && codex --version \
    && claude --version \
    && opencode --version

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production \
    PORT=8000 \
    DATABASE_URL=/app/storage/agenthub.db \
    AGENTHUB_CONTAINER=true \
    AGENTHUB_WORKSPACE_ROOT=/workspace \
    MASTRA_REFERENCE_ROOT=/workspace \
    ENABLE_LOCAL_CLI_PROBES=true \
    ENABLE_CODEX_CHATGPT_AUTH=true \
    ENABLE_DOCKER_MANAGEMENT=false

EXPOSE 8000

CMD ["sh", "-lc", "bun --filter @agenthub/db migrate && bun --filter @agenthub/server start"]
