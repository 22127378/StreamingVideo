import { useEffect, useState } from 'react';
import { listChannels } from '../api.js';
import { href } from '../router.js';

const REFRESH_MS = 15000;

function ChannelCard({ channel }) {
  return (
    <li>
      <a className={`channel-card${channel.isLive ? ' live' : ''}`} href={href.channel(channel.channelId)}>
        <div className="channel-cover">
          <span className="channel-initial" aria-hidden="true">
            {channel.ownerName.slice(0, 1).toUpperCase()}
          </span>
          {channel.isLive ? (
            <span className="live-badge">● TRỰC TIẾP · {channel.viewerCount} đang xem</span>
          ) : (
            <span className="offline-badge">Ngoại tuyến</span>
          )}
        </div>
        <div className="channel-meta">
          <p className="title">{channel.title || 'Chưa đặt tiêu đề'}</p>
          <p className="sub">
            {channel.ownerName} · {channel.subscriberCount} người đăng ký
            {channel.subscribed && <span className="chat-badge subscriber">Đã đăng ký</span>}
          </p>
        </div>
      </a>
    </li>
  );
}

/** Trang Trực tiếp: kênh đang phát, kênh đã đăng ký, các kênh khác */
export default function LivePage({ user }) {
  const [channels, setChannels] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stopped = false;
    const load = () =>
      listChannels()
        .then(({ data }) => !stopped && (setChannels(data), setError('')))
        .catch((err) => !stopped && setError(err.message));
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [user?.sub]);

  const liveNow = channels?.filter((c) => c.isLive) ?? [];
  const subscribed = channels?.filter((c) => !c.isLive && c.subscribed) ?? [];
  const others = channels?.filter((c) => !c.isLive && !c.subscribed) ?? [];

  return (
    <main className="live-page">
      <div className="library-head">
        <h1>Trực tiếp</h1>
        <a className="primary" href={href.studio}>
          Phát trực tiếp
        </a>
      </div>
      {error && <p className="notice error">Không tải được danh sách kênh: {error}</p>}
      {!channels && !error && <p className="empty">Đang tải...</p>}

      {channels && (
        <>
          <section>
            <h2>Đang phát</h2>
            {liveNow.length ? (
              <ul className="channel-grid">
                {liveNow.map((c) => (
                  <ChannelCard key={c.channelId} channel={c} />
                ))}
              </ul>
            ) : (
              <p className="empty">Hiện không có kênh nào đang phát.</p>
            )}
          </section>

          {subscribed.length > 0 && (
            <section>
              <h2>Kênh đã đăng ký</h2>
              <ul className="channel-grid">
                {subscribed.map((c) => (
                  <ChannelCard key={c.channelId} channel={c} />
                ))}
              </ul>
            </section>
          )}

          {others.length > 0 && (
            <section>
              <h2>Kênh khác</h2>
              <ul className="channel-grid">
                {others.map((c) => (
                  <ChannelCard key={c.channelId} channel={c} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
