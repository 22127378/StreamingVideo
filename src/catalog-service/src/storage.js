// Xoá file của video trên S3 và cache CloudFront.
import { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { cloudfrontClient, config, s3Client } from './config.js';

/**
 * Xoá mọi object có cùng prefix (ví dụ tất cả segment HLS của một video).
 * @param {string} prefix phải kết thúc bằng "/" để không xoá nhầm prefix dài hơn
 * @returns {Promise<number>} số object đã xoá
 */
export async function deleteS3Prefix(bucket, prefix) {
  if (!prefix.endsWith('/')) throw new Error(`Prefix phải kết thúc bằng "/": ${prefix}`);
  let deleted = 0;
  let token;
  do {
    const page = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const objects = (page.Contents || []).map(({ Key }) => ({ Key }));
    if (objects.length) {
      const result = await s3Client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      if (result.Errors?.length) {
        const first = result.Errors[0];
        throw new Error(`Không xoá được ${result.Errors.length} object trong s3://${bucket}/${prefix} (${first.Key}: ${first.Message})`);
      }
      deleted += objects.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

/**
 * Đường dẫn cần invalidate để xoá cache HLS của một video.
 * Khoá cache của CloudFront được tạo từ URI SAU khi viewer-request function bỏ tiền tố /videos,
 * nên object nằm trong cache dưới /{id}/...; invalidate cả /videos/{id}/* và /{id}/*.
 */
export function videoInvalidationPaths(videoId, cdnBaseUrl = config.cdnBaseUrl) {
  const prefix = new URL(cdnBaseUrl).pathname.replace(/\/+$/, '');
  return [...new Set([`${prefix}/${videoId}/*`, `/${videoId}/*`])];
}

export async function invalidateVideoCache(videoId) {
  if (!config.cloudfrontDistributionId) return { invalidated: false, reason: 'CLOUDFRONT_DISTRIBUTION_ID not set' };
  const paths = videoInvalidationPaths(videoId);
  const response = await cloudfrontClient.send(
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

/** Xoá file gốc, HLS và cache của một video */
export async function purgeVideoFiles(video) {
  const [raw, processed] = await Promise.all([
    deleteS3Prefix(video.rawBucket || config.rawBucket, `raw/${video.videoId}/`),
    deleteS3Prefix(video.processedBucket || config.processedBucket, `${video.videoId}/`),
  ]);
  const cache = await invalidateVideoCache(video.videoId);
  return { deletedObjects: raw + processed, cache };
}
