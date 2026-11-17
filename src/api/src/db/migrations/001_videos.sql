-- Metadata video (thay bảng DynamoDB streamforge-<env>-videos)
CREATE TABLE IF NOT EXISTS videos (
  video_id           uuid PRIMARY KEY,
  title              text        NOT NULL,
  description        text        NOT NULL DEFAULT '',
  original_file_name text,
  content_type       text        NOT NULL DEFAULT 'video/mp4',
  file_size          bigint      CHECK (file_size IS NULL OR file_size > 0),
  owner_id           text,
  tier               text        NOT NULL DEFAULT 'free'
                                 CHECK (tier IN ('free', 'premium')),
  status             text        NOT NULL
                                 CHECK (status IN ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'DELETING')),
  raw_s3_key         text        NOT NULL,
  raw_bucket         text        NOT NULL,
  processed_bucket   text        NOT NULL,
  duration           integer,
  qualities          jsonb,
  attempt            integer,
  last_error         text,
  error_message      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);

-- Danh sách mới nhất trước (keyset pagination), theo trạng thái, và "video của tôi"
CREATE INDEX IF NOT EXISTS videos_created_idx       ON videos (created_at DESC, video_id DESC);
CREATE INDEX IF NOT EXISTS videos_status_created_idx ON videos (status, created_at DESC, video_id DESC);
CREATE INDEX IF NOT EXISTS videos_owner_created_idx  ON videos (owner_id, created_at DESC, video_id DESC);
