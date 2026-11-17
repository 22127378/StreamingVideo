-- Lượt xem và đánh giá (1-5 sao) cho trang chính: lọc theo gói, sắp xếp theo thời gian, lượt xem, điểm.
-- rating_sum/rating_count được cập nhật cùng transaction với video_ratings (videoRepository.rateVideo),
-- rating_avg là cột sinh sẵn để sắp xếp và đánh index được.
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS view_count   bigint  NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  ADD COLUMN IF NOT EXISTS rating_sum   integer NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
  ADD COLUMN IF NOT EXISTS rating_count integer NOT NULL DEFAULT 0 CHECK (rating_count >= 0);

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS rating_avg numeric(3, 2)
    GENERATED ALWAYS AS (CASE WHEN rating_count = 0 THEN 0 ELSE round(rating_sum::numeric / rating_count, 2) END) STORED;

-- Mỗi người chấm một video một lần; chấm lại thì ghi đè
CREATE TABLE IF NOT EXISTS video_ratings (
  video_id   uuid        NOT NULL REFERENCES videos (video_id) ON DELETE CASCADE,
  user_id    text        NOT NULL,
  stars      smallint    NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, user_id)
);

-- Trang chính chỉ hiện video READY: index theo từng kiểu sắp xếp, kèm khoá phụ cho keyset pagination
CREATE INDEX IF NOT EXISTS videos_status_views_idx  ON videos (status, view_count DESC, created_at DESC, video_id DESC);
CREATE INDEX IF NOT EXISTS videos_status_rating_idx ON videos (status, rating_avg DESC, created_at DESC, video_id DESC);
