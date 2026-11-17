#!/usr/bin/env bash
# Tạo và upload COUNT video mẫu ngẫu nhiên (hình sinh bằng ffmpeg, mặc định 10) để trang chính có nội dung khi demo.
# Video được upload qua API như người dùng thật: xin URL, PUT lên S3, gọi /complete, worker transcode.
#
#   BASE_URL=https://dxxxx.cloudfront.net DEMO_EMAIL=<email> [COUNT=10] ./scripts/seed-demo-videos.sh
#
# Mật khẩu đọc từ DEMO_PASSWORD, không có thì hỏi. Tài khoản phải có sẵn trong user pool.
# Sau khi các video READY, chạy SEED_DEMO_STATS=true ./k8s/deploy.sh để thêm lượt xem và đánh giá mẫu.
set -euo pipefail
: "${BASE_URL:?BASE_URL is required}"
: "${DEMO_EMAIL:?DEMO_EMAIL is required}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
API="$BASE_URL/api"
POOL=${COGNITO_USER_POOL_ID:-$(terraform -chdir="$ROOT/terraform/layers/auth" output -raw user_pool_id)}
CLIENT=${COGNITO_CLIENT_ID:-$(terraform -chdir="$ROOT/terraform/layers/auth" output -raw client_id)}
if [[ -z ${DEMO_PASSWORD:-} ]]; then
  read -rsp "Mật khẩu của $DEMO_EMAIL: " DEMO_PASSWORD
  echo
fi

source "$ROOT/tests/lib.sh"
FFMPEG=$(find_ffmpeg)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

TOKEN=$(aws cognito-idp admin-initiate-auth --user-pool-id "$POOL" --client-id "$CLIENT" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters USERNAME="$DEMO_EMAIL",PASSWORD="$DEMO_PASSWORD" \
  --query AuthenticationResult.AccessToken --output text)

# Video được sinh ngẫu nhiên: chọn nguồn hình, kích thước, gói và độ dài. COUNT video (mặc định 10).
COUNT=${COUNT:-10}
SOURCES=(
  "Tập hợp Mandelbrot|mandelbrot"
  "Mandelbrot phóng sâu|mandelbrot=start_scale=2:end_scale=0.01"
  "Trò chơi cuộc sống|life=ratio=0.2:mold=8:death_color=#1a1e27:life_color=#f97316"
  "Life xanh lá|life=ratio=0.1:mold=20:life_color=#34d399:death_color=#0b0d12"
  "Automat tế bào quy tắc 110|cellauto=rule=110"
  "Automat tế bào quy tắc 30|cellauto=rule=30"
  "Automat tế bào quy tắc 90|cellauto=rule=90"
  "Bảng màu SMPTE HD|smptehdbars"
  "Mẫu kiểm tra chuyển động|testsrc2"
)
SIZES=("1920x1080|1080p" "1280x720|720p" "854x480|480p" "1080x1920|dọc")
TIERS=(free free premium)
VIDEOS=()
for _ in $(seq 1 "$COUNT"); do
  IFS='|' read -r name src <<<"${SOURCES[RANDOM % ${#SOURCES[@]}]}"
  IFS='|' read -r size label <<<"${SIZES[RANDOM % ${#SIZES[@]}]}"
  VIDEOS+=("$name $label #$((RANDOM % 900 + 100))|${TIERS[RANDOM % ${#TIERS[@]}]}|$src|$size|$((RANDOM % 11 + 6))")
done

i=0
for entry in "${VIDEOS[@]}"; do
  IFS='|' read -r title tier src size secs <<<"$entry"
  i=$((i + 1))
  file="$WORK/demo-$i.mp4"
  # Nguồn có tham số thì nối thêm bằng ":", chưa có thì bắt đầu bằng "="
  [[ $src == *=* ]] && opts="$src:size=$size:rate=30" || opts="$src=size=$size:rate=30"
  "$FFMPEG" -loglevel error -y -f lavfi -i "$opts" \
    -f lavfi -i "sine=frequency=$((220 + i * 55)):sample_rate=44100" -t "$secs" \
    -vf "scale=$size,format=yuv420p" -c:v libx264 -preset veryfast -c:a aac -shortest "$file"
  bytes=$(stat -c %s "$file")
  body=$(jq -n --arg t "$title" --arg tier "$tier" --argjson n "$bytes" \
    '{fileName: "demo.mp4", contentType: "video/mp4", fileSize: $n, title: $t, tier: $tier}')
  r=$(curl -sf -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$API/videos/upload-url" -d "$body")
  id=$(jq -r .data.videoId <<<"$r")
  curl -sf -X PUT -H 'Content-Type: video/mp4' --data-binary @"$file" "$(jq -r .data.uploadUrl <<<"$r")" >/dev/null
  curl -sf -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$API/videos/complete" \
    -d "{\"videoId\":\"$id\"}" >/dev/null
  echo "queued $id  $tier  $size  $title"
  # Video được tạo cách nhau vài giây để sắp xếp "mới nhất" có thứ tự rõ ràng
  sleep 2
done
