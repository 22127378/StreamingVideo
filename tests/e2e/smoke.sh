#!/usr/bin/env bash
# Smoke test end-to-end qua CloudFront: đăng nhập (Cognito), upload, transcode, khoá Premium bằng
# signed cookies, giới hạn 720p cho gói Free, quyền chủ video, lượt xem, đánh giá, xoá và xoá cache.
#
#   BASE_URL=https://dxxxx.cloudfront.net ./tests/e2e/smoke.sh [video.mp4]
#
# Cần AWS CLI có quyền admin trên user pool: script tạo 3 người dùng tạm (2 free, 1 premium) bằng
# admin API, lấy token qua ADMIN_USER_PASSWORD_AUTH và xoá họ khi kết thúc.
# COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID mặc định lấy từ terraform/layers/auth.
# Không truyền file thì tự tạo clip dọc 6 giây. KEEP=1 để giữ video sau khi test.
set -uo pipefail

: "${BASE_URL:?BASE_URL is required}"
API="$BASE_URL/api"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
POOL=${COGNITO_USER_POOL_ID:-$(terraform -chdir="$ROOT/terraform/layers/auth" output -raw user_pool_id)}
CLIENT=${COGNITO_CLIENT_ID:-$(terraform -chdir="$ROOT/terraform/layers/auth" output -raw client_id)}
RUN=$(date +%s)
FREE_USER="smoke-free-$RUN@example.com"
PREMIUM_USER="smoke-premium-$RUN@example.com"
OTHER_USER="smoke-other-$RUN@example.com"
PASSWORD="Smoke-$(openssl rand -hex 8)a1"

cleanup() {
  for u in "$FREE_USER" "$PREMIUM_USER" "$OTHER_USER"; do
    aws cognito-idp admin-delete-user --user-pool-id "$POOL" --username "$u" >/dev/null 2>&1
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

FILE=${1:-}
if [[ -z $FILE ]]; then
  source "$ROOT/tests/lib.sh"
  FFMPEG=$(find_ffmpeg) || exit 1
  FILE="$WORK/portrait.mp4"
  "$FFMPEG" -loglevel error -y -f lavfi -i testsrc=size=1080x1920:rate=30 -f lavfi -i sine \
    -t 6 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$FILE" || exit 1
fi
SIZE=$(stat -c %s "$FILE")

pass=0; fail=0
expect() { # name expected actual
  if [[ $2 == "$3" ]]; then echo "PASS  $1"; pass=$((pass + 1)); else echo "FAIL  $1 (expected $2, got $3)"; fail=$((fail + 1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
auth() { echo "Authorization: Bearer $1"; }

create_user() { # email -> access token
  aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$1" --message-action SUPPRESS \
    --user-attributes Name=email,Value="$1" Name=email_verified,Value=true >/dev/null
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$1" --password "$PASSWORD" --permanent
}
login() { # email -> access token (có group mới nhất)
  aws cognito-idp admin-initiate-auth --user-pool-id "$POOL" --client-id "$CLIENT" \
    --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters USERNAME="$1",PASSWORD="$PASSWORD" \
    --query AuthenticationResult.AccessToken --output text
}

# ---------- Trang và đăng nhập
expect "frontend loads" true "$(curl -s "$BASE_URL/" | grep -q '<div id="root">' && echo true || echo false)"
expect "auth mode is cognito" cognito "$(curl -s "$API/auth/config" | jq -r .data.mode)"
create_user "$FREE_USER"; create_user "$PREMIUM_USER"; create_user "$OTHER_USER"
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$PREMIUM_USER" --group-name premium
FREE=$(login "$FREE_USER"); PREMIUM=$(login "$PREMIUM_USER"); OTHER=$(login "$OTHER_USER")
expect "/auth/me free" free "$(curl -s -H "$(auth "$FREE")" "$API/auth/me" | jq -r .data.tier)"
expect "/auth/me premium" premium "$(curl -s -H "$(auth "$PREMIUM")" "$API/auth/me" | jq -r .data.tier)"

# ---------- Upload (video Premium do người dùng free upload)
expect "GET /api/videos is public" 200 "$(code "$API/videos")"
expect "upload-url without login" 401 "$(code -H 'Content-Type: application/json' -X POST "$API/videos/upload-url" -d '{}')"
expect "upload-url without fileSize" 400 \
  "$(code -H "$(auth "$FREE")" -H 'Content-Type: application/json' -X POST "$API/videos/upload-url" -d '{"fileName":"a.mp4","contentType":"video/mp4"}')"
R=$(curl -s -H "$(auth "$FREE")" -H 'Content-Type: application/json' -X POST "$API/videos/upload-url" \
  -d "{\"fileName\":\"smoke.mp4\",\"contentType\":\"video/mp4\",\"fileSize\":$SIZE,\"title\":\"smoke test\",\"tier\":\"premium\"}")
ID=$(jq -r .data.videoId <<<"$R"); URL=$(jq -r .data.uploadUrl <<<"$R")
expect "upload-url returns a videoId" true "$([[ $ID =~ ^[0-9a-f-]{36}$ ]] && echo true || echo false)"
complete() { code -H "$(auth "$1")" -H 'Content-Type: application/json' -X POST "$API/videos/complete" -d "{\"videoId\":\"$ID\"}"; }
expect "complete before upload" 400 "$(complete "$FREE")"
head -c $((SIZE + 1000)) /dev/urandom > "$WORK/bigger.bin"
expect "PUT larger than declared size is rejected by S3" 403 "$(code -X PUT -H 'Content-Type: video/mp4' --data-binary @"$WORK/bigger.bin" "$URL")"
expect "PUT declared file" 200 "$(code -X PUT -H 'Content-Type: video/mp4' --data-binary @"$FILE" "$URL")"
expect "complete by another user" 403 "$(complete "$PREMIUM")"
expect "complete by owner" 200 "$(complete "$FREE")"
expect "complete again" 409 "$(complete "$FREE")"
expect "DELETE while PROCESSING" 409 "$(code -H "$(auth "$FREE")" -X DELETE "$API/videos/$ID")"

START=$(date +%s)
for _ in $(seq 1 120); do
  S=$(curl -s "$API/videos/$ID" | jq -r .data.status)
  [[ $S == READY || $S == FAILED ]] && break
  sleep 5
done
expect "transcode finishes READY (took $(( $(date +%s) - START ))s)" READY "$S"

# ---------- Khoá Premium bằng signed cookies
MASTER=$(curl -s "$API/videos/$ID" | jq -r .data.streamingUrl)
THUMB=$(curl -s "$API/videos/$ID" | jq -r .data.thumbnailUrl)
expect "thumbnail is public" 200 "$(code "$THUMB")"
expect "HLS without signed cookies" 403 "$(code "$MASTER")"
expect "playback without login" 401 "$(code -X POST "$API/videos/$ID/playback")"
expect "free user denied premium video" 403 "$(code -H "$(auth "$OTHER")" -X POST "$API/videos/$ID/playback")"
expect "my videos needs login" 401 "$(code "$API/videos/mine")"
expect "my videos lists the upload" true \
  "$(curl -s -H "$(auth "$FREE")" "$API/videos/mine" | jq --arg id "$ID" '[.data[].videoId] | index($id) != null')"

# Chủ video ở gói Free: xem được video Premium của mình, nhưng chỉ tới 720p
OWNER_JAR="$WORK/owner-cookies.txt"
P=$(curl -s -c "$OWNER_JAR" -H "$(auth "$FREE")" -X POST "$API/videos/$ID/playback")
expect "free owner watches own premium video" true "$(jq -r '.success' <<<"$P")"
expect "free owner gets the 720p master" "${MASTER%/*}/sd/master.m3u8" "$(jq -r .data.streamingUrl <<<"$P")"
expect "free owner sees 1080p as locked" '["1080p"]' "$(jq -c .data.lockedQualities <<<"$P")"
expect "views counted" 1 "$(jq -r .data.viewCount <<<"$P")"
expect "free master has no 1080p" false "$(curl -s -b "$OWNER_JAR" "${MASTER%/*}/sd/master.m3u8" | grep -q 1080p && echo true || echo false)"
SD_VARIANT=$(curl -s -b "$OWNER_JAR" "${MASTER%/*}/sd/master.m3u8" | grep -m1 '\.m3u8$')
SD_SEGMENT=$(curl -s -b "$OWNER_JAR" "${MASTER%/*}/sd/$SD_VARIANT" | grep -m1 '\.ts$')
expect "free cookies: 720p segment" 200 "$(code -b "$OWNER_JAR" "${MASTER%/*}/sd/$SD_SEGMENT")"
expect "free cookies: 1080p playlist blocked by CloudFront" 403 "$(code -b "$OWNER_JAR" "${MASTER%/*}/hd/1080p.m3u8")"
expect "free cookies: 1080p segment blocked by CloudFront" 403 "$(code -b "$OWNER_JAR" "${MASTER%/*}/hd/1080p_000.ts")"
expect "free cookies: full master blocked" 403 "$(code -b "$OWNER_JAR" "$MASTER")"

JAR="$WORK/cookies.txt"
expect "premium user gets playback" 200 "$(code -c "$JAR" -H "$(auth "$PREMIUM")" -X POST "$API/videos/$ID/playback")"
expect "3 CloudFront cookies set" 3 "$(grep -c 'CloudFront-' "$JAR")"
expect "cookies scoped to this video" true "$(grep 'CloudFront-Policy' "$JAR" | grep -q "/videos/$ID/" && echo true || echo false)"
expect "master.m3u8 with cookies" 200 "$(code -b "$JAR" "$MASTER")"
VARIANT=$(curl -s -b "$JAR" "$MASTER" | grep -m1 '\.m3u8$')
expect "variant playlist with cookies" 200 "$(code -b "$JAR" "${MASTER%/*}/$VARIANT")"
SEGMENT="${VARIANT%/*}/$(curl -s -b "$JAR" "${MASTER%/*}/$VARIANT" | grep -m1 '\.ts$')"  # segment nằm cạnh playlist (hd/ hoặc sd/)
expect "segment with cookies" 200 "$(code -b "$JAR" "${MASTER%/*}/$SEGMENT")"
expect "premium cookies: 1080p segment" 200 "$(code -b "$JAR" "${MASTER%/*}/hd/1080p_000.ts")"
expect "portrait aspect kept (720p is 720x1280)" true \
  "$(curl -s -b "$JAR" "$MASTER" | grep -q 'RESOLUTION=720x1280' && echo true || echo false)"
TAMPERED="$WORK/tampered.txt"
sed 's/\(CloudFront-Signature\t\)\(.\)/\1X/' "$JAR" > "$TAMPERED"
expect "tampered signature rejected" 403 "$(code -b "$TAMPERED" "${MASTER%/*}/$SEGMENT")"

# ---------- Đánh giá và danh sách
rate() { curl -s -H "$(auth "$1")" -H 'Content-Type: application/json' -X PUT "$API/videos/$ID/rating" -d "{\"stars\":$2}"; }
expect "premium user rates 5" '{"ratingAvg":5,"ratingCount":1,"myRating":5}' "$(rate "$PREMIUM" 5 | jq -c .data)"
expect "owner rates 4, average 4.5" '{"ratingAvg":4.5,"ratingCount":2,"myRating":4}' "$(rate "$FREE" 4 | jq -c .data)"
expect "rating out of range" 400 "$(code -H "$(auth "$PREMIUM")" -H 'Content-Type: application/json' -X PUT "$API/videos/$ID/rating" -d '{"stars":9}')"
expect "user without access cannot rate" 403 "$(code -H "$(auth "$OTHER")" -H 'Content-Type: application/json' -X PUT "$API/videos/$ID/rating" -d '{"stars":1}')"
expect "list filtered by tier and sorted by rating" true \
  "$(curl -s "$API/videos?status=READY&tier=premium&sort=rating&limit=100" | jq --arg id "$ID" '[.data[] | select(.tier != "premium")] == [] and ([.data[].videoId] | index($id) != null)')"

expect "upgrade free user" premium "$(curl -s -H "$(auth "$FREE")" -X POST "$API/auth/upgrade" | jq -r .data.tier)"
FREE=$(login "$FREE_USER")
expect "upgraded user gets the full master" "$MASTER" \
  "$(curl -s -H "$(auth "$FREE")" -X POST "$API/videos/$ID/playback" | jq -r .data.streamingUrl)"

# ---------- Xoá
if [[ ${KEEP:-0} != 1 ]]; then
  expect "DELETE by another user" 403 "$(code -H "$(auth "$PREMIUM")" -X DELETE "$API/videos/$ID")"
  expect "DELETE by owner" 200 "$(code -H "$(auth "$FREE")" -X DELETE "$API/videos/$ID")"
  expect "GET deleted video" 404 "$(code "$API/videos/$ID")"
  # Cookie vẫn hợp lệ: chỉ còn cache CloudFront có thể trả segment. API invalidate khi xoá.
  gone=false
  for _ in $(seq 1 36); do
    c=$(code -b "$JAR" "${MASTER%/*}/$SEGMENT")
    if [[ $c == 403 || $c == 404 ]]; then gone=true; break; fi
    sleep 5
  done
  expect "deleted video no longer served, even with cookies" true "$gone"
fi

echo
echo "$pass passed, $fail failed"
(( fail == 0 ))
