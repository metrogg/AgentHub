FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq tini \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g openclaw

WORKDIR /workspace

ENV HOME=/workspace
ENV OPENCLAW_CONFIG_PATH=/workspace/openclaw.json
ENV OPENCLAW_NO_RESPAWN=1

ENTRYPOINT ["tini", "--"]
CMD ["openclaw", "gateway", "run", "--verbose", "--force"]
