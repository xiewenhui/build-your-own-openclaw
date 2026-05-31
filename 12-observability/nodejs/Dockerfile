# ── Stage 1: Dependencies + TypeScript compile ────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src
COPY config ./config

# ── Stage 2: Production runtime ───────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/src ./src
COPY --from=builder /app/config ./config

# Copy skills directory if present
COPY skills ./skills 2>/dev/null || true

# Persistent data directory (SQLite, workspace, logs)
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME /app/data
ENV XCLAW_DATA_DIR=/app/data

USER node
EXPOSE 3000
EXPOSE 3001

CMD ["node", "--env-file=.env", "src/index.ts"]
