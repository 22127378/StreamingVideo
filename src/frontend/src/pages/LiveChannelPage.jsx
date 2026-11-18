import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { getChannel, setSubscription } from '../api.js';
import LiveChat from '../components/LiveChat.jsx';
import { href } from '../router.js';

// hls.js chỉ tải khi mở trang xem
const LivePlayer = lazy(() => import('../components/LivePlayer.jsx'));

// Kiểm tra lại trạng thái phát để tự hiện trình phát khi streamer bắt đầu (và ẩn khi kết thúc)
const STATUS_MS = 10000;

/** Trang một kênh: trình phát, nút đăng ký, bình luận trực tiếp */
export default function LiveChannelPage({ id, user, onLogin }) {
  const [channel, setChannel] = useState(null);
  const [state, setState] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await getChannel(id);
      setChannel(data);
      setState('ready');
    } catch (err) {
      setState(err.status === 404 ? 'missing' : 'error');
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    setState('loading');
    load();
    const timer = setInterval(load, STATUS_MS);
    return () => clearInterval(timer);
  }, [load, user?.sub]);

  const toggleSubscription = async () => {
    if (!user) {
      onLogin();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { data } = await setSubscription(id, !channel.subscribed);
      setChannel((c) => ({ ...c, ...data }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (state === 'missing') {
    return (
      <main className="empty-stage card">
        <p className="gate-title">Không tìm thấy kênh</p>
        <a className="secondary" href={href.live}>
          Về trang Trực tiếp
        </a>
      </main>
    );
  }

  return (
    <main className="watch-layout live-layout">
      <section className="watch-main">
        <div className="card now-playing">
          {channel?.isLive ? (
            <Suspense fallback={<div className="gate">Đang tải trình phát...</div>}>
              <LivePlayer src={channel.playbackUrl} />
            </Suspense>
          ) : (
            <div className="gate">
              <div className="gate-inner">
                {state === 'loading' && <p>Đang mở kênh...</p>}
                {state === 'error' && <p>Không mở được kênh: {error}</p>}
                {state === 'ready' && (
                  <>
                    <p className="gate-title">Kênh đang ngoại tuyến</p>
                    <p>Trang sẽ tự phát khi {channel.ownerName} bắt đầu.</p>
                  </>
                )}
              </div>
            </div>
          )}

          {channel && (
            <div className="now-meta">
              <h1>{channel.title || 'Chưa đặt tiêu đề'}</h1>
              <div className="watch-stats">
                {channel.isLive ? (
                  <span className="live-badge inline">● TRỰC TIẾP · {channel.viewerCount} đang xem</span>
                ) : (
                  <span className="offline-badge inline">Ngoại tuyến</span>
                )}
              </div>
              <div className="channel-owner">
                <span className="channel-initial small" aria-hidden="true">
                  {channel.ownerName.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{channel.ownerName}</strong>
                  <p>{channel.subscriberCount} người đăng ký</p>
                </div>
                {channel.isOwner ? (
                  <a className="secondary small" href={href.studio}>
                    Quản lý kênh
                  </a>
                ) : (
                  <button
                    className={channel.subscribed ? 'secondary small' : 'primary small'}
                    onClick={toggleSubscription}
                    disabled={busy}
                  >
                    {channel.subscribed ? 'Đã đăng ký' : 'Đăng ký'}
                  </button>
                )}
              </div>
              {error && state === 'ready' && <p className="error-text">{error}</p>}
            </div>
          )}
        </div>
      </section>

      <aside className="watch-side">
        <LiveChat channelId={id} user={user} isOwner={Boolean(channel?.isOwner)} onLogin={onLogin} />
      </aside>
    </main>
  );
}
