// Khung HTTP chung cho các service: CORS, JSON, log request, /health, /metrics, 404, xử lý lỗi.
import express from 'express';
import cors from 'cors';
import { errorHandler } from './errors.js';
import { installConsoleBridge, logger } from './logger.js';
import { createRateLimiter } from './rateLimit.js';

export { createRateLimiter };

/**
 * @param {{ service: string, metrics: ReturnType<import('./metrics.js').createMetrics>,
 *   routes: (app: express.Express) => void, trustProxyHops?: number, faultRate?: number, random?: () => number }} options
 *   routes: gắn route của service vào app (trước 404 và error handler)
 *   faultRate: tỉ lệ request /api/* bị trả 500 giả (0..1), chỉ để thử canary tự rollback. Mặc định 0.
 */
export function createHttpApp({
  service,
  metrics,
  routes,
  trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS || '0', 10),
  faultRate = parseFloat(process.env.FAULT_INJECT_5XX_RATE || '0') || 0,
  random = Math.random,
}) {
  const app = express();

  // Sau CloudFront + ALB, req.ip phải lấy từ X-Forwarded-For thay vì IP của proxy
  app.set('trust proxy', trustProxyHops);
  app.disable('x-powered-by');

  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );
  app.use(express.json({ limit: '100kb' }));

  // Log và metric cho mỗi request (bỏ qua health check và scrape)
  app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/metrics') return next();
    const start = Date.now();
    res.on('finish', () => {
      // route là mẫu đường dẫn (/api/videos/:id); route không khớp gom chung một nhãn
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const durationMs = Date.now() - start;
      metrics.httpRequestDuration.observe({ method: req.method, route, status: res.statusCode }, durationMs / 1000);
      logger.info(`${req.method} ${req.originalUrl} ${res.statusCode}`, {
        event: 'http_request',
        method: req.method,
        route,
        status: res.statusCode,
        durationMs,
        ip: req.ip,
        user: req.user?.sub,
      });
    });
    next();
  });

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'UP', service: `streamforge-${service}`, timestamp: new Date().toISOString() });
  });
  app.get('/metrics', metrics.handler);

  // Fault injection để thử Argo Rollouts: đặt FAULT_INJECT_5XX_RATE cho bản canary, phân tích Prometheus
  // thấy tỉ lệ 5xx tăng và tự rollback. Đặt sau middleware ghi metric để lỗi giả cũng được đếm.
  if (faultRate > 0) {
    console.warn(`FAULT_INJECT_5XX_RATE=${faultRate}: failing that share of /api requests on purpose`);
    app.use('/api', (req, res, next) => {
      if (random() < faultRate) {
        return res.status(500).json({ success: false, message: 'Injected fault (FAULT_INJECT_5XX_RATE)' });
      }
      next();
    });
  }

  routes(app);

  app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
  });
  app.use(errorHandler);
  return app;
}

/**
 * Chạy server và tắt gọn khi nhận SIGTERM (Kubernetes): ngừng nhận kết nối mới, chạy onShutdown
 * (ví dụ dừng consumer sự kiện, đóng pool database), rồi thoát.
 */
export function startServer(app, { service, port = parseInt(process.env.PORT || '4000', 10), onShutdown = async () => {} }) {
  installConsoleBridge();
  const server = app.listen(port, () => {
    console.log(`streamforge-${service} listening on port ${port} (${process.env.NODE_ENV || 'development'})`);
  });

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received: shutting down`);
    server.close(async () => {
      await onShutdown().catch((err) => console.error('shutdown error', err));
      process.exit(0);
    });
    // Kết nối keep-alive có thể giữ server.close mãi; ép thoát sau 20s
    setTimeout(() => process.exit(0), 20_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}
