import { useRef, useState } from 'react';
import { completeUpload, requestUpload, uploadToS3 } from '../api.js';

const MAX_BYTES = 2 * 1024 ** 3; // khớp MAX_UPLOAD_BYTES mặc định của API

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/**
 * Upload 3 bước: xin presigned URL từ API, PUT thẳng file lên S3 (có thanh tiến trình),
 * rồi báo API để đưa job transcode vào hàng đợi.
 */
export default function Uploader({ onUploaded }) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [tier, setTier] = useState('free');
  const [phase, setPhase] = useState('idle'); // idle | uploading | done | error
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);

  const pick = (f) => {
    if (!f) return;
    if (!f.type.startsWith('video/')) {
      setPhase('error');
      setMessage(`${f.name} không phải file video`);
      return;
    }
    if (f.size > MAX_BYTES) {
      setPhase('error');
      setMessage(`File ${formatBytes(f.size)} vượt giới hạn ${formatBytes(MAX_BYTES)}`);
      return;
    }
    setFile(f);
    setTitle(f.name.replace(/\.[^.]+$/, ''));
    setPhase('idle');
    setMessage('');
    setProgress(0);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file || phase === 'uploading') return;
    setPhase('uploading');
    setProgress(0);
    try {
      setMessage('Đang xin URL upload...');
      const { data } = await requestUpload({ file, title, tier });
      setMessage('Đang upload lên S3...');
      await uploadToS3(data.uploadUrl, file, setProgress);
      setMessage('Đang đưa vào hàng đợi transcode...');
      await completeUpload(data.videoId);
      setPhase('done');
      setMessage('Đã upload. Video sẽ sẵn sàng sau khi transcode xong.');
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      onUploaded?.(data.videoId);
    } catch (err) {
      setPhase('error');
      setMessage(
        err.status === 429
          ? 'Bạn upload quá nhiều, thử lại sau ít phút.'
          : err.status === 401
            ? 'Phiên đăng nhập hết hạn, hãy đăng nhập lại.'
            : err.message
      );
    }
  };

  return (
    <form className="card uploader" onSubmit={submit}>
      <h2>Upload video</h2>
      <label
        className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
      >
        <input ref={inputRef} type="file" accept="video/*" onChange={(e) => pick(e.target.files[0])} />
        {file ? (
          <span>
            <strong>{file.name}</strong>
            <small>{formatBytes(file.size)}</small>
          </span>
        ) : (
          <span>
            Kéo thả video vào đây hoặc <u>chọn file</u>
            <small>Tối đa {formatBytes(MAX_BYTES)}, dài tối đa 30 phút</small>
          </span>
        )}
      </label>

      <div className="fields">
        <label>
          Tiêu đề
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Tên video" />
        </label>
        <label>
          Gói
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="free">Free</option>
            <option value="premium">Premium</option>
          </select>
        </label>
      </div>

      {phase === 'uploading' && (
        <div className="progress" aria-label="Tiến trình upload">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
          <span>{Math.round(progress * 100)}%</span>
        </div>
      )}
      {message && <p className={`notice ${phase}`}>{message}</p>}

      <button type="submit" className="primary" disabled={!file || phase === 'uploading'}>
        {phase === 'uploading' ? 'Đang upload...' : 'Upload'}
      </button>
    </form>
  );
}
