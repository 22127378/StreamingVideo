# StreamForge transcode worker image
# Build: docker build -f docker/worker.Dockerfile -t streamforge-worker src/transcode-worker

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Bỏ @ffmpeg-installer/* (optional): image dùng ffmpeg của Debian, mới hơn và nhận bản vá bảo mật
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  # Lúc chạy không cần npm/corepack; bỏ đi để giảm bề mặt tấn công (Trivy báo lỗ hổng trong npm bundled)
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Chứng chỉ CA của RDS (Aurora): kết nối TLS kiểm tra chứng chỉ server.
# Tạo thư mục trước: ADD --chmod cũng áp quyền cho thư mục nó tự tạo, 644 làm user node không vào được.
RUN mkdir -p /app/certs
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
# Thư mục tạm cho file tải về và output HLS (src/services/sqsConsumer.js: TEMP_ROOT)
RUN mkdir -p /app/temp && chown node:node /app/temp

USER node
# Worker tự xử lý SIGTERM: ngừng poll, chờ job tối đa SHUTDOWN_GRACE_SECONDS (25s) rồi trả message về queue.
# Thời gian chờ khi dừng container phải lớn hơn mức này (compose: stop_grace_period, k8s: terminationGracePeriodSeconds).
CMD ["node", "src/worker.js"]
