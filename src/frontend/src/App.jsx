import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteVideo,
  getVideo,
  issuePlaybackToken,
  listVideos,
  verifyPlayback,
} from './api.js';
import Uploader from './components/Uploader.jsx';
import VideoList from './components/VideoList.jsx';

// hls.js chỉ tải khi người dùng mở video
const Player = lazy(() => import('./components/Player.jsx'));

const PAGE_SIZE = 12;
const POLL_MS = 5000;

// Mô phỏng tài khoản: mỗi trình duyệt một userId, gói xem chọn ở góc trên
function useViewer() {
  const [userId] = useState(() => {
    try {
      const saved = localStorage.getItem('sf-user');
      if (saved) return saved;
      const id = `viewer-${crypto.randomUUID().slice(0, 8)}`;
      localStorage.setItem('sf-user', id);
      return id;
    } catch {
      return `viewer-${Math.random().toString(36).slice(2, 10)}`;
    }
  });
  const [tier, setTier] = useState(() => {
    try {
      return localStorage.getItem('sf-tier') || 'free';
    } catch {
      return 'free';
    }
  });
  const changeTier = (t) => {
    setTier(t);
    try {
      localStorage.setItem('sf-tier', t);
    } catch {
      /* chỉ là tuỳ chọn ghi nhớ */
    }
  };
  return { userId, tier, setTier: changeTier };
}

export default function App() {
  const viewer = useViewer();
  const [videos, setVideos] = useState([]);
  const [nextToken, setNextToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [current, setCurrent] = useState(null); // video đang xem
  const [playback, setPlayback] = useState({ state: 'idle' }); // idle | checking | allowed | denied | error
  const pagesLoaded = useRef(1);

  // Tải lại các trang đã xem (giữ nguyên số video đang hiển thị)
  const refresh = useCallback(async () => {
    try {
      const { data, nextToken: token } = await listVideos({ limit: PAGE_SIZE * pagesLoaded.current });
      setVideos(data);
      setNextToken(token);
      setListError('');
    } catch (err) {
      setListError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Có video đang upload hoặc xử lý thì tự cập nhật mỗi 5 giây
  const busy = videos.some((v) => v.status === 'PROCESSING' || v.status === 'UPLOADING' || v.status === 'DELETING');
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const loadMore = async () => {
    setLoading(true);
    try {
      const { data, nextToken: token } = await listVideos({ limit: PAGE_SIZE, nextToken });
      pagesLoaded.current += 1;
      setVideos((prev) => [...prev, ...data.filter((v) => !prev.some((p) => p.videoId === v.videoId))]);
      setNextToken(token);
    } catch (err) {
      setListError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Trước khi phát: xin token theo gói đang chọn, rồi xác minh quyền xem với API
  const openVideo = useCallback(
    async (video) => {
      setCurrent(video);
      setPlayback({ state: 'checking' });
      try {
        const { data } = await issuePlaybackToken({ userId: viewer.userId, tier: viewer.tier, videoId: video.videoId });
        await verifyPlayback({ token: data.token, videoId: video.videoId });
        const { data: fresh } = await getVideo(video.videoId);
        setCurrent(fresh);
        setPlayback({ state: 'allowed' });
      } catch (err) {
        setPlayback(err.status === 403 ? { state: 'denied', message: err.message } : { state: 'error', message: err.message });
      }
    },
    [viewer.userId, viewer.tier]
  );

  // Đổi gói thì kiểm tra lại quyền xem video đang mở
  useEffect(() => {
    if (current) openVideo(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer.tier]);

  const remove = async (video) => {
    if (!window.confirm(`Xoá "${video.title}"? File gốc và file HLS sẽ bị xoá.`)) return;
    try {
      await deleteVideo(video.videoId);
      if (current?.videoId === video.videoId) {
        setCurrent(null);
        setPlayback({ state: 'idle' });
      }
      await refresh();
    } catch (err) {
      window.alert(err.message);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="28" height="28">
              <rect width="32" height="32" rx="8" fill="currentColor" />
              <path d="M12 9l12 7-12 7z" fill="#0b0d12" />
            </svg>
          </span>
          <span>StreamForge</span>
        </div>
        <div className="tier-switch" role="radiogroup" aria-label="Gói xem">
          <span className="label">Gói xem</span>
          {['free', 'premium'].map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={viewer.tier === t}
              className={viewer.tier === t ? 'active' : ''}
              onClick={() => viewer.setTier(t)}
            >
              {t === 'free' ? 'Free' : 'Premium'}
            </button>
          ))}
        </div>
      </header>

      <main className="layout">
        <section className="stage">
          {current ? (
            <div className="card now-playing">
              {playback.state === 'allowed' && current.streamingUrl ? (
                <Suspense fallback={<div className="gate">Đang tải trình phát...</div>}>
                  <Player src={current.streamingUrl} poster={current.thumbnailUrl} />
                </Suspense>
              ) : (
                <div className={`gate ${playback.state}`}>
                  {playback.state === 'checking' && <p>Đang kiểm tra quyền xem...</p>}
                  {playback.state === 'denied' && (
                    <>
                      <p className="gate-title">Video dành cho gói Premium</p>
                      <p>{playback.message}</p>
                      <button className="primary" onClick={() => viewer.setTier('premium')}>
                        Chuyển sang Premium
                      </button>
                    </>
                  )}
                  {playback.state === 'error' && <p>Không mở được video: {playback.message}</p>}
                </div>
              )}
              <div className="now-meta">
                <h1>{current.title}</h1>
                <p>
                  {current.tier === 'premium' ? 'Premium' : 'Free'}
                  {current.qualities?.length ? ` · ${current.qualities.length} mức chất lượng` : ''}
                  {current.description ? ` · ${current.description}` : ''}
                </p>
              </div>
            </div>
          ) : (
            <div className="card empty-stage">
              <p>Chọn một video đã sẵn sàng để xem</p>
            </div>
          )}
          <Uploader onUploaded={refresh} />
        </section>

        <section className="library">
          <div className="library-head">
            <h2>Thư viện</h2>
            <button className="secondary" onClick={refresh}>
              Làm mới
            </button>
          </div>
          {listError && <p className="notice error">Không tải được danh sách: {listError}</p>}
          <VideoList
            videos={videos}
            selectedId={current?.videoId}
            onSelect={openVideo}
            onDelete={remove}
            onLoadMore={loadMore}
            hasMore={Boolean(nextToken)}
            loading={loading}
          />
        </section>
      </main>
    </div>
  );
}
