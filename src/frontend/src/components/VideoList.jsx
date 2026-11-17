import { href } from '../router.js';
import { RatingBadge } from './Stars.jsx';

const STATUS_LABEL = {
  UPLOADING: 'Chờ upload',
  PROCESSING: 'Đang xử lý',
  READY: 'Sẵn sàng',
  FAILED: 'Lỗi',
  DELETING: 'Đang xoá',
};

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export function formatViews(n = 0) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')} Tr lượt xem`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')} N lượt xem`;
  return `${n} lượt xem`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const steps = [
    [60, 'giây'],
    [60, 'phút'],
    [24, 'giờ'],
    [30, 'ngày'],
    [12, 'tháng'],
  ];
  let value = s;
  for (const [size, unit] of steps) {
    if (value < size) return `${Math.floor(value)} ${unit} trước`;
    value /= size;
  }
  return `${Math.floor(value)} năm trước`;
}

/**
 * Lưới video. Video READY là link sang trang xem; video chưa sẵn sàng hiện trạng thái
 * (chỉ có ở trang "Video của tôi", vì trang chính chỉ lấy video READY).
 */
export default function VideoList({ videos, selectedId, onDelete, canDelete, onLoadMore, hasMore, loading, emptyText }) {
  if (!loading && videos.length === 0) {
    return <p className="empty">{emptyText || 'Không có video nào.'}</p>;
  }

  return (
    <>
      <ul className="video-grid">
        {videos.map((v) => {
          const ready = v.status === 'READY';
          const thumb = (
            <>
              {ready && v.thumbnailUrl ? (
                <img src={v.thumbnailUrl} alt="" loading="lazy" />
              ) : (
                <span className={`placeholder ${v.status.toLowerCase()}`}>
                  {v.status === 'PROCESSING' && <span className="spinner" aria-hidden="true" />}
                  {STATUS_LABEL[v.status] || v.status}
                </span>
              )}
              {ready && v.duration ? <span className="duration">{formatDuration(v.duration)}</span> : null}
              {v.tier === 'premium' && <span className="tier-badge">Premium</span>}
            </>
          );
          return (
            <li key={v.videoId} className={`video-card ${selectedId === v.videoId ? 'selected' : ''}`}>
              {ready ? (
                <a className="thumb" href={href.watch(v.videoId)} aria-label={`Xem ${v.title}`}>
                  {thumb}
                </a>
              ) : (
                <div className="thumb">{thumb}</div>
              )}
              <div className="meta">
                <p className="title" title={v.title}>
                  {ready ? <a href={href.watch(v.videoId)}>{v.title}</a> : v.title}
                </p>
                {ready ? (
                  <p className="sub">
                    <span>{formatViews(v.viewCount)}</span>
                    <span>{timeAgo(v.createdAt)}</span>
                    <RatingBadge avg={v.ratingAvg || 0} count={v.ratingCount || 0} />
                  </p>
                ) : (
                  <p className="sub">
                    <span className={`status ${v.status.toLowerCase()}`}>{STATUS_LABEL[v.status] || v.status}</span>
                    <span>{timeAgo(v.createdAt)}</span>
                  </p>
                )}
                {v.status === 'FAILED' && v.errorMessage && <p className="error-text">{v.errorMessage}</p>}
              </div>
              {canDelete?.(v) && (
                <button
                  className="icon-button"
                  onClick={() => onDelete(v)}
                  disabled={v.status === 'PROCESSING' || v.status === 'DELETING'}
                  title={v.status === 'PROCESSING' ? 'Không xoá được khi đang xử lý' : 'Xoá video'}
                  aria-label={`Xoá ${v.title}`}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                    <path
                      d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <button className="secondary load-more" onClick={onLoadMore} disabled={loading}>
          {loading ? 'Đang tải...' : 'Xem thêm'}
        </button>
      )}
    </>
  );
}
