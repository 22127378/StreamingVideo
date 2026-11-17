import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'node:stream/promises';
import mime from 'mime-types';
import { s3Client, config } from '../config/aws.js';

/**
 * Tải file từ S3 về ổ đĩa cục bộ (temporary directory)
 * @param {string} bucket
 * @param {string} key
 * @param {string} localFilePath
 * @param {{ signal?: AbortSignal }} options signal dùng để hủy khi worker tắt
 */
export async function downloadFileFromS3(bucket, key, localFilePath, { signal } = {}) {
  console.log(`[S3] Đang tải file s3://${bucket}/${key} về ${localFilePath}...`);

  fs.mkdirSync(path.dirname(localFilePath), { recursive: true });

  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
    abortSignal: signal,
  });

  // pipeline bắt lỗi ở cả stream đọc (S3) lẫn stream ghi (ổ đĩa)
  await pipeline(response.Body, fs.createWriteStream(localFilePath), { signal });

  console.log(`[S3] Tải xong file: ${localFilePath} (${fs.statSync(localFilePath).size} bytes)`);
  return localFilePath;
}

function contentTypeFor(file) {
  if (file.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (file.endsWith('.ts')) return 'video/mp2t';
  return mime.lookup(file) || 'application/octet-stream';
}

/**
 * Chạy fn cho từng phần tử với tối đa `limit` tác vụ cùng lúc
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 */
export async function forEachLimit(items, limit, fn) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Tải toàn bộ thư mục HLS output (playlist .m3u8, video segments .ts, thumbnail .jpg) lên S3.
 * File được đọc dạng stream và chỉ upload tối đa config.uploadConcurrency file cùng lúc,
 * nên bộ nhớ không tăng theo độ dài video.
 * @param {string} localDir Thư mục chứa các file HLS
 * @param {string} bucket S3 Processed Bucket
 * @param {string} s3Prefix Prefix thư mục S3 (ví dụ: videoId)
 * @param {{ signal?: AbortSignal }} options
 */
/** Đường dẫn tương đối (dùng dấu /) của mọi file trong thư mục, kể cả thư mục con */
export function listFilesRecursive(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFilesRecursive(path.join(dir, entry.name), rel) : [rel];
  });
}

export async function uploadDirectoryToS3(localDir, bucket, s3Prefix, { signal } = {}) {
  const files = listFilesRecursive(localDir);
  console.log(`[S3] Bắt đầu upload ${files.length} files từ ${localDir} lên s3://${bucket}/${s3Prefix}...`);

  // Upload playlist sau cùng để player không thấy playlist trỏ tới segment chưa có.
  // Master upload cuối cùng, sd/master.m3u8 trước master.m3u8.
  const isMaster = (f) => path.basename(f) === 'master.m3u8';
  const ordered = [
    ...files.filter((f) => !f.endsWith('.m3u8')),
    ...files.filter((f) => f.endsWith('.m3u8') && !isMaster(f)),
    ...files.filter(isMaster).sort((a, b) => b.length - a.length),
  ];
  const segments = ordered.filter((f) => !f.endsWith('.m3u8'));
  const playlists = ordered.filter((f) => f.endsWith('.m3u8'));

  const uploadOne = async (file) => {
    const fullPath = path.join(localDir, file);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${s3Prefix}/${file}`,
        Body: fs.createReadStream(fullPath),
        ContentLength: fs.statSync(fullPath).size,
        ContentType: contentTypeFor(file),
        CacheControl: file.endsWith('.m3u8') ? 'no-cache' : 'max-age=31536000',
      }),
      { abortSignal: signal }
    );
  };

  await forEachLimit(segments, config.uploadConcurrency, uploadOne);
  for (const file of playlists) {
    await uploadOne(file);
  }

  console.log(`[S3] Đã upload toàn bộ ${files.length} files lên s3://${bucket}/${s3Prefix}`);
}
