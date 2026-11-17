const STATUS_LABEL = {
  UPLOADING: 'Chờ upload',
  PROCESSING: 'Đang xử lý',
  READY: 'Sẵn sàng',
  FAILED: 'Lỗi',
  DELETING: 'Đang xoá',
};

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export default function VideoList({ videos, selectedId, onSelect, onDelete, canDelete, onLoadMore, hasMore, loading }) {
  if (!loading && videos.length === 0) {
    return <p className="empty">Chưa có video nào. Upload video đầu tiên ở bên trái.</p>;
  }

  return (
    <>
      <ul className="video-grid">
        {videos.map((v) => {
          const ready = v.status === 'READY';
          return (
            <li key={v.videoId} className={`video-card ${selectedId === v.videoId ? 'selected' : ''}`}>
              <button
                className="thumb"
                disabled={!ready}
                onClick={() => onSelect(v)}
                aria-label={ready ? `Xem ${v.title}` : v.title}
              >
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
              </button>
              <div className="meta">
                <p className="title" title={v.title}>
                  {v.title}
                </p>
                <p className="sub">
                  <span className={`status ${v.status.toLowerCase()}`}>{STATUS_LABEL[v.status] || v.status}</span>
                  {v.qualities?.length ? <span>{v.qualities.map((q) => q.resolution).join(' · ')}</span> : null}
                </p>
                {v.status === 'FAILED' && v.errorMessage && <p className="error-text">{v.errorMessage}</p>}
              </div>
              {canDelete(v) && (
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
