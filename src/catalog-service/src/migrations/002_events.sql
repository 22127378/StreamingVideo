-- Catalog dựng dữ liệu từ sự kiện của service khác (EventBridge -> SQS). SQS có thể giao một sự kiện
-- nhiều lần, nên ghi lại id sự kiện đã xử lý (cùng transaction với thay đổi) để không xử lý hai lần.
CREATE TABLE IF NOT EXISTS processed_events (
  event_id     text PRIMARY KEY,
  event_type   text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processed_events_time_idx ON processed_events (processed_at);

-- Video đã xoá. Sự kiện đến muộn (ví dụ TranscodeCompleted sau khi xoá) không tạo lại video "ma".
CREATE TABLE IF NOT EXISTS deleted_videos (
  video_id   uuid PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
