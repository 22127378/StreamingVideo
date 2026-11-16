import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  HLS_PROFILES,
  createMasterPlaylist,
  computeOutputSize,
  selectProfiles,
  parseFrameRate,
} from '../src/services/ffmpegService.js';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

test('StreamForge Transcode Worker Unit Tests', async (t) => {
  await t.test('1. FFmpeg and FFprobe binaries are bundled and accessible', () => {
    assert.ok(ffmpegInstaller.path, 'FFmpeg binary path should exist');
    assert.ok(ffprobeInstaller.path, 'FFprobe binary path should exist');
    assert.ok(fs.existsSync(ffmpegInstaller.path), `FFmpeg binary must exist on disk: ${ffmpegInstaller.path}`);
    assert.ok(fs.existsSync(ffprobeInstaller.path), `FFprobe binary must exist on disk: ${ffprobeInstaller.path}`);
  });

  await t.test('2. HLS Profiles contain required bitrates and dimensions', () => {
    assert.ok(HLS_PROFILES['1080p']);
    assert.ok(HLS_PROFILES['720p']);
    assert.ok(HLS_PROFILES['480p']);
    assert.ok(HLS_PROFILES['360p']);

    assert.strictEqual(HLS_PROFILES['1080p'].width, 1920);
    assert.strictEqual(HLS_PROFILES['1080p'].height, 1080);
    assert.strictEqual(HLS_PROFILES['720p'].width, 1280);
    assert.strictEqual(HLS_PROFILES['720p'].height, 720);
  });

  await t.test('3. Master Playlist (.m3u8) generator creates valid HLS manifest', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamforge-test-'));

    const mockVariants = [
      {
        name: '1080p',
        playlist: '1080p.m3u8',
        profile: HLS_PROFILES['1080p'],
      },
      {
        name: '720p',
        playlist: '720p.m3u8',
        profile: HLS_PROFILES['720p'],
      },
      {
        name: '360p',
        playlist: '360p.m3u8',
        profile: HLS_PROFILES['360p'],
      },
    ];

    const masterPath = createMasterPlaylist(mockVariants, tempDir);
    assert.ok(fs.existsSync(masterPath));

    const content = fs.readFileSync(masterPath, 'utf-8');
    assert.ok(content.startsWith('#EXTM3U'));
    assert.ok(content.includes('#EXT-X-VERSION:3'));
    assert.ok(content.includes('RESOLUTION=1920x1080'));
    assert.ok(content.includes('1080p.m3u8'));
    assert.ok(content.includes('RESOLUTION=1280x720'));
    assert.ok(content.includes('720p.m3u8'));
    assert.ok(content.includes('RESOLUTION=640x360'));
    assert.ok(content.includes('360p.m3u8'));

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await t.test('4. computeOutputSize keeps aspect ratio and never upscales', () => {
    // 16:9 ngang
    assert.deepStrictEqual(computeOutputSize({ width: 1920, height: 1080 }, HLS_PROFILES['720p']), { width: 1280, height: 720 });
    // 4:3
    assert.deepStrictEqual(computeOutputSize({ width: 1440, height: 1080 }, HLS_PROFILES['720p']), { width: 960, height: 720 });
    // Video dọc 9:16: cạnh ngắn (width) = 720
    assert.deepStrictEqual(computeOutputSize({ width: 1080, height: 1920 }, HLS_PROFILES['720p']), { width: 720, height: 1280 });
    // Nguồn nhỏ hơn profile -> giữ nguyên, không upscale
    assert.deepStrictEqual(computeOutputSize({ width: 640, height: 360 }, HLS_PROFILES['1080p']), { width: 640, height: 360 });
    // Luôn ra số chẵn (yêu cầu của libx264)
    const odd = computeOutputSize({ width: 1918, height: 1078 }, HLS_PROFILES['480p']);
    assert.strictEqual(odd.width % 2, 0);
    assert.strictEqual(odd.height % 2, 0);
  });

  await t.test('5. selectProfiles compares on short side and dedupes', () => {
    const all = ['1080p', '720p', '480p', '360p'];
    const names = (meta) => selectProfiles(meta, all).map((p) => p.name);

    assert.deepStrictEqual(names({ width: 1920, height: 1080 }), all);
    // Video dọc 1080x1920 phải có đủ 4 profile (trước đây so theo height nên sai)
    assert.deepStrictEqual(names({ width: 1080, height: 1920 }), all);
    assert.deepStrictEqual(names({ width: 1280, height: 720 }), ['720p', '480p', '360p']);
    // Nguồn nhỏ hơn 360p: chỉ giữ 1 profile thấp nhất
    assert.deepStrictEqual(names({ width: 426, height: 240 }), ['360p']);
    // Danh sách yêu cầu rỗng/không hợp lệ -> fallback 360p
    assert.deepStrictEqual(selectProfiles({ width: 1920, height: 1080 }, ['4k']).map((p) => p.name), ['360p']);
  });

  await t.test('6. parseFrameRate handles ffprobe fractions', () => {
    assert.strictEqual(parseFrameRate('25/1'), 25);
    assert.ok(Math.abs(parseFrameRate('30000/1001') - 29.97) < 0.01);
    assert.strictEqual(parseFrameRate('0/0'), null);
    assert.strictEqual(parseFrameRate(undefined), null);
  });

  await t.test('7. Master playlist uses actual variant resolution', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamforge-test-'));
    const masterPath = createMasterPlaylist(
      [{ playlist: '720p.m3u8', profile: HLS_PROFILES['720p'], width: 720, height: 1280 }],
      tempDir
    );
    const content = fs.readFileSync(masterPath, 'utf-8');
    assert.ok(content.includes('RESOLUTION=720x1280'));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
