import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  HLS_PROFILES,
  createMasterPlaylist,
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
});
