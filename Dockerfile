FROM node:22-slim

# better-sqlite3 使用预编译二进制，无需编译工具链；若目标平台无预编译包，
# 可改为安装 python3 make g++
WORKDIR /app

ENV NODE_ENV=production
ENV DB_PATH=/data/interlocking.db

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
