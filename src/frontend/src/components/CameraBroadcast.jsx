import { useEffect, useRef, useState } from 'react';

// Phát trực tiếp từ camera và micro của trình duyệt lên Amazon IVS bằng Web Broadcast SDK (WebRTC).
// SDK nhận luôn địa chỉ rtmps://... của Studio và tự đổi sang endpoint WebRTC. Kênh StreamForge là
// loại BASIC (IVS_CHANNEL_TYPE của live-service) nên dùng cấu hình BASIC_LANDSCAPE.
// SDK chỉ được tải (import động) khi bấm bật camera, các trang khác không phải tải thêm.

const VIDEO = 'camera';
const AUDIO = 'mic';

/** Lỗi của trình duyệt và SDK sang câu dễ hiểu */
function describe(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Trình duyệt đã chặn quyền camera hoặc micro. Bấm biểu tượng ổ khoá trên thanh địa chỉ để cho phép, rồi thử lại.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Không tìm thấy camera hoặc micro.';
    case 'NotReadableError':
      return 'Camera hoặc micro đang được ứng dụng khác dùng (ví dụ OBS, Zoom). Tắt ứng dụng đó rồi thử lại.';
    case 'InvalidStreamKey':
      return 'Khoá stream không hợp lệ. Tải lại trang để lấy khoá mới.';
    default:
      return err?.message || 'Không phát được.';
  }
}

async function openMedia(cameraId, micId) {
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: cameraId ? { exact: cameraId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: { deviceId: micId ? { exact: micId } : undefined },
  });
}

export default function CameraBroadcast({ ingestEndpoint, streamKey, onLiveChange }) {
  const canvasRef = useRef(null);
  const clientRef = useRef(null);
  const mediaRef = useRef(null);
  // idle: camera tắt; opening: đang xin quyền; preview: thấy hình, chưa phát; connecting; live
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [cameras, setCameras] = useState([]);
  const [mics, setMics] = useState([]);
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');

  const stopMedia = () => {
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
  };

  const release = () => {
    const client = clientRef.current;
    clientRef.current = null;
    if (client) {
      try {
        client.stopBroadcast();
      } catch {
        /* chưa phát */
      }
      try {
        client.detachPreview();
        client.delete();
      } catch {
        /* đã huỷ */
      }
    }
    stopMedia();
  };

  // Rời trang Studio thì tắt camera và ngừng phát
  useEffect(() => release, []);

  /** Gắn camera và micro đang chọn vào client (thay thiết bị cũ nếu có) */
  const attach = async (client, cam, mic) => {
    const media = await openMedia(cam, mic);
    if (client.getVideoInputDevice(VIDEO)) client.removeVideoInputDevice(VIDEO);
    if (client.getAudioInputDevice(AUDIO)) client.removeAudioInputDevice(AUDIO);
    stopMedia();
    mediaRef.current = media;
    await client.addVideoInputDevice(new MediaStream(media.getVideoTracks()), VIDEO, { index: 0 });
    await client.addAudioInputDevice(new MediaStream(media.getAudioTracks()), AUDIO);
  };

  const openCamera = async () => {
    setError('');
    setPhase('opening');
    try {
      const { default: IVS } = await import('amazon-ivs-web-broadcast');
      if (!IVS.isSupported()) {
        throw new Error('Trình duyệt này không hỗ trợ phát trực tiếp. Hãy dùng Chrome, Edge, Firefox hoặc Safari bản mới.');
      }
      const client = IVS.create({ streamConfig: IVS.BASIC_LANDSCAPE, ingestEndpoint });
      clientRef.current = client;
      client.on(IVS.BroadcastClientEvents.ACTIVE_STATE_CHANGE, (active) => {
        setPhase(active ? 'live' : 'preview');
        onLiveChange?.(active);
      });
      client.on(IVS.BroadcastClientEvents.ERROR, (err) => setError(describe(err)));
      client.attachPreview(canvasRef.current);
      await attach(client, cameraId, micId);
      // Chỉ sau khi có quyền, trình duyệt mới cho biết tên thiết bị
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(devices.filter((d) => d.kind === 'videoinput'));
      setMics(devices.filter((d) => d.kind === 'audioinput'));
      const [video] = mediaRef.current.getVideoTracks();
      const [audio] = mediaRef.current.getAudioTracks();
      setCameraId(video?.getSettings().deviceId || '');
      setMicId(audio?.getSettings().deviceId || '');
      setPhase('preview');
    } catch (err) {
      release();
      setPhase('idle');
      setError(describe(err));
    }
  };

  const switchDevice = async (cam, mic) => {
    setCameraId(cam);
    setMicId(mic);
    if (!clientRef.current) return;
    try {
      await attach(clientRef.current, cam, mic);
    } catch (err) {
      setError(describe(err));
    }
  };

  const start = async () => {
    setError('');
    setPhase('connecting');
    try {
      await clientRef.current.startBroadcast(streamKey);
      setPhase('live');
    } catch (err) {
      setPhase('preview');
      setError(describe(err));
    }
  };

  const stop = () => {
    clientRef.current?.stopBroadcast();
    setPhase('preview');
  };

  const closeCamera = () => {
    const wasLive = phase === 'live';
    release();
    setPhase('idle');
    if (wasLive) onLiveChange?.(false);
  };

  const on = phase !== 'idle' && phase !== 'opening';

  return (
    <section className="card studio-card camera-card">
      <div className="camera-head">
        <h2>Phát bằng camera</h2>
        {phase === 'live' && <span className="live-badge inline">● Đang phát</span>}
        {phase === 'connecting' && <span className="muted">Đang kết nối...</span>}
      </div>
      <p className="muted">
        Phát thẳng từ camera và micro của máy tính, không cần cài OBS. Không phát cùng lúc từ OBS và trình duyệt vì cả
        hai dùng chung một khoá stream.
      </p>

      <div className={`camera-preview ${on ? '' : 'off'}`}>
        <canvas ref={canvasRef} aria-label="Hình xem trước từ camera" />
        {!on && <p className="muted">{phase === 'opening' ? 'Đang mở camera...' : 'Camera đang tắt'}</p>}
      </div>

      {on && (cameras.length > 0 || mics.length > 0) && (
        <div className="selects">
          <label>
            <span>Camera</span>
            <select value={cameraId} onChange={(e) => switchDevice(e.target.value, micId)}>
              {cameras.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Micro</span>
            <select value={micId} onChange={(e) => switchDevice(cameraId, e.target.value)}>
              {mics.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Micro ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="camera-actions">
        {!on && (
          <button className="primary" onClick={openCamera} disabled={phase === 'opening'}>
            Bật camera
          </button>
        )}
        {phase === 'preview' && (
          <button className="primary" onClick={start}>
            Bắt đầu phát
          </button>
        )}
        {(phase === 'live' || phase === 'connecting') && (
          <button className="danger" onClick={stop}>
            Dừng phát
          </button>
        )}
        {on && (
          <button className="secondary" onClick={closeCamera}>
            Tắt camera
          </button>
        )}
      </div>

      {error && <p className="notice error">{error}</p>}
    </section>
  );
}
