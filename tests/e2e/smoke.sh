#!/usr/bin/env bash
# Smoke test end-to-end qua CloudFront: upload, transcode, phát HLS, quyền xem, xoá.
#   BASE_URL=https://dxxxx.cloudfront.net ./tests/e2e/smoke.sh [video.mp4]
# Không truyền file thì tự tạo clip dọc 6 giây bằng ffmpeg. KEEP=1 để giữ lại video sau khi test.
set -uo pipefail

: "${BASE_URL:?BASE_URL is required}"
API="$BASE_URL/api"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
FILE=${1:-}
if [[ -z $FILE ]]; then
  source "$(dirname "$0")/../lib.sh"
  FFMPEG=$(find_ffmpeg) || exit 1
  FILE="$WORK/portrait.mp4"
  "$FFMPEG" -loglevel error -y -f lavfi -i testsrc=size=1080x1920:rate=30 -f lavfi -i sine \
    -t 6 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$FILE" || { echo "need ffmpeg or a video file" >&2; exit 1; }
fi
SIZE=$(stat -c %s "$FILE")

pass=0; fail=0
expect() { # name expected actual
  if [[ $2 == "$3" ]]; then echo "PASS  $1"; pass=$((pass + 1)); else echo "FAIL  $1 (expected $2, got $3)"; fail=$((fail + 1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

expect "frontend loads" true "$(curl -s "$BASE_URL/" | grep -q '<div id="root">' && echo true || echo false)"
expect "GET /api/videos" 200 "$(code "$API/videos")"
expect "upload-url without fileSize is rejected" 400 \
  "$(code -H 'Content-Type: application/json' -X POST "$API/videos/upload-url" -d '{"fileName":"a.mp4","contentType":"video/mp4"}')"

R=$(curl -s -H 'Content-Type: application/json' -X POST "$API/videos/upload-url" \
  -d "{\"fileName\":\"smoke.mp4\",\"contentType\":\"video/mp4\",\"fileSize\":$SIZE,\"title\":\"smoke test\"}")
ID=$(jq -r .data.videoId <<<"$R"); URL=$(jq -r .data.uploadUrl <<<"$R")
expect "upload-url returns a videoId" true "$([[ $ID =~ ^[0-9a-f-]{36}$ ]] && echo true || echo false)"

expect "complete before upload" 400 "$(code -H 'Content-Type: application/json' -X POST "$API/videos/complete" -d "{\"videoId\":\"$ID\"}")"
head -c $((SIZE + 1000)) /dev/urandom > "$WORK/bigger.bin"
expect "PUT larger than declared size is rejected by S3" 403 "$(code -X PUT -H 'Content-Type: video/mp4' --data-binary @"$WORK/bigger.bin" "$URL")"
expect "PUT declared file" 200 "$(code -X PUT -H 'Content-Type: video/mp4' --data-binary @"$FILE" "$URL")"
expect "complete" 200 "$(code -H 'Content-Type: application/json' -X POST "$API/videos/complete" -d "{\"videoId\":\"$ID\"}")"
expect "complete again" 409 "$(code -H 'Content-Type: application/json' -X POST "$API/videos/complete" -d "{\"videoId\":\"$ID\"}")"
expect "DELETE while PROCESSING" 409 "$(code -X DELETE "$API/videos/$ID")"

START=$(date +%s)
for _ in $(seq 1 120); do
  S=$(curl -s "$API/videos/$ID" | jq -r .data.status)
  [[ $S == READY || $S == FAILED ]] && break
  sleep 5
done
expect "transcode finishes READY (took $(( $(date +%s) - START ))s)" READY "$S"

MASTER=$(curl -s "$API/videos/$ID" | jq -r .data.streamingUrl)
expect "master.m3u8 via CloudFront" 200 "$(code "$MASTER")"
VARIANT=$(curl -s "$MASTER" | grep -m1 '\.m3u8$')
expect "variant playlist via CloudFront" 200 "$(code "${MASTER%/*}/$VARIANT")"
SEGMENT=$(curl -s "${MASTER%/*}/$VARIANT" | grep -m1 '\.ts$')
expect "segment via CloudFront" 200 "$(code "${MASTER%/*}/$SEGMENT")"
expect "portrait aspect kept (720p is 720x1280)" true \
  "$(curl -s "$MASTER" | grep -q 'RESOLUTION=720x1280' && echo true || echo false)"

TOKEN=$(curl -s -H 'Content-Type: application/json' -X POST "$API/auth/playback-token" -d "{\"videoId\":\"$ID\"}" | jq -r .data.token)
expect "verify-playback with scoped token" 200 \
  "$(code -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -X POST "$API/auth/verify-playback" -d "{\"videoId\":\"$ID\"}")"
expect "verify-playback without token" 401 \
  "$(code -H 'Content-Type: application/json' -X POST "$API/auth/verify-playback" -d "{\"videoId\":\"$ID\"}")"

if [[ ${KEEP:-0} != 1 ]]; then
  expect "DELETE READY video" 200 "$(code -X DELETE "$API/videos/$ID")"
  expect "GET deleted video" 404 "$(code "$API/videos/$ID")"
  # API invalidate cache CloudFront khi xoá. Invalidation thường xong trong 1-5 phút
  # (đã đo được hơn 3 phút với PriceClass_200), nên chờ tối đa 6 phút.
  gone=false
  for _ in $(seq 1 72); do
    c=$(code "${MASTER%/*}/$SEGMENT")
    if [[ $c == 403 || $c == 404 ]]; then gone=true; break; fi
    sleep 5
  done
  expect "deleted video no longer served by CloudFront" true "$gone"
fi

echo
echo "$pass passed, $fail failed"
(( fail == 0 ))
