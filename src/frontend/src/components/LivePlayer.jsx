import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js/light';

/**
 * Trình phát luồng trực tiếp (HLS từ IVS, hoặc MediaMTX khi chạy local).
 * Giữ gần điểm live (vài đoạn cuối); luồng đứt giữa chừng thì thử nạp lại thay vì báo lỗi ngay,
 * vì streamer thường chỉ mất mạng vài giây.
 */
export default function LivePlayer({ src }) {
  const videoRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const video = videoRef.current;
    setError('');
    if (!src || !video) return undefined;

    if (Hls.isSupported()) {
      let retries = 0;
      let retryTimer;
      const hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, backBufferLength: 30 });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        retries = 0;
        video.play().catch(() => {}); // trình duyệt chặn tự phát có tiếng thì chờ người dùng bấm
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else if (retries < 5) {
          retries += 1;
          retryTimer = setTimeout(() => hls.loadSource(src), 2000 * retries);
        } else {
          setError('Mất kết nối tới luồng phát');
        }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => {
        clearTimeout(retryTimer);
        hls.destroy();
      };
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => {});
      return () => video.removeAttribute('src');
    }

    setError('Trình duyệt này không hỗ trợ HLS');
    return undefined;
  }, [src]);

  return (
    <div className="player">
      <video ref={videoRef} controls playsInline muted />
      {error && <p className="player-error">{error}</p>}
    </div>
  );
}
