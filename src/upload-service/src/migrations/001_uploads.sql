-- Phiên upload: từ lúc cấp URL tới khi người dùng xác nhận đã upload xong.
-- Chỉ upload-service đọc/ghi bảng này. Thông tin hiển thị của video nằm ở catalog (nhận qua sự kiện).
CREATE TABLE IF NOT EXISTS uploads (
  video_id           uuid PRIMARY KEY,
  owner_id           text        NOT NULL,
  title              text        NOT NULL,
  description        text        NOT NULL DEFAULT '',
  tier               text        NOT NULL CHECK (tier IN ('free', 'premium')),
  original_file_name text        NOT NULL,
  content_type       text        NOT NULL,
  file_size          bigint      NOT NULL CHECK (file_size > 0),
  raw_bucket         text        NOT NULL,
  raw_s3_key         text        NOT NULL,
  processed_bucket   text        NOT NULL,
  status             text        NOT NULL DEFAULT 'UPLOADING' CHECK (status IN ('UPLOADING', 'COMPLETED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);

CREATE INDEX IF NOT EXISTS uploads_owner_created_idx ON uploads (owner_id, created_at DESC);
