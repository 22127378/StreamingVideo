import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteVideo, listMyVideos } from '../api.js';
import Uploader from '../components/Uploader.jsx';
import VideoList from '../components/VideoList.jsx';

const POLL_MS = 5000;

/** Trang đăng video: form upload và danh sách video mình đã đăng (mọi trạng thái) */
export default function UploadPage({ user, onLogin }) {
  const [videos, setVideos] = useState([]);
  const [nextToken, setNextToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const shown = useRef(0);
  shown.current = videos.length;

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      // Tải lại đủ số video đang hiển thị để trạng thái được cập nhật
      const page = await listMyVideos({ limit: Math.min(100, Math.max(24, shown.current)) });
      setVideos(page.data);
      setNextToken(page.nextToken);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Có video đang upload, xử lý hoặc xoá thì cập nhật mỗi 5 giây
  const busy = videos.some((v) => ['PROCESSING', 'UPLOADING', 'DELETING'].includes(v.status));
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const loadMore = async () => {
    setLoading(true);
    try {
      const page = await listMyVideos({ nextToken });
      setVideos((prev) => [...prev, ...page.data.filter((v) => !prev.some((p) => p.videoId === v.videoId))]);
      setNextToken(page.nextToken);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const remove = async (video) => {
    if (!window.confirm(`Xoá "${video.title}"? File gốc và file HLS sẽ bị xoá.`)) return;
    try {
      await deleteVideo(video.videoId);
      await refresh();
    } catch (err) {
      window.alert(err.message);
    }
  };

  if (!user) {
    return (
      <main className="page">
        <div className="card empty-stage">
          <p>Đăng nhập để đăng video và xem các video bạn đã đăng.</p>
          <button className="primary" onClick={onLogin}>
            Đăng nhập
          </button>
        </div>
      </main>
    );
  }

  const counts = videos.reduce((acc, v) => ({ ...acc, [v.status]: (acc[v.status] || 0) + 1 }), {});

  return (
    <main className="upload-layout">
      <section>
        <Uploader onUploaded={refresh} />
        <p className="muted small-print">
          Video gắn nhãn Premium chỉ người dùng Premium xem được. Bạn luôn xem được video của chính mình.
        </p>
      </section>

      <section className="library">
        <div className="library-head">
          <h2>Video của tôi</h2>
          <span className="muted">
            {videos.length} video
            {counts.PROCESSING ? ` · ${counts.PROCESSING} đang xử lý` : ''}
            {counts.FAILED ? ` · ${counts.FAILED} lỗi` : ''}
          </span>
          <button className="secondary small" onClick={refresh}>
            Làm mới
          </button>
        </div>
        {error && <p className="notice error">Không tải được danh sách: {error}</p>}
        <VideoList
          videos={videos}
          onDelete={remove}
          canDelete={() => true}
          onLoadMore={loadMore}
          hasMore={Boolean(nextToken)}
          loading={loading}
          emptyText="Bạn chưa đăng video nào."
        />
      </section>
    </main>
  );
}
