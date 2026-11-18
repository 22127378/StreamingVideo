-- Kênh phát trực tiếp: mỗi người dùng tối đa một kênh
CREATE TABLE IF NOT EXISTS channels (
  channel_id          uuid PRIMARY KEY,
  owner_id            text        NOT NULL UNIQUE,
  owner_name          text        NOT NULL,
  title               text        NOT NULL DEFAULT '',
  provider            text        NOT NULL CHECK (provider IN ('ivs', 'local')),
  -- ARN kênh IVS, hoặc đường dẫn MediaMTX (live/<channel_id>)
  provider_channel_id text        NOT NULL UNIQUE,
  ingest_endpoint     text        NOT NULL,
  playback_url        text        NOT NULL,
  -- ARN khoá stream trên IVS (không lưu khoá), hoặc chính khoá khi chạy local
  stream_key_ref      text        NOT NULL,
  subscriber_count    integer     NOT NULL DEFAULT 0 CHECK (subscriber_count >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Người đăng ký kênh
CREATE TABLE IF NOT EXISTS subscriptions (
  channel_id uuid        NOT NULL REFERENCES channels (channel_id) ON DELETE CASCADE,
  user_id    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);

-- Bình luận trong phòng live. Huy hiệu "người đăng ký" tính lúc đọc (JOIN subscriptions),
-- nên huỷ đăng ký thì huy hiệu cũng mất.
CREATE TABLE IF NOT EXISTS chat_messages (
  message_id bigserial PRIMARY KEY,
  channel_id uuid        NOT NULL REFERENCES channels (channel_id) ON DELETE CASCADE,
  user_id    text        NOT NULL,
  user_name  text        NOT NULL,
  body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_channel_idx ON chat_messages (channel_id, message_id);
CREATE INDEX IF NOT EXISTS chat_messages_created_idx ON chat_messages (created_at);
