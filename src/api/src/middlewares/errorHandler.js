import { ZodError } from 'zod';

const isDevelopment = () => (process.env.NODE_ENV || 'development') === 'development';

/**
 * Middleware bắt lỗi toàn cục.
 * Lỗi phía client (4xx) chỉ ghi một dòng log; lỗi phía server (5xx) ghi đầy đủ stack.
 */
export function errorHandler(err, req, res, next) {
  const where = `${req.method} ${req.originalUrl}`;

  // Xử lý lỗi validation từ Zod
  if (err instanceof ZodError) {
    console.warn(`[API 400] ${where}: validation failed`);
    return res.status(400).json({
      success: false,
      message: 'Dữ liệu yêu cầu không hợp lệ (Validation Error)',
      errors: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  // Cập nhật có điều kiện thất bại (ví dụ 2 request /complete đồng thời)
  if (err.name === 'ConditionalCheckFailedException') {
    console.warn(`[API 409] ${where}: conditional check failed`);
    return res.status(409).json({
      success: false,
      message: 'Trạng thái video đã thay đổi bởi một request khác (Conflict)',
    });
  }

  // Xử lý lỗi AWS SDK
  if (err.name?.startsWith('ResourceNotFound') || err.name === 'NoSuchBucket') {
    console.error(`[API 502] ${where}:`, err);
    return res.status(502).json({
      success: false,
      message: 'AWS Resource Not Found. Vui lòng kiểm tra LocalStack hoặc AWS Backend.',
      ...(isDevelopment() ? { error: err.message } : {}),
    });
  }

  const statusCode = err.status || err.statusCode || 500;

  if (statusCode < 500) {
    console.warn(`[API ${statusCode}] ${where}: ${err.message}`);
    return res.status(statusCode).json({ success: false, message: err.message });
  }

  console.error(`[API ${statusCode}] ${where}:`, err);
  res.status(statusCode).json({
    success: false,
    // Ở production không trả thông điệp lỗi nội bộ cho client
    message: isDevelopment() ? err.message || 'Internal Server Error' : 'Internal Server Error',
    ...(isDevelopment() ? { stack: err.stack } : {}),
  });
}
