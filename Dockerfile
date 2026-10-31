FROM node:24-bookworm-slim AS frontend-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./frontend/
RUN npm run build

FROM node:24-bookworm-slim AS worker
ARG TARGETARCH
ARG CODEXBAR_VERSION=0.80.0
ARG CODEX_VERSION=0.164.0
ARG CLAUDE_VERSION=2.1.310
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl fonts-noto-cjk tini libatomic1 \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in arm64) arch=aarch64;; amd64) arch=x86_64;; *) echo 'Unsupported architecture'; exit 1;; esac; \
    asset="CodexBarCLI-v${CODEXBAR_VERSION}-linux-musl-${arch}.tar.gz"; \
    base="https://github.com/steipete/CodexBar/releases/download/v${CODEXBAR_VERSION}"; \
    mkdir /tmp/codexbar; cd /tmp/codexbar; \
    curl -fsSL --retry 3 "$base/$asset" -o "$asset"; \
    curl -fsSL --retry 3 "$base/$asset.sha256" -o checksum; \
    hash="$(awk '{print $1}' checksum)"; \
    printf '%s  %s\n' "$hash" "$asset" | sha256sum -c -; \
    tar -xzf "$asset"; \
    binary="$(find . -type f -name CodexBarCLI | head -n 1)"; \
    test -n "$binary"; install -m 755 "$binary" /usr/local/bin/codexbar; \
    cd /; rm -rf /tmp/codexbar; codexbar --version
RUN npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm cache clean --force && codex --version && claude --version
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY render-dashboard.mjs usage-model.mjs ./
COPY service/ ./service/
COPY --from=frontend-build /build/frontend/dist ./frontend/dist
RUN mkdir -p /auth/.codex /auth/.claude /auth/.config /data && chown -R node:node /auth /data
ENV NODE_ENV=production HOME=/auth CODEX_HOME=/auth/.codex \
    CLAUDE_CONFIG_DIR=/auth/.claude XDG_CONFIG_HOME=/auth/.config \
    DATA_DIR=/data PORT=8080 DISABLE_AUTOUPDATER=1
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "service/worker.mjs"]

# The master contains no account CLIs and receives no auth volume.
FROM node:24-bookworm-slim AS master
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY render-dashboard.mjs usage-model.mjs ./
COPY service/ ./service/
COPY workers.json ./
COPY --from=frontend-build /build/frontend/dist ./frontend/dist
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "service/server.mjs"]
