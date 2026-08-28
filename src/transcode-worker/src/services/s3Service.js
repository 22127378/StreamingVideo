import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { s3Client } from '../config/aws.js';

/**
 * Tải file từ S3 về ổ đĩa cục bộ (temporary directory)
 * @param {string} bucket
 * @param {string} key
 * @param {string} localFilePath
 */
export async function downloadFileFromS3(bucket, key, localFilePath) {
  console.log(`📥 [S3] Đang tải file s3://${bucket}/${key} về ${localFilePath}...`);

  const dir = path.dirname(localFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const response = await s3Client.send(command);

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(localFilePath);
    response.Body.pipe(writeStream)
      .on('finish', () => {
        console.log(`✅ [S3] Tải xong file: ${localFilePath} (${fs.statSync(localFilePath).size} bytes)`);
        resolve(localFilePath);
      })
      .on('error', reject);
  });
}

/**
 * Tải toàn bộ thư mục HLS output (playlist .m3u8, video segments .ts, thumbnail .jpg) lên S3
 * @param {string} localDir Thư mục chứa các file HLS
 * @param {string} bucket S3 Processed Bucket
 * @param {string} s3Prefix Prefix thư mục S3 (ví dụ: videoId/)
 */
export async function uploadDirectoryToS3(localDir, bucket, s3Prefix) {
  const files = fs.readdirSync(localDir);
  console.log(`📤 [S3] Bắt đầu upload ${files.length} files từ ${localDir} lên s3://${bucket}/${s3Prefix}...`);

  const uploadPromises = files.map(async (file) => {
    const fullPath = path.join(localDir, file);
    const s3Key = `${s3Prefix}/${file}`;

    let contentType = mime.lookup(file) || 'application/octet-stream';
    if (file.endsWith('.m3u8')) {
      contentType = 'application/vnd.apple.mpegurl';
    } else if (file.endsWith('.ts')) {
      contentType = 'video/mp2t';
    }

    const fileBuffer = fs.readFileSync(fullPath);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: contentType,
      CacheControl: file.endsWith('.m3u8') ? 'no-cache' : 'max-age=31536000', // Caching segments
    });

    await s3Client.send(command);
    // console.log(`   ✓ Uploaded: ${s3Key} (${contentType})`);
  });

  await Promise.all(uploadPromises);
  console.log(`✅ [S3] Đã upload toàn bộ ${files.length} files lên s3://${bucket}/${s3Prefix}!`);
}
