import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config/aws.js';
import { getVideoById } from '../services/dynamoService.js';

const IssueTokenSchema = z.object({
  userId: z.string().min(1).default('user-guest-123'),
  tier: z.enum(['free', 'premium']).default('free'),
  videoId: z.string().optional(),
});

/**
 * [POST /api/auth/playback-token]
 * Cấp token phân quyền xem video (Tier-gated: Free vs Premium)
 * Ở môi trường Cloud, cơ chế này sẽ chuyển thành CloudFront Signed Cookies
 */
export async function issuePlaybackToken(req, res, next) {
  try {
    const { userId, tier, videoId } = IssueTokenSchema.parse(req.body);

    // Nếu chỉ định videoId, kiểm tra quyền hạn video đó
    if (videoId) {
      const video = await getVideoById(videoId);
      if (video && video.tier === 'premium' && tier !== 'premium') {
        return res.status(403).json({
          success: false,
          message: 'Video này yêu cầu tài khoản Premium để phát nội dung!',
          requiredTier: 'premium',
          userTier: tier,
        });
      }
    }

    const payload = {
      sub: userId,
      tier,
      videoId: videoId || '*',
      iss: 'StreamForge-Auth',
    };

    // Token có thời hạn 4 giờ
    const token = jwt.sign(payload, config.jwtSecret, { expiresIn: '4h' });

    res.status(200).json({
      success: true,
      message: 'Playback token issued successfully',
      data: {
        token,
        tokenType: 'Bearer',
        tier,
        expiresIn: '4h',
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * [POST /api/auth/verify-playback]
 * Kiểm tra xem token có hợp lệ để xem video chỉ định không
 */
export async function verifyPlaybackAccess(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const { videoId } = req.body;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Missing or invalid Authorization header',
      });
    }

    const token = authHeader.split(' ')[1];
    let decoded;

    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: 'Token đã hết hạn hoặc không hợp lệ',
        error: err.message,
      });
    }

    // Nếu video là premium, kiểm tra quyền của token
    if (videoId) {
      const video = await getVideoById(videoId);
      if (video && video.tier === 'premium' && decoded.tier !== 'premium') {
        return res.status(403).json({
          success: false,
          message: 'Access Denied: Nội dung chỉ dành cho thành viên VIP/Premium',
          requiredTier: 'premium',
          userTier: decoded.tier,
        });
      }
    }

    res.status(200).json({
      success: true,
      message: 'Access Granted: Bạn có quyền phát video này',
      data: {
        user: decoded,
      },
    });
  } catch (error) {
    next(error);
  }
}
