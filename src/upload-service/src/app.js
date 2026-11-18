// Upload service.
//   POST /api/uploads                 xin URL upload thẳng lên S3 (phát VideoCreated)
//   POST /api/uploads/:id/complete    xác nhận đã upload xong (phát VideoUploaded)
//   GET  /api/uploads/:id             trạng thái phiên upload của mình
// VideoUploaded được EventBridge chuyển vào hàng đợi transcode và tới catalog, nên service này
// không biết có worker hay catalog.
import crypto from 'node:crypto';
import { z } from 'zod';
import { canManage } from '@streamforge/shared/access';
import { requireAuth } from '@streamforge/shared/auth';
import { HttpError } from '@streamforge/shared/errors';
import { EVENT_TYPES, publishEvent } from '@streamforge/shared/events';
import { createHttpApp, createRateLimiter } from '@streamforge/shared/http';
import { createMetrics } from '@streamforge/shared/metrics';
import { config } from './config.js';
import * as repo from './repository.js';
import { headObject, presignUpload, rawKeyFor } from './s3.js';

export const metrics = createMetrics('upload');
const uploadsCreated = new metrics.client.Counter({
  name: 'streamforge_uploads_created_total',
  help: 'Presigned upload URLs issued',
  registers: [metrics.registry],
});
const uploadsCompleted = new metrics.client.Counter({
  name: 'streamforge_uploads_completed_total',
  help: 'Uploads confirmed and sent to transcode',
  registers: [metrics.registry],
});

const CreateUploadSchema = z.object({
  fileName: z.string().min(1, 'Tên file không được để trống').max(255),
  contentType: z.string().regex(/^video\/[\w.+-]+$/, 'ContentType phải là định dạng video (ví dụ video/mp4)'),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(config.maxUploadBytes, `File vượt quá giới hạn ${config.maxUploadBytes} bytes`),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  tier: z.enum(['free', 'premium']).default('free'),
});

const IdSchema = z.object({ id: z.uuid('VideoId không hợp lệ') });

/** Dữ liệu catalog cần để hiển thị video, gửi kèm cả VideoCreated và VideoUploaded */
function videoFacts(u) {
  return {
    videoId: u.videoId,
    ownerId: u.ownerId,
    title: u.title,
    description: u.description,
    tier: u.tier,
    originalFileName: u.originalFileName,
    contentType: u.contentType,
    fileSize: u.fileSize,
    rawBucket: u.rawBucket,
    rawS3Key: u.rawS3Key,
    processedBucket: u.processedBucket,
    createdAt: u.createdAt,
  };
}

export function createApp({ rateLimit = {}, publish = publishEvent, head = headObject } = {}) {
  const limit = createRateLimiter({
    max: rateLimit.max ?? config.rateLimitMax,
    windowSeconds: rateLimit.windowSeconds ?? config.rateLimitWindowSeconds,
  });

  async function loadOwned(req) {
    const { id } = IdSchema.parse(req.params);
    const upload = await repo.getUpload(id);
    if (!upload) throw new HttpError(404, `Không tìm thấy upload ${id}`);
    if (!canManage(req.user, upload)) throw new HttpError(403, 'Chỉ người upload mới thực hiện được thao tác này');
    return upload;
  }

  return createHttpApp({
    service: 'upload',
    metrics,
    routes(app) {
      app.post('/api/uploads', limit, requireAuth, async (req, res, next) => {
        try {
          const input = CreateUploadSchema.parse(req.body);
          const videoId = crypto.randomUUID();
          const key = rawKeyFor(videoId, input.fileName);
          const upload = await repo.createUpload({
            videoId,
            ownerId: req.user.sub,
            title: input.title || input.fileName.replace(/\.[^/.]+$/, ''),
            description: input.description,
            tier: input.tier,
            originalFileName: input.fileName,
            contentType: input.contentType,
            fileSize: input.fileSize,
            rawBucket: config.rawBucket,
            rawS3Key: key,
            processedBucket: config.processedBucket,
          });
          try {
            await publish('upload', EVENT_TYPES.VideoCreated, videoFacts(upload));
          } catch (err) {
            // Catalog không biết video này: bỏ phiên upload để client thử lại từ đầu
            await repo.deleteUpload(videoId).catch(() => {});
            throw err;
          }
          const signed = await presignUpload({
            videoId,
            key,
            fileName: input.fileName,
            contentType: input.contentType,
            fileSize: input.fileSize,
          });
          uploadsCreated.inc();
          res.status(201).json({ success: true, data: { videoId, ...signed, upload } });
        } catch (err) {
          next(err);
        }
      });

      app.get('/api/uploads/:id', requireAuth, async (req, res, next) => {
        try {
          res.json({ success: true, data: await loadOwned(req) });
        } catch (err) {
          next(err);
        }
      });

      app.post('/api/uploads/:id/complete', limit, requireAuth, async (req, res, next) => {
        try {
          const upload = await loadOwned(req);
          if (upload.status !== 'UPLOADING') {
            throw new HttpError(409, 'Upload này đã được xác nhận', { currentStatus: upload.status });
          }
          const file = await head(upload.rawBucket, upload.rawS3Key);
          if (file.error) throw new HttpError(502, 'Không kiểm tra được file trên S3. Vui lòng thử lại sau.');
          if (!file.exists) {
            throw new HttpError(400, 'File video chưa được upload lên S3. Hãy PUT file vào uploadUrl trước.');
          }

          const completed = await repo.transition(upload.videoId, 'UPLOADING', 'COMPLETED', {
            fileSize: file.contentLength,
          });
          try {
            // detail cũng là job của worker (EventBridge chuyển phần detail vào hàng đợi transcode)
            await publish('upload', EVENT_TYPES.VideoUploaded, {
              ...videoFacts(completed),
              targetResolutions: config.targetResolutions,
            });
          } catch (err) {
            // Trả về UPLOADING để client gọi /complete lại, tránh video kẹt mà không ai xử lý
            await repo.transition(upload.videoId, 'COMPLETED', 'UPLOADING').catch(() => {});
            throw err;
          }
          uploadsCompleted.inc();
          res.json({ success: true, message: 'Đã nhận video, đang chờ transcode', data: completed });
        } catch (err) {
          next(err);
        }
      });
    },
  });
}
