# syntax=docker/dockerfile:1
#
# One image for the whole app. The web server (server.js) and the background
# worker (worker.js) are the same code with a different command, so they're
# built once and always run the same version.
#
# Stages:
#   base  - pinned Node runtime
#   deps  - production dependencies only (npm ci --omit=dev)
#   dev   - all dependencies, for `docker compose -f compose.yaml -f compose.dev.yaml up`
#   test  - runs the test suite inside the image (used by CI)
#   prod  - final runtime image: prod deps + source, non-root user
#
# Debian (bookworm-slim) rather than Alpine: MongoDB publishes no binaries for
# Alpine's musl libc, and the test stage starts a real mongod
# (mongodb-memory-server).

ARG NODE_IMAGE=node:22.23.3-bookworm-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app
# Faster, quieter installs; no update-notifier or audit noise during builds.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# ---- production dependencies -------------------------------------------------
FROM base AS deps
# Copy only the manifests first: this layer (the slow npm install) is cached
# and reused until package.json / package-lock.json change, not on every
# source edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- development: all deps, source is bind-mounted by compose.dev.yaml -------
FROM base AS dev
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# --legacy-watch: file-change events don't cross from a Windows host into a
# Linux container through bind mounts, so nodemon has to poll.
CMD ["npx", "nodemon", "--legacy-watch", "server.js"]

# ---- tests --------------------------------------------------------------------
FROM dev AS test
ENV NODE_ENV=test
# mongodb-memory-server downloads a mongod binary on first use; do it at build
# time so `docker run` of this image works offline and the layer is cached.
RUN node -e "require('mongodb-memory-server').MongoMemoryServer.create().then((m) => m.stop())"
CMD ["npm", "test"]

# ---- production runtime -------------------------------------------------------
FROM base AS prod
ENV NODE_ENV=production \
    PORT=8080
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
# The official image ships an unprivileged "node" user. If the app were ever
# compromised, the attacker wouldn't be root inside the container.
USER node
EXPOSE 8080
# Liveness probe without curl/wget (not in slim images): node's built-in fetch.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# Exec form: node is the process that receives SIGTERM from `docker stop`
# (a shell wrapper would swallow it), so server.js can shut down gracefully.
CMD ["node", "server.js"]
