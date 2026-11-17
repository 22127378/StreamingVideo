# StreamForge API image
# Build: docker build -f docker/api.Dockerfile -t streamforge-api src/api

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
# Lúc chạy không cần npm/corepack; bỏ đi để giảm bề mặt tấn công (Trivy báo lỗ hổng trong npm bundled)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Chứng chỉ CA của RDS (Aurora): kết nối TLS kiểm tra chứng chỉ server.
# Tạo thư mục trước: ADD --chmod cũng áp quyền cho thư mục nó tự tạo, 644 làm user node không vào được.
RUN mkdir -p /app/certs
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem

USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "src/server.js"]
