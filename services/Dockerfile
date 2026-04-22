# ════════════════════════════════════════════════════════════════
#  Shared Dockerfile for Quantorus365 services.
#
#  Build example:
#    docker build --build-arg SERVICE=market-ingestion -t q365/market-ingestion:dev .
#    docker build --build-arg SERVICE=market-intelligence -t q365/market-intelligence:dev .
#    docker build --build-arg SERVICE=alerting -t q365/alerting:dev .
#
#  Run example:
#    docker run --env-file .env.local -p 4100:4100 q365/market-ingestion:dev
#
#  Design choices:
#    • One Dockerfile for every service — the service name is a
#      build arg. This is only viable because every service has the
#      same entry shape (services/<name>/src/server.ts). If a
#      service needs custom deps (native bindings etc.) it can ship
#      its own Dockerfile later.
#    • Node 20-alpine for small images; tsx at runtime so we don't
#      need a separate build stage during foundation work. Swap to
#      `tsc --outDir dist && node dist/server.js` once each service
#      stabilizes and build-step speed matters.
# ════════════════════════════════════════════════════════════════

FROM node:20-alpine AS runtime

ARG SERVICE
ENV SERVICE=${SERVICE}
ENV NODE_ENV=production

WORKDIR /app

# Copy only what's needed to install prod deps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source. We include the whole `src` because services import
# from `@/providers`, `@/lib`, etc. If you want a slimmer image,
# move those imports into packages/* and copy only services/<name>
# + packages/*.
COPY tsconfig.json ./
COPY src ./src
COPY packages ./packages
COPY services/${SERVICE} ./services/${SERVICE}

# tsx is a runtime dep for the entry loader. Installed as a prod
# dep if your package.json keeps it there; otherwise add it.
RUN npm i --no-save tsx

# Non-root user for the running process.
RUN addgroup -S q365 && adduser -S q365 -G q365
USER q365

# Health check hits /health on the service's configured port. We
# can't know the port at build time, so the orchestrator should set
# HC_PORT when running (defaults to whatever the service chooses).
ENV HC_PORT=4100
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --spider -q "http://localhost:${HC_PORT}/health" || exit 1

EXPOSE 4100 4200 4300

CMD ["sh", "-c", "npx tsx services/${SERVICE}/src/server.ts"]
