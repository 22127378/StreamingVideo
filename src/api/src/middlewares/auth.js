import { verifyToken } from '../services/authService.js';

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
}

/** Bắt buộc đăng nhập: gắn req.user, thiếu hoặc sai token thì 401 */
export async function requireAuth(req, res, next) {
  const token = bearer(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Cần đăng nhập' });
  }
  try {
    req.user = await verifyToken(token);
    return next();
  } catch (err) {
    console.warn(`[API 401] ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(401).json({ success: false, message: 'Phiên đăng nhập hết hạn hoặc không hợp lệ' });
  }
}
