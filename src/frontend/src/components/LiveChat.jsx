import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteMessage, listMessages, sendMessage } from '../api.js';

const POLL_MS = 2000;
const MAX_KEPT = 200;

const timeOf = (iso) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

/**
 * Bình luận trực tiếp. Hỏi live-service mỗi 2 giây các bình luận mới (after = id cuối đã có);
 * tab bị ẩn thì tạm dừng. Mỗi bình luận có huy hiệu Chủ kênh / Người đăng ký.
 */
export default function LiveChat({ channelId, user, isOwner, onLogin }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const lastId = useRef(undefined);
  const listRef = useRef(null);
  const stickToBottom = useRef(true);

  const merge = useCallback((incoming) => {
    if (!incoming.length) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.messageId));
      const next = [...prev, ...incoming.filter((m) => !seen.has(m.messageId))];
      return next.slice(-MAX_KEPT);
    });
    lastId.current = Math.max(lastId.current ?? 0, ...incoming.map((m) => m.messageId));
  }, []);

  useEffect(() => {
    setMessages([]);
    lastId.current = undefined;
    let stopped = false;
    let timer;

    const poll = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        try {
          const { data } = await listMessages(channelId, lastId.current);
          if (!stopped) merge(data);
        } catch {
          /* mạng chập chờn: lần sau hỏi lại */
        }
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [channelId, merge]);

  // Tự cuộn xuống khi có bình luận mới, trừ khi người dùng đang cuộn lên đọc bình luận cũ
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = listRef.current;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const submit = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setError('');
    try {
      const { data } = await sendMessage(channelId, body);
      setText('');
      stickToBottom.current = true;
      merge([data]);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const remove = async (messageId) => {
    try {
      await deleteMessage(channelId, messageId);
      setMessages((prev) => prev.filter((m) => m.messageId !== messageId));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="card live-chat" aria-label="Bình luận trực tiếp">
      <h2>Bình luận trực tiếp</h2>
      <ol className="chat-list" ref={listRef} onScroll={onScroll} aria-live="polite">
        {messages.length === 0 && <li className="chat-empty">Chưa có bình luận. Hãy là người đầu tiên!</li>}
        {messages.map((m) => (
          <li key={m.messageId} className="chat-message">
            <span className="chat-time">{timeOf(m.createdAt)}</span>
            <span className={`chat-name${m.owner ? ' owner' : m.subscriber ? ' subscriber' : ''}`}>{m.userName}</span>
            {m.owner && <span className="chat-badge owner">Chủ kênh</span>}
            {!m.owner && m.subscriber && (
              <span className="chat-badge subscriber" title="Đã đăng ký kênh">
                Người đăng ký
              </span>
            )}
            <span className="chat-body">{m.body}</span>
            {(isOwner || user?.admin) && (
              <button className="chat-delete" onClick={() => remove(m.messageId)} aria-label="Xoá bình luận">
                ×
              </button>
            )}
          </li>
        ))}
      </ol>

      {user ? (
        <form className="chat-form" onSubmit={submit}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={300}
            placeholder="Nhập bình luận..."
            aria-label="Bình luận"
            disabled={sending}
          />
          <button className="primary small" disabled={sending || !text.trim()}>
            Gửi
          </button>
        </form>
      ) : (
        <div className="chat-form">
          <span className="muted">Đăng nhập để bình luận</span>
          <button className="primary small" onClick={onLogin}>
            Đăng nhập
          </button>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
