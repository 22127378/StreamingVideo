import { useEffect, useRef, useState } from 'react';
// Bản light: không có phụ đề, DRM, audio phụ (không dùng tới), nhẹ hơn khoảng một nửa
import Hls from 'hls.js/light';

/**
 * Trình phát HLS. Dùng hls.js (có chọn chất lượng); trình duyệt không có MSE nhưng phát HLS
 * gốc (Safari trên iOS) thì gán thẳng src và để trình duyệt tự chọn chất lượng.
 */
/**
 * lockedQualities: các mức chất lượng gói hiện tại không xem được (ví dụ ['1080p'] với gói Free),
 * hiện thành nút khoá để người dùng biết và nâng cấp.
 */
export default function Player({ src, poster, lockedQualities = [], onUpgrade }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [levels, setLevels] = useState([]);
  const [selected, setSelected] = useState(-1); // -1 = Auto
  const [playing, setPlaying] = useState(null); // độ phân giải đang phát
  const [error, setError] = useState('');

  useEffect(() => {
    const video = videoRef.current;
    setLevels([]);
    setSelected(-1);
    setPlaying(null);
    setError('');
    if (!src || !video) return undefined;

    if (Hls.isSupported()) {
      const hls = new Hls({ capLevelToPlayerSize: true });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        setLevels(data.levels.map((l, index) => ({ index, height: Math.min(l.width, l.height), bitrate: l.bitrate })));
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const level = hls.levels[data.level];
        if (level) setPlaying(`${Math.min(level.width, level.height)}p`);
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) setError(`Không phát được video (${data.details})`);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      return () => video.removeAttribute('src');
    }

    setError('Trình duyệt này không hỗ trợ HLS');
    return undefined;
  }, [src]);

  const chooseLevel = (index) => {
    setSelected(index);
    if (hlsRef.current) hlsRef.current.currentLevel = index; // -1 = tự động theo băng thông
  };

  return (
    <div className="player">
      <video ref={videoRef} controls playsInline poster={poster} />
      {error && <p className="player-error">{error}</p>}
      {levels.length > 0 && (
        <div className="quality" role="group" aria-label="Chất lượng">
          <button className={selected === -1 ? 'active' : ''} onClick={() => chooseLevel(-1)}>
            Auto{selected === -1 && playing ? ` · ${playing}` : ''}
          </button>
          {[...levels]
            .sort((a, b) => b.height - a.height)
            .map((l) => (
              <button key={l.index} className={selected === l.index ? 'active' : ''} onClick={() => chooseLevel(l.index)}>
                {l.height}p
              </button>
            ))}
          {lockedQualities.map((q) => (
            <button key={q} className="locked" onClick={onUpgrade} title={`${q} dành cho gói Premium`}>
              {q} <span className="lock-tag">Premium</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
