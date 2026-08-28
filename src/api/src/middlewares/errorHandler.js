import { ZodError } from 'zod';

/**
 * Middleware bắt lỗi toàn cục
 */
export function errorHandler(err, req, res, next) {
  console.error(`❌ [API Error] ${req.method} ${req.originalUrl}:`, err);

  // Xử lý lỗi validation từ Zod
  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      message: 'Dữ liệu yêu cầu không hợp lệ (Validation Error)',
      errors: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  // Xử lý lỗi AWS SDK
  if (err.name?.startsWith('ResourceNotFound') || err.name === 'NoSuchBucket') {
    return res.status(502).json({
      success: false,
      message: 'AWS Resource Not Found. Vui lòng kiểm tra LocalStack hoặc AWS Backend.',
      error: err.message,
    });
  }

  const statusCode = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
  });
}
