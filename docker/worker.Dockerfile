# StreamForge transcode worker image. Context là src/ để copy được package dùng chung src/shared.
# Build: docker build -f docker/worker.Dockerfile -t streamforge-worker src

FROM node:22-bookworm-slim AS deps
WORKDIR /build
COPY shared ./shared
COPY transcode-worker/package.json transcode-worker/package-lock.json transcode-worker/.npmrc ./transcode-worker/
# Bỏ @ffmpeg-installer/* (optional): image dùng ffmpeg của Debian, mới hơn và nhận bản vá bảo mật
RUN cd transcode-worker && npm ci --omit=dev --omit=optional && npm cache clean --force

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
COPY --from=deps /build/transcode-worker/node_modules ./node_modules
COPY transcode-worker/package.json ./
COPY transcode-worker/src ./src
# Thư mục tạm cho file tải về và output HLS (src/services/sqsConsumer.js: TEMP_ROOT)
RUN mkdir -p /app/temp && chown node:node /app/temp

USER node
# Worker tự xử lý SIGTERM: ngừng poll, chờ job tối đa SHUTDOWN_GRACE_SECONDS (25s) rồi trả message về queue.
# Thời gian chờ khi dừng container phải lớn hơn mức này (compose: stop_grace_period, k8s: terminationGracePeriodSeconds).
CMD ["node", "src/worker.js"]
