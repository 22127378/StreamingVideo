-- Video và đánh giá. Trước khi tách microservice, hai bảng này nằm ở schema public (API gộp);
-- nếu còn ở đó thì chuyển sang schema catalog (giữ nguyên dữ liệu, index, ràng buộc).
DO $$
BEGIN
  IF to_regclass('public.videos') IS NOT NULL AND to_regclass('catalog.videos') IS NULL THEN
    ALTER TABLE public.videos SET SCHEMA catalog;
  END IF;
  IF to_regclass('public.video_ratings') IS NOT NULL AND to_regclass('catalog.video_ratings') IS NULL THEN
    ALTER TABLE public.video_ratings SET SCHEMA catalog;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS videos (
  video_id           uuid PRIMARY KEY,
  title              text        NOT NULL,
  description        text        NOT NULL DEFAULT '',
  original_file_name text,
  content_type       text        NOT NULL DEFAULT 'video/mp4',
  file_size          bigint      CHECK (file_size IS NULL OR file_size > 0),
  owner_id           text,
  tier               text        NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'premium')),
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
  processed_at       timestamptz,
  view_count         bigint      NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  rating_sum         integer     NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
  rating_count       integer     NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  rating_avg         numeric(3, 2)
    GENERATED ALWAYS AS (CASE WHEN rating_count = 0 THEN 0 ELSE round(rating_sum::numeric / rating_count, 2) END) STORED
);

-- Mỗi người chấm một video một lần; chấm lại thì ghi đè
CREATE TABLE IF NOT EXISTS video_ratings (
  video_id   uuid        NOT NULL REFERENCES videos (video_id) ON DELETE CASCADE,
  user_id    text        NOT NULL,
  stars      smallint    NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, user_id)
);

-- Keyset pagination cho từng kiểu sắp xếp, "video của tôi"
CREATE INDEX IF NOT EXISTS videos_created_idx        ON videos (created_at DESC, video_id DESC);
CREATE INDEX IF NOT EXISTS videos_status_created_idx ON videos (status, created_at DESC, video_id DESC);
CREATE INDEX IF NOT EXISTS videos_owner_created_idx  ON videos (owner_id, created_at DESC, video_id DESC);
CREATE INDEX IF NOT EXISTS videos_status_views_idx   ON videos (status, view_count DESC, created_at DESC, video_id DESC);
CREATE INDEX IF NOT EXISTS videos_status_rating_idx  ON videos (status, rating_avg DESC, created_at DESC, video_id DESC);
