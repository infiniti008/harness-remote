# Template only: the Docker daemon is unavailable in the local test container.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
FROM ${NODE_IMAGE}
ARG RELEASE_VERSION=3.5.0-local.8
RUN apt-get update && apt-get install -y --no-install-recommends tini git ca-certificates bubblewrap util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/release
COPY release/${RELEASE_VERSION}/ ./
RUN sha256sum --check SHA256SUMS \
    && mkdir -p /app /data /projects \
    && tar -xzf "harness-local-${RELEASE_VERSION}.tgz" --strip-components=1 -C /app \
    && chown node:node /data /projects \
    && rm -rf /tmp/release
COPY distribution/codex-runtime/package*.json /opt/codex/
RUN npm ci --prefix /opt/codex --omit=dev --ignore-scripts \
    && npm cache clean --force
ENV HOME=/data CODEX_HOME=/data/codex CODEX_PATH=/opt/codex/node_modules/.bin/codex
WORKDIR /app
USER node
EXPOSE 4902
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "node", "--v8-pool-size=1", "--max-old-space-size=256", "/app/distribution/run.mjs"]
CMD ["--host", "0.0.0.0", "--port", "4902", "--state-dir", "/data/gateway-state"]
