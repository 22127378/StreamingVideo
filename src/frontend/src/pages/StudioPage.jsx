import { useEffect, useState } from 'react';
import { createChannel, getStudio, resetStreamKey, updateStudio } from '../api.js';
import { href } from '../router.js';

function CopyField({ label, value, secret }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <label className="field">
      <span>{label}</span>
      <div className="copy-field">
        <input readOnly value={shown ? value : '•'.repeat(24)} onFocus={(e) => shown && e.target.select()} />
        {secret && (
          <button type="button" className="secondary small" onClick={() => setShown((s) => !s)}>
            {shown ? 'Ẩn' : 'Hiện'}
          </button>
        )}
        <button type="button" className="secondary small" onClick={copy}>
          {copied ? 'Đã chép' : 'Chép'}
        </button>
      </div>
    </label>
  );
}

/** Studio: tạo kênh, lấy địa chỉ và khoá stream cho OBS, đổi tiêu đề, đổi khoá */
export default function StudioPage({ user, onLogin }) {
  const [studio, setStudio] = useState(null);
  const [state, setState] = useState('loading');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  useEffect(() => {
    if (!user) {
      setState('login');
      return;
    }
    setState('loading');
    getStudio()
      .then(({ data }) => {
        setStudio(data);
        setTitle(data.title);
        setState('ready');
      })
      .catch((err) => setState(err.status === 404 ? 'new' : (setMessage({ type: 'error', text: err.message }), 'error')));
  }, [user]);

  const run = async (action, success) => {
    setBusy(true);
    setMessage({ type: '', text: '' });
    try {
      const { data } = await action();
      setStudio(data);
      setTitle(data.title);
      setState('ready');
      setMessage({ type: 'done', text: success });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  if (state === 'login') {
    return (
      <main className="empty-stage card">
        <p className="gate-title">Đăng nhập để phát trực tiếp</p>
        <button className="primary" onClick={onLogin}>
          Đăng nhập
        </button>
      </main>
    );
  }

  return (
    <main className="studio">
      <div className="library-head">
        <h1>Studio phát trực tiếp</h1>
        {studio && (
          <a className="secondary" href={href.channel(studio.channelId)}>
            Xem kênh của tôi
          </a>
        )}
      </div>

      {state === 'loading' && <p className="empty">Đang tải...</p>}

      {state === 'new' && (
        <form
          className="card studio-card"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => createChannel(title), 'Đã tạo kênh. Dán địa chỉ và khoá stream vào OBS để bắt đầu phát.');
          }}
        >
          <h2>Tạo kênh của bạn</h2>
          <p className="muted">Mỗi tài khoản có một kênh. Người xem có thể đăng ký kênh và bình luận khi bạn phát.</p>
          <label className="field">
            <span>Tiêu đề buổi phát</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Ví dụ: Học Kubernetes cùng nhau" />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? 'Đang tạo...' : 'Tạo kênh'}
          </button>
        </form>
      )}

      {studio && (
        <div className="studio-grid">
          <section className="card studio-card">
            <h2>Trạng thái</h2>
            {studio.isLive ? (
              <p className="live-badge inline">● Đang phát · {studio.viewerCount} người xem</p>
            ) : (
              <p className="offline-badge inline">Chưa nhận được luồng</p>
            )}
            <p className="muted">{studio.subscriberCount} người đăng ký</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(() => updateStudio(title), 'Đã lưu tiêu đề');
              }}
            >
              <label className="field">
                <span>Tiêu đề buổi phát</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
              </label>
              <button className="primary small" disabled={busy || title === studio.title}>
                Lưu tiêu đề
              </button>
            </form>
          </section>

          <section className="card studio-card">
            <h2>Cài đặt OBS</h2>
            <p className="muted">
              OBS → Settings → Stream → Service: <strong>Custom...</strong>, rồi dán hai giá trị dưới đây. Không chia sẻ khoá
              stream: ai có khoá đều phát được lên kênh của bạn.
            </p>
            <CopyField label="Server" value={studio.ingestEndpoint} />
            <CopyField label="Stream key" value={studio.streamKey} secret />
            <button
              className="secondary small"
              disabled={busy}
              onClick={() =>
                window.confirm('Đổi khoá stream? OBS đang dùng khoá cũ sẽ bị ngắt.') &&
                run(resetStreamKey, 'Đã đổi khoá stream. Cập nhật khoá mới trong OBS.')
              }
            >
              Đổi khoá stream
            </button>
          </section>
        </div>
      )}

      {message.text && <p className={`notice ${message.type}`}>{message.text}</p>}
    </main>
  );
}
