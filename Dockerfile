# syntax=docker/dockerfile:1

# 生产镜像：固定 Node 22.17，依赖在镜像内安装，宿主机不需要 npm。
FROM node:22.17.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.17.0-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    HOST=0.0.0.0 \
    PORT=3000 \
    PMS_DB_PATH=/app/data/pool.db

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# SQLite 需要可写目录；容器内以 node(uid 1000) 运行。
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/public-config').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
