import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { config } from '../config/aws.js';

// CloudFront là dịch vụ global, API của nó nằm ở us-east-1
const client = new CloudFrontClient({ region: 'us-east-1' });

/**
 * Các đường dẫn cần invalidate để xoá cache HLS của một video.
 *
 * Khoá cache của CloudFront được tạo từ URI SAU khi viewer-request function chạy. Distribution
 * bỏ tiền tố /videos trước khi tới S3, nên object nằm trong cache dưới /{id}/..., không phải
 * /videos/{id}/... như URL người xem dùng. Invalidate cả hai để đúng dù có function hay không
 * (đã đo: chỉ invalidate /videos/{id}/* thì segment vẫn được trả từ cache).
 */
export function videoInvalidationPaths(videoId, cdnBaseUrl = config.cdnBaseUrl) {
  const prefix = new URL(cdnBaseUrl).pathname.replace(/\/+$/, '');
  return [...new Set([`${prefix}/${videoId}/*`, `/${videoId}/*`])];
}

/**
 * Xoá cache CloudFront của một video sau khi file trên S3 đã bị xoá. Không có thì segment
 * (Cache-Control max-age 1 năm) vẫn phát được từ edge.
 * @returns {Promise<{ invalidated: boolean, invalidationId?: string, paths?: string[], reason?: string }>}
 */
export async function invalidateVideoCache(videoId) {
  if (!config.cloudfrontDistributionId) {
    return { invalidated: false, reason: 'CLOUDFRONT_DISTRIBUTION_ID not set' };
  }
  const paths = videoInvalidationPaths(videoId);
  const response = await client.send(
    new CreateInvalidationCommand({
      DistributionId: config.cloudfrontDistributionId,
      InvalidationBatch: {
        CallerReference: `delete-${videoId}-${Date.now()}`,
        Paths: { Quantity: paths.length, Items: paths },
      },
    })
  );
  return { invalidated: true, invalidationId: response.Invalidation?.Id, paths };
}
