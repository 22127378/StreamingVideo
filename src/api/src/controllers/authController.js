import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config/aws.js';
import { getVideoById } from '../services/dynamoService.js';

const TOKEN_ISSUER = 'StreamForge-Auth';
const TOKEN_TTL = '4h';

// SIMULATION: không có xác thực người dùng, ai cũng xin được token premium.
// Trên AWS, phần này được thay bằng đăng nhập thật và CloudFront signed cookies.
const IssueTokenSchema = z.object({
  userId: z.string().min(1).max(128).default('user-guest-123'),
  tier: z.enum(['free', 'premium']).default('free'),
  videoId: z.string().uuid('VideoId không hợp lệ').optional(),
});

const VerifyPlaybackSchema = z.object({
  videoId: z.string().uuid('VideoId không hợp lệ'),
});

function requiresPremium(video, tier) {
  return video.tier === 'premium' && tier !== 'premium';
}

function videoNotFound(res, videoId) {
  return res.status(404).json({
    success: false,
    message: `Video not found with ID: ${videoId}`,
  });
}

/**
 * [POST /api/auth/playback-token]
 * Cấp token xem video theo gói (free hoặc premium).
 * Có videoId thì token chỉ dùng được cho video đó, không có thì dùng cho mọi video ('*').
 */
export async function issuePlaybackToken(req, res, next) {
  try {
    const { userId, tier, videoId } = IssueTokenSchema.parse(req.body);

    if (videoId) {
      const video = await getVideoById(videoId);
      if (!video) return videoNotFound(res, videoId);
      if (requiresPremium(video, tier)) {
        return res.status(403).json({
          success: false,
          message: 'Video này yêu cầu tài khoản Premium để phát nội dung',
          requiredTier: 'premium',
          userTier: tier,
        });
      }
    }

    const token = jwt.sign({ sub: userId, tier, videoId: videoId || '*' }, config.jwtSecret, {
      algorithm: 'HS256',
      issuer: TOKEN_ISSUER,
      expiresIn: TOKEN_TTL,
    });

    res.status(200).json({
      success: true,
      message: 'Playback token issued successfully',
      data: {
        token,
        tokenType: 'Bearer',
        tier,
        videoId: videoId || '*',
        expiresIn: TOKEN_TTL,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * [POST /api/auth/verify-playback]
 * Kiểm tra token có được xem video chỉ định hay không
 */
export async function verifyPlaybackAccess(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Missing or invalid Authorization header',
      });
    }

    const { videoId } = VerifyPlaybackSchema.parse(req.body);

    let decoded;
    try {
      decoded = jwt.verify(authHeader.slice('Bearer '.length), config.jwtSecret, {
        algorithms: ['HS256'],
        issuer: TOKEN_ISSUER,
      });
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: 'Token đã hết hạn hoặc không hợp lệ',
        error: err.message,
      });
    }

    if (decoded.videoId !== '*' && decoded.videoId !== videoId) {
      return res.status(403).json({
        success: false,
        message: 'Token này không dành cho video được yêu cầu',
      });
    }

    const video = await getVideoById(videoId);
    if (!video) return videoNotFound(res, videoId);

    if (requiresPremium(video, decoded.tier)) {
      return res.status(403).json({
        success: false,
        message: 'Access Denied: Nội dung chỉ dành cho thành viên Premium',
        requiredTier: 'premium',
        userTier: decoded.tier,
      });
    }

    if (video.status !== 'READY') {
      return res.status(409).json({
        success: false,
        message: `Video chưa sẵn sàng để phát (trạng thái ${video.status})`,
        currentStatus: video.status,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Access Granted: Bạn có quyền phát video này',
      data: {
        user: { sub: decoded.sub, tier: decoded.tier, videoId: decoded.videoId, exp: decoded.exp },
      },
    });
  } catch (error) {
    next(error);
  }
}
