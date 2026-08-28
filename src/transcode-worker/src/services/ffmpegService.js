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

      resolve({
        duration: metadata.format.duration ? parseFloat(metadata.format.duration) : 0,
        size: metadata.format.size ? parseInt(metadata.format.size, 10) : 0,
        bitrate: metadata.format.bit_rate ? parseInt(metadata.format.bit_rate, 10) : 0,
        width: videoStream?.width || 1920,
        height: videoStream?.height || 1080,
        codec: videoStream?.codec_name || 'h264',
        fps: videoStream?.r_frame_rate || '30/1',
        hasAudio: !!audioStream,
      });
    });
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
        size: '1280x720',
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
            size: '1280x720',
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
 * @returns {Promise<{ name: string, playlist: string, profile: Object }>}
 */
export function transcodeHLSVariant(inputPath, outputDir, profile) {
  return new Promise((resolve, reject) => {
    const playlistName = `${profile.name}.m3u8`;
    const segmentPattern = `${profile.name}_%03d.ts`;
    const outputPath = path.join(outputDir, playlistName);

    console.log(`🎬 [FFmpeg] Bắt đầu transcode profile: ${profile.name} (${profile.width}x${profile.height})...`);

    ffmpeg(inputPath)
      // Video codec H.264 & Audio codec AAC
      .videoCodec('libx264')
      .audioCodec('aac')
      // Scale resolution giữ đúng tỷ lệ (aspect ratio)
      .size(`${profile.width}x${profile.height}`)
      .outputOptions([
        '-preset veryfast', // Tối ưu tốc độ xử lý
        `-b:v ${profile.videoBitrate}`,
        `-maxrate ${profile.maxrate}`,
        `-bufsize ${profile.bufsize}`,
        `-b:a ${profile.audioBitrate}`,
        '-g 48', // Keyframe interval (2s nếu 24fps)
        '-keyint_min 48',
        '-sc_threshold 0',
        '-hls_time 4', // Mỗi segment dài 4 giây
        '-hls_playlist_type vod',
        `-hls_segment_filename ${path.join(outputDir, segmentPattern)}`,
      ])
      .output(outputPath)
      .on('start', (cmd) => {
        // console.log(`[FFmpeg cmd] ${cmd}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          process.stdout.write(`⏳ [${profile.name}] ${Math.round(progress.percent)}% `);
        }
      })
      .on('end', () => {
        console.log(`\n✅ [FFmpeg] Hoàn thành profile ${profile.name}!`);
        resolve({
          name: profile.name,
          playlist: playlistName,
          profile,
        });
      })
      .on('error', (err) => {
        console.error(`\n❌ [FFmpeg] Lỗi khi transcode ${profile.name}:`, err.message);
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
    masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bandwidth},RESOLUTION=${profile.width}x${profile.height},NAME="${profile.name}"\n`;
    masterContent += `${playlist}\n\n`;
  }

  const masterPath = path.join(outputDir, 'master.m3u8');
  fs.writeFileSync(masterPath, masterContent, 'utf-8');
  return masterPath;
}
