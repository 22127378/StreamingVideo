import express from 'express';
import cors from 'cors';
import videoRoutes from './routes/videoRoutes.js';
import authRoutes from './routes/authRoutes.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { createRateLimiter } from './middlewares/rateLimit.js';
import { config } from './config/aws.js';

export function createApp({ rateLimit = {} } = {}) {
  const app = express();

  // Sau CloudFront + ALB, req.ip phải lấy từ X-Forwarded-For thay vì IP của proxy
  app.set('trust proxy', config.trustProxyHops);

  // Chặn một client tạo upload hàng loạt (mỗi upload tốn dung lượng S3 và phí transcode)
  const limitWrites = createRateLimiter({
    max: rateLimit.max ?? config.rateLimitMax,
    windowSeconds: rateLimit.windowSeconds ?? config.rateLimitWindowSeconds,
  });

  // Middlewares
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
      exposedHeaders: ['Content-Range', 'Accept-Ranges', 'ETag'],
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Request logger (bỏ qua health check của ALB/Kubernetes)
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[${req.method}] ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
    });
    next();
  });

  // Health check
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'UP',
      timestamp: new Date().toISOString(),
      service: 'streamforge-api',
      version: '1.0.0',
    });
  });

  // API Routes
  app.post(['/api/videos/upload-url', '/api/videos/complete', '/api/auth/playback-token'], limitWrites);
  app.use('/api/videos', videoRoutes);
  app.use('/api/auth', authRoutes);

  // 404 Handler
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    });
  });

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
