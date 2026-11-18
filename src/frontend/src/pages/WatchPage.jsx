import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { getVideo, listVideos, rateVideo, startPlayback } from '../api.js';
import { RatingBadge, StarInput } from '../components/Stars.jsx';
import VideoList, { formatViews, timeAgo } from '../components/VideoList.jsx';
import { href } from '../router.js';

// hls.js chỉ tải khi mở trang xem
const Player = lazy(() => import('../components/Player.jsx'));

/**
 * Trang xem: xin quyền phát (playback-service kiểm tra gói, đặt signed cookie, phát sự kiện lượt xem)
 * rồi phát HLS.
 * Gói Free nhận master playlist chỉ tới 720p; CloudFront chặn luôn file 1080p với cookie của gói Free.
 */
export default function WatchPage({ id, user, onLogin, onUpgrade, upgrading }) {
  const [video, setVideo] = useState(null);
  const [playback, setPlayback] = useState({ state: 'loading' });
  const [rating, setRating] = useState({ busy: false, error: '' });
  const [related, setRelated] = useState([]);

  const open = useCallback(async () => {
    setPlayback({ state: 'loading' });
    let info;
    try {
      ({ data: info } = await getVideo(id));
      setVideo(info);
    } catch (err) {
      setPlayback({ state: err.status === 404 ? 'missing' : 'error', message: err.message });
      return;
    }
    if (!user) {
      setPlayback({ state: 'login' });
      return;
    }
    try {
      const { data } = await startPlayback(id);
      // Lượt xem được catalog cộng qua sự kiện (vài giây sau); hiển thị trước +1 cho người đang xem
      setPlayback({ state: 'allowed', ...data, myRating: info.myRating ?? null });
      setVideo((v) => ({ ...v, viewCount: (v.viewCount || 0) + 1 }));
    } catch (err) {
      if (err.status === 401) setPlayback({ state: 'login' });
      else if (err.status === 403) setPlayback({ state: 'denied', message: err.message });
      else setPlayback({ state: 'error', message: err.message });
    }
  }, [id, user]);

  useEffect(() => {
    open();
  }, [open]);

  useEffect(() => {
    listVideos({ limit: 9, status: 'READY', sort: 'views' })
      .then(({ data }) => setRelated(data.filter((v) => v.videoId !== id).slice(0, 8)))
      .catch(() => setRelated([]));
  }, [id]);

  const rate = async (stars) => {
    setRating({ busy: true, error: '' });
    try {
      const { data } = await rateVideo(id, stars);
      setVideo((v) => ({ ...v, ratingAvg: data.ratingAvg, ratingCount: data.ratingCount }));
      setPlayback((p) => ({ ...p, myRating: data.myRating }));
      setRating({ busy: false, error: '' });
    } catch (err) {
      setRating({ busy: false, error: err.message });
    }
  };

  const premiumUser = user && (user.tier === 'premium' || user.admin);

  return (
    <main className="watch-layout">
      <section className="watch-main">
        <div className="card now-playing">
          {playback.state === 'allowed' && playback.streamingUrl ? (
            <Suspense fallback={<div className="gate">Đang tải trình phát...</div>}>
              <Player
                src={playback.streamingUrl}
                poster={video?.thumbnailUrl}
                lockedQualities={playback.lockedQualities}
                onUpgrade={onUpgrade}
              />
            </Suspense>
          ) : (
            <div className="gate" style={video?.thumbnailUrl ? { backgroundImage: `url(${video.thumbnailUrl})` } : undefined}>
              <div className="gate-inner">
                {playback.state === 'loading' && <p>Đang mở video...</p>}
                {playback.state === 'missing' && (
                  <>
                    <p className="gate-title">Không tìm thấy video</p>
                    <a className="secondary" href={href.home}>
                      Về trang chính
                    </a>
                  </>
                )}
                {playback.state === 'login' && (
                  <>
                    <p className="gate-title">Đăng nhập để xem video</p>
                    <button className="primary" onClick={onLogin}>
                      Đăng nhập
                    </button>
                  </>
                )}
                {playback.state === 'denied' && (
                  <>
                    <p className="gate-title">Video dành cho gói Premium</p>
                    <p>Tài khoản của bạn đang ở gói Free.</p>
                    <button className="primary" onClick={onUpgrade} disabled={upgrading}>
                      {upgrading ? 'Đang nâng cấp...' : 'Nâng cấp Premium'}
                    </button>
                  </>
                )}
                {playback.state === 'error' && <p>Không mở được video: {playback.message}</p>}
              </div>
            </div>
          )}

          {video && (
            <div className="now-meta">
              <h1>{video.title}</h1>
              <div className="watch-stats">
                <span>{formatViews(video.viewCount)}</span>
                <span>{timeAgo(video.createdAt)}</span>
                <span className={`tier-pill ${video.tier}`}>{video.tier === 'premium' ? 'Premium' : 'Free'}</span>
                <RatingBadge avg={video.ratingAvg || 0} count={video.ratingCount || 0} />
              </div>
              {video.description && <p className="description">{video.description}</p>}

              {playback.state === 'allowed' && playback.maxHeight && (
                <p className="quality-note">
                  Gói Free xem tối đa {playback.maxHeight}p.
                  {playback.lockedQualities?.length > 0 && <> Video này có bản {playback.lockedQualities.join(', ')} cho gói Premium.</>}{' '}
                  {!premiumUser && (
                    <button className="link" onClick={onUpgrade} disabled={upgrading}>
                      Nâng cấp
                    </button>
                  )}
                </p>
              )}

              {playback.state === 'allowed' && (
                <div className="rate-row">
                  <span>{playback.myRating ? 'Bạn đã chấm' : 'Chấm điểm video này'}</span>
                  <StarInput value={playback.myRating} onRate={rate} disabled={rating.busy} />
                  {rating.error && <span className="error-text">{rating.error}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <aside className="watch-side">
        <h2>Xem nhiều</h2>
        <VideoList videos={related} loading={false} emptyText="Chưa có video khác." />
      </aside>
    </main>
  );
}
