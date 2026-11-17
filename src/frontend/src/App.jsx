import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteVideo,
  getMe,
  getVideo,
  listVideos,
  startPlayback,
  upgradeToPremium,
} from './api.js';
import { initAuth, isLoggedIn, logout, refreshSession, sessionEmail, setDevSession } from './auth.js';
import AuthModal from './components/AuthModal.jsx';
import Uploader from './components/Uploader.jsx';
import VideoList from './components/VideoList.jsx';

// hls.js chỉ tải khi người dùng mở video
const Player = lazy(() => import('./components/Player.jsx'));

const PAGE_SIZE = 12;
const POLL_MS = 5000;

export default function App() {
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState('');
  const [user, setUser] = useState(null); // { sub, email, tier }
  const [showAuth, setShowAuth] = useState(false);
  const [upgrading, setUpgrading] = useState(false);

  const [videos, setVideos] = useState([]);
  const [nextToken, setNextToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [current, setCurrent] = useState(null); // video đang xem
  const [playback, setPlayback] = useState({ state: 'idle' }); // idle | checking | allowed | denied | login | error
  const pagesLoaded = useRef(1);

  const loadUser = useCallback(async () => {
    if (!(await isLoggedIn())) {
      setUser(null);
      return null;
    }
    try {
      const { data } = await getMe();
      const me = { ...data, email: data.email || (await sessionEmail()) };
      setUser(me);
      return me;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    initAuth()
      .then(loadUser)
      .catch((err) => setAuthError(err.message))
      .finally(() => setReady(true));
  }, [loadUser]);

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
    if (ready) refresh();
  }, [ready, refresh]);

  // Có video đang upload hoặc xử lý thì tự cập nhật mỗi 5 giây
  const busy = videos.some((v) => ['PROCESSING', 'UPLOADING', 'DELETING'].includes(v.status));
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

  // Xin quyền xem: API kiểm tra gói và đặt signed cookies, sau đó mới phát
  const openVideo = useCallback(
    async (video) => {
      setCurrent(video);
      if (!(await isLoggedIn())) {
        setPlayback({ state: 'login' });
        return;
      }
      setPlayback({ state: 'checking' });
      try {
        await startPlayback(video.videoId);
        const { data: fresh } = await getVideo(video.videoId);
        setCurrent(fresh);
        setPlayback({ state: 'allowed' });
      } catch (err) {
        if (err.status === 401) setPlayback({ state: 'login' });
        else if (err.status === 403) setPlayback({ state: 'denied', message: err.message });
        else setPlayback({ state: 'error', message: err.message });
      }
    },
    []
  );

  const login = () => setShowAuth(true);

  const afterSignIn = async () => {
    setShowAuth(false);
    await loadUser();
    if (current) openVideo(current);
  };

  const signOut = () => {
    logout();
    setUser(null);
    if (current) setPlayback({ state: 'login' });
  };

  const upgrade = async () => {
    setUpgrading(true);
    try {
      const { data } = await upgradeToPremium();
      if (data.token) setDevSession({ token: data.token, email: user?.email });
      if (data.refreshRequired) await refreshSession();
      await loadUser();
      if (current) await openVideo(current);
    } catch (err) {
      window.alert(err.message);
    } finally {
      setUpgrading(false);
    }
  };

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

  const canDelete = (video) => Boolean(user) && (!video.ownerId || video.ownerId === user.sub);

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

        <div className="account">
          {user ? (
            <>
              <span className="user-email" title={user.email}>
                {user.email}
              </span>
              {user.admin && <span className="tier-pill admin">Admin</span>}
              <span className={`tier-pill ${user.tier}`}>{user.tier === 'premium' ? 'Premium' : 'Free'}</span>
              {user.tier !== 'premium' && (
                <button className="primary small" onClick={upgrade} disabled={upgrading}>
                  {upgrading ? 'Đang nâng cấp...' : 'Nâng cấp Premium'}
                </button>
              )}
              <button className="secondary small" onClick={signOut}>
                Đăng xuất
              </button>
            </>
          ) : (
            ready && (
              <button className="primary small" onClick={login}>
                Đăng nhập
              </button>
            )
          )}
        </div>
      </header>

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} onSignedIn={afterSignIn} />}
      {authError && <p className="notice error">Lỗi đăng nhập: {authError}</p>}

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
                  {playback.state === 'login' && (
                    <>
                      <p className="gate-title">Đăng nhập để xem video</p>
                      <button className="primary" onClick={login}>
                        Đăng nhập
                      </button>
                    </>
                  )}
                  {playback.state === 'denied' && (
                    <>
                      <p className="gate-title">Video dành cho gói Premium</p>
                      <p>Tài khoản của bạn đang ở gói Free.</p>
                      <button className="primary" onClick={upgrade} disabled={upgrading}>
                        {upgrading ? 'Đang nâng cấp...' : 'Nâng cấp Premium'}
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
          {user ? (
            <Uploader onUploaded={refresh} />
          ) : (
            <div className="card empty-stage small">
              <p>Đăng nhập để upload video</p>
            </div>
          )}
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
            canDelete={canDelete}
            onLoadMore={loadMore}
            hasMore={Boolean(nextToken)}
            loading={loading}
          />
        </section>
      </main>
    </div>
  );
}
