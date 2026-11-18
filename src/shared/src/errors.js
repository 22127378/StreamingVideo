import { ZodError } from 'zod';

const isDevelopment = () => (process.env.NODE_ENV || 'development') === 'development';

/** Lỗi có mã HTTP, trả thẳng message cho client khi < 500 */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

/** Cập nhật có điều kiện không thành (ví dụ 2 request cùng lúc) -> 409 */
export class ConflictError extends Error {
  constructor(message = 'Trạng thái đã thay đổi bởi một request khác') {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

/**
 * Middleware bắt lỗi cuối cùng của Express (phải nhận đủ 4 tham số thì Express mới coi là error handler).
 * Lỗi phía client (4xx) chỉ ghi một dòng log; lỗi phía server (5xx) ghi đầy đủ stack.
 */
export function errorHandler(err, req, res, next) {
  const where = `${req.method} ${req.originalUrl}`;

  if (err instanceof ZodError) {
    console.warn(`[HTTP 400] ${where}: validation failed`);
    return res.status(400).json({
      success: false,
      message: 'Dữ liệu yêu cầu không hợp lệ (Validation Error)',
      errors: err.issues.map((e) => ({ field: e.path.join('.'), message: e.message })),
    });
  }

  // Body JSON hỏng (express.json)
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Body không phải JSON hợp lệ' });
  }

  const statusCode = err.status || err.statusCode || 500;
  if (statusCode < 500) {
    console.warn(`[HTTP ${statusCode}] ${where}: ${err.message}`);
    return res.status(statusCode).json({ success: false, message: err.message, ...(err.extra || {}) });
  }

  console.error(`[HTTP ${statusCode}] ${where}:`, err);
  res.status(statusCode).json({
    success: false,
    // Ở production không trả thông điệp lỗi nội bộ cho client
    message: isDevelopment() ? err.message || 'Internal Server Error' : 'Internal Server Error',
  });
}
