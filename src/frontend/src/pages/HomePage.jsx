import { useCallback, useEffect, useState } from 'react';
import { listVideos } from '../api.js';
import VideoList from '../components/VideoList.jsx';

const PAGE_SIZE = 12;

const TIERS = [
  { value: '', label: 'Tất cả' },
  { value: 'free', label: 'Free' },
  { value: 'premium', label: 'Premium' },
];

const SORTS = [
  { value: 'newest', label: 'Mới nhất' },
  { value: 'oldest', label: 'Cũ nhất' },
  { value: 'views', label: 'Xem nhiều nhất' },
  { value: 'rating', label: 'Đánh giá cao nhất' },
];

const PERIODS = [
  { value: '', label: 'Mọi lúc' },
  { value: 'day', label: '24 giờ qua' },
  { value: 'week', label: '7 ngày qua' },
  { value: 'month', label: '30 ngày qua' },
  { value: 'year', label: '1 năm qua' },
];

const FILTER_KEY = 'sf-home-filters';

function savedFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY));
    if (saved && typeof saved === 'object') return { tier: '', sort: 'newest', period: '', ...saved };
  } catch {
    /* bỏ qua */
  }
  return { tier: '', sort: 'newest', period: '' };
}

/** Trang chính: chỉ video đã sẵn sàng trong database, lọc theo gói, sắp xếp, khoảng thời gian */
export default function HomePage() {
  const [filters, setFilters] = useState(savedFilters);
  const [videos, setVideos] = useState([]);
  const [nextToken, setNextToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(
    async (token) => {
      setLoading(true);
      try {
        const page = await listVideos({
          limit: PAGE_SIZE,
          status: 'READY',
          tier: filters.tier,
          sort: filters.sort,
          period: filters.period,
          nextToken: token,
        });
        setVideos((prev) => (token ? [...prev, ...page.data] : page.data));
        setNextToken(page.nextToken);
        setError('');
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [filters]
  );

  useEffect(() => {
    load(undefined);
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch {
      /* bỏ qua */
    }
  }, [load, filters]);

  const set = (key) => (value) => setFilters((f) => ({ ...f, [key]: value }));

  return (
    <main className="page">
      <div className="page-head">
        <h1>Khám phá video</h1>
        <p className="muted">Video Premium cần gói Premium để xem. Gói Free xem tối đa 720p.</p>
      </div>

      <div className="filter-bar">
        <div className="chips" role="radiogroup" aria-label="Gói">
          {TIERS.map((t) => (
            <button
              key={t.value}
              role="radio"
              aria-checked={filters.tier === t.value}
              className={`chip ${filters.tier === t.value ? 'active' : ''} ${t.value}`}
              onClick={() => set('tier')(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="selects">
          <label>
            <span>Sắp xếp</span>
            <select value={filters.sort} onChange={(e) => set('sort')(e.target.value)}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Đăng trong</span>
            <select value={filters.period} onChange={(e) => set('period')(e.target.value)}>
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && <p className="notice error">Không tải được danh sách: {error}</p>}
      <VideoList
        videos={videos}
        onLoadMore={() => load(nextToken)}
        hasMore={Boolean(nextToken)}
        loading={loading}
        emptyText="Không có video nào khớp bộ lọc."
      />
    </main>
  );
}
