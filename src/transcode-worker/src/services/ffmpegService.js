import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import fs from 'fs';
import path from 'path';

// Cấu hình đường dẫn binary cho ffmpeg và ffprobe
if (ffmpegInstaller.path) {
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
}
if (ffprobeInstaller.path) {
  ffmpeg.setFfprobePath(ffprobeInstaller.path);
}

// Bảng cấu hình các profile độ phân giải và bitrate cho Adaptive Bitrate Streaming (HLS)
export const HLS_PROFILES = {
  '1080p': {
    name: '1080p',
    width: 1920,
    height: 1080,
    videoBitrate: '4500k',
    maxrate: '4800k',
    bufsize: '9000k',
    audioBitrate: '192k',
    bandwidth: 4700000,
  },
  '720p': {
    name: '720p',
    width: 1280,
    height: 720,
    videoBitrate: '2500k',
    maxrate: '2700k',
    bufsize: '5000k',
    audioBitrate: '128k',
    bandwidth: 2650000,
  },
  '480p': {
    name: '480p',
    width: 854,
    height: 480,
    videoBitrate: '1200k',
    maxrate: '1350k',
    bufsize: '2400k',
    audioBitrate: '96k',
    bandwidth: 1300000,
  },
  '360p': {
    name: '360p',
    width: 640,
    height: 360,
    videoBitrate: '800k',
    maxrate: '900k',
    bufsize: '1600k',
    audioBitrate: '64k',
    bandwidth: 870000,
  },
};

/**
 * Trích xuất thông số kỹ thuật của video gốc qua ffprobe (duration, resolution, fps)
 * @param {string} inputPath
 * @returns {Promise<Object>}
 */
export function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);

      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
      const audioStream = metadata.streams.find((s) => s.codec_type === 'audio');

      let width = videoStream?.width || 1920;
      let height = videoStream?.height || 1080;

      // Video quay bằng điện thoại thường lưu khung ngang + metadata xoay 90/270 độ.
      // FFmpeg tự xoay (autorotate) khi transcode, nên kích thước hiển thị phải hoán đổi.
      const rotation = getRotation(videoStream);
      if (Math.abs(rotation) % 180 === 90) {
        [width, height] = [height, width];
      }

      resolve({
        duration: metadata.format.duration ? parseFloat(metadata.format.duration) : 0,
        size: metadata.format.size ? parseInt(metadata.format.size, 10) : 0,
        bitrate: metadata.format.bit_rate ? parseInt(metadata.format.bit_rate, 10) : 0,
        width,
        height,
        rotation,
        codec: videoStream?.codec_name || 'h264',
        fps: parseFrameRate(videoStream?.avg_frame_rate) || parseFrameRate(videoStream?.r_frame_rate) || 30,
        hasAudio: !!audioStream,
      });
    });
  });
}

function getRotation(videoStream) {
  if (!videoStream) return 0;
  const tagRotate = parseInt(videoStream.tags?.rotate, 10);
  if (!Number.isNaN(tagRotate)) return tagRotate;
  const sideData = (videoStream.side_data_list || []).find((d) => d.rotation !== undefined);
  return sideData ? parseInt(sideData.rotation, 10) || 0 : 0;
}

/**
 * Chuyển chuỗi frame rate của ffprobe ("30000/1001", "25/1", "0/0") thành số
 * @param {string} rate
 * @returns {number|null}
 */
export function parseFrameRate(rate) {
  if (!rate || typeof rate !== 'string') return null;
  const [num, den] = rate.split('/').map(Number);
  const fps = den ? num / den : num;
  return Number.isFinite(fps) && fps > 0 && fps <= 240 ? fps : null;
}

const toEven = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Tính kích thước output thực tế cho một profile, giữ nguyên tỷ lệ khung hình và không upscale.
 * profile.height được hiểu là "cạnh ngắn" mục tiêu (720p = cạnh ngắn 720px),
 * nên video dọc 1080x1920 ở profile 720p sẽ ra 720x1280.
 * @param {{ width: number, height: number }} meta
 * @param {Object} profile
 * @returns {{ width: number, height: number }}
 */
export function computeOutputSize(meta, profile) {
  const { width: srcW, height: srcH } = meta;
  const shortSide = Math.min(srcW, srcH);
  const targetShort = Math.min(profile.height, shortSide);
  const scale = targetShort / shortSide;
  return {
    width: toEven(srcW * scale),
    height: toEven(srcH * scale),
  };
}

/**
 * Chọn các profile phù hợp với video nguồn (so theo cạnh ngắn, không upscale).
 * Profile thấp nhất được yêu cầu luôn được giữ để video nào cũng có ít nhất 1 biến thể.
 * Các profile cho ra cùng kích thước sẽ bị loại trùng.
 * @param {{ width: number, height: number }} meta
 * @param {string[]} targetResolutions
 * @returns {Object[]}
 */
export function selectProfiles(meta, targetResolutions) {
  const requested = targetResolutions
    .map((res) => HLS_PROFILES[res])
    .filter(Boolean)
    .sort((a, b) => b.height - a.height);

  if (requested.length === 0) return [HLS_PROFILES['360p']];

  const shortSide = Math.min(meta.width, meta.height);
  const lowest = requested[requested.length - 1];
  const selected = requested.filter((p) => shortSide >= p.height * 0.8 || p === lowest);

  const seen = new Set();
  return selected.filter((p) => {
    const { width, height } = computeOutputSize(meta, p);
    const key = `${width}x${height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Trích xuất ảnh Thumbnail JPG tại giây thứ 2 của video
 * @param {string} inputPath
 * @param {string} outputDir
 * @param {number} timestampSeconds
 * @returns {Promise<string>} Đường dẫn file thumbnail đã tạo
 */
export function generateThumbnail(inputPath, outputDir, timestampSeconds = 2) {
  return new Promise((resolve, reject) => {
    const filename = 'thumbnail.jpg';
    ffmpeg(inputPath)
      .screenshots({
        timestamps: [timestampSeconds],
        filename,
        folder: outputDir,
        size: '?x720',
      })
      .on('end', () => {
        resolve(path.join(outputDir, filename));
      })
      .on('error', (err) => {
        console.warn(`[FFmpeg] Failed to generate thumbnail at ${timestampSeconds}s, trying 0.5s:`, err.message);
        // Fallback tại 0.5s nếu video quá ngắn
        ffmpeg(inputPath)
          .screenshots({
            timestamps: [0.5],
            filename,
            folder: outputDir,
            size: '?x720',
          })
          .on('end', () => resolve(path.join(outputDir, filename)))
          .on('error', reject);
      });
  });
}

/**
 * Transcode một biến thể độ phân giải HLS (m3u8 + .ts segments)
 * @param {string} inputPath Đường dẫn file nguồn
 * @param {string} outputDir Thư mục đích
 * @param {Object} profile Cấu hình profile (1080p, 720p...)
 * @param {{ width: number, height: number, fps: number }} meta Thông số video gốc (từ probeVideo)
 * @returns {Promise<{ name: string, playlist: string, profile: Object, width: number, height: number }>}
 */
export function transcodeHLSVariant(inputPath, outputDir, profile, meta) {
  return new Promise((resolve, reject) => {
    const playlistName = `${profile.name}.m3u8`;
    const segmentPattern = `${profile.name}_%03d.ts`;
    const outputPath = path.join(outputDir, playlistName);

    const { width, height } = computeOutputSize(meta, profile);
    // Keyframe mỗi 2 giây theo fps thực tế, để segment 4s luôn cắt đúng keyframe
    const gop = Math.max(1, Math.round((meta.fps || 30) * 2));

    console.log(`[FFmpeg] Bắt đầu transcode profile: ${profile.name} (${width}x${height}, GOP ${gop})...`);

    ffmpeg(inputPath)
      // Video codec H.264 & Audio codec AAC
      .videoCodec('libx264')
      .audioCodec('aac')
      // Scale giữ đúng tỷ lệ khung hình (kích thước tính sẵn, luôn là số chẵn)
      .videoFilters([`scale=${width}:${height}`, 'setsar=1'])
      .outputOptions([
        '-preset veryfast', // Tối ưu tốc độ xử lý
        '-pix_fmt yuv420p', // Bắt buộc để trình duyệt/iOS phát được (nguồn 4:4:4 hoặc RGB sẽ không phát)
        '-profile:v high',
        `-b:v ${profile.videoBitrate}`,
        `-maxrate ${profile.maxrate}`,
        `-bufsize ${profile.bufsize}`,
        `-b:a ${profile.audioBitrate}`,
        `-g ${gop}`,
        `-keyint_min ${gop}`,
        '-sc_threshold 0',
        '-hls_time 4', // Mỗi segment dài 4 giây
        '-hls_playlist_type vod',
        `-hls_segment_filename ${path.join(outputDir, segmentPattern)}`,
      ])
      .output(outputPath)
      .on('progress', (progress) => {
        if (progress.percent) {
          process.stdout.write(`⏳ [${profile.name}] ${Math.round(progress.percent)}% `);
        }
      })
      .on('end', () => {
        console.log(`\n[FFmpeg] Hoàn thành profile ${profile.name}`);
        resolve({
          name: profile.name,
          playlist: playlistName,
          profile,
          width,
          height,
        });
      })
      .on('error', (err) => {
        console.error(`\n[FFmpeg] Lỗi khi transcode ${profile.name}:`, err.message);
        reject(err);
      })
      .run();
  });
}

/**
 * Tạo file Master Playlist (master.m3u8) tổng hợp các biến thể phân giải
 * @param {Array} variants Danh sách các variant đã transcode thành công
 * @param {string} outputDir
 * @returns {string} Nội dung file master.m3u8
 */
export function createMasterPlaylist(variants, outputDir) {
  let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n\n';

  for (const variant of variants) {
    const { profile, playlist } = variant;
    // RESOLUTION phải là kích thước thật của biến thể (sau khi scale giữ tỷ lệ)
    const width = variant.width ?? profile.width;
    const height = variant.height ?? profile.height;
    masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bandwidth},RESOLUTION=${width}x${height},NAME="${profile.name}"\n`;
    masterContent += `${playlist}\n\n`;
  }

  const masterPath = path.join(outputDir, 'master.m3u8');
  fs.writeFileSync(masterPath, masterContent, 'utf-8');
  return masterPath;
}
