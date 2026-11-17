import { useState } from 'react';

const STAR_PATH = 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z';

/** Hiển thị điểm trung bình (chỉ đọc), ví dụ 4.3 ★ (12) */
export function RatingBadge({ avg, count }) {
  if (!count) return <span className="rating-badge muted">Chưa có đánh giá</span>;
  return (
    <span className="rating-badge" title={`${avg.toFixed(2)} / 5 từ ${count} lượt đánh giá`}>
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
        <path d={STAR_PATH} fill="currentColor" />
      </svg>
      {avg.toFixed(1)} <span className="muted">({count})</span>
    </span>
  );
}

/** Chọn 1-5 sao. value: số sao đã chấm (hoặc null). */
export function StarInput({ value, onRate, disabled }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value || 0;
  return (
    <div className="star-input" role="radiogroup" aria-label="Đánh giá video" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} sao`}
          className={n <= shown ? 'on' : ''}
          disabled={disabled}
          onMouseEnter={() => setHover(n)}
          onClick={() => onRate(n)}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d={STAR_PATH} />
          </svg>
        </button>
      ))}
    </div>
  );
}
