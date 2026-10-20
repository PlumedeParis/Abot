# Production image for a permanent host (VPS, Docker host, Fly.io, Railway, ...).
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY config.example.json ./

# SQLite database location when DATABASE_URL is not set. Mount a volume here.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
USER node

# config.json is mounted at runtime (or provided through KITBOT_CONFIG_JSON).
CMD ["node", "src/index.js"]
