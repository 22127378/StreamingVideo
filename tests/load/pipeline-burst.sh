#!/usr/bin/env bash
# Stress pipeline transcode: tạo N video cùng lúc rồi đo thời gian cho tới khi tất cả READY.
# Quan sát KEDA nâng worker từ 0 lên tối đa 4 pod và Karpenter cấp node Spot.
#
#   BASE_URL=https://dxxxx.cloudfront.net N=10 ./tests/load/pipeline-burst.sh
#
# Biến: N (mặc định 10), VIDEO_FILE (mặc định tự tạo clip 1080p 30s bằng ffmpeg),
#       TIMEOUT_SECONDS (mặc định 1200), CLEANUP (1 = xoá video sau khi xong, mặc định 1)
# Giới hạn: mỗi video tốn 2 request ghi (upload-url, complete), rate limit 30/10 phút/IP/pod,
# nên N tối đa an toàn khoảng 25 với 2 pod API.
# kubectl và aws là tuỳ chọn: có thì in thêm số worker, node Spot và độ dài DLQ.
set -euo pipefail

: "${BASE_URL:?BASE_URL is required}"
API="$BASE_URL/api"
N=${N:-10}
TIMEOUT_SECONDS=${TIMEOUT_SECONDS:-1200}
CLEANUP=${CLEANUP:-1}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if [[ -z ${VIDEO_FILE:-} ]]; then
  source "$(dirname "$0")/../lib.sh"
  FFMPEG=$(find_ffmpeg)
  VIDEO_FILE="$WORK/clip.mp4"
  "$FFMPEG" -loglevel error -y -f lavfi -i testsrc2=size=1920x1080:rate=30 -f lavfi -i sine=frequency=440 \
    -t 30 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$VIDEO_FILE"
fi
SIZE=$(stat -c %s "$VIDEO_FILE")
echo "Video: $VIDEO_FILE ($SIZE bytes), N=$N"

has() { command -v "$1" >/dev/null 2>&1; }
cluster_state() {
  local out=""
  if has kubectl; then
    local w s
    # Worker là KEDA ScaledJob: đếm pod worker đang chạy
    w=$(kubectl -n streamforge get pods -l app=streamforge-worker --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l)
    s=$(kubectl get nodes -l streamforge.io/pool=transcode --no-headers 2>/dev/null | wc -l)
    out="workers=${w:-0} spot_nodes=$s"
  fi
  echo "$out"
}

# 1. Tạo upload và PUT song song
create_one() {
  local i=$1 r id url
  r=$(curl -sf -H 'Content-Type: application/json' -X POST "$API/videos/upload-url" \
    -d "{\"fileName\":\"burst-$i.mp4\",\"contentType\":\"video/mp4\",\"fileSize\":$SIZE,\"title\":\"burst $i\"}") || { echo "upload-url failed for $i" >&2; return; }
  id=$(jq -r .data.videoId <<<"$r"); url=$(jq -r .data.uploadUrl <<<"$r")
  curl -sf -X PUT -H 'Content-Type: video/mp4' --data-binary @"$VIDEO_FILE" "$url" -o /dev/null || { echo "PUT failed for $i" >&2; return; }
  curl -sf -H 'Content-Type: application/json' -X POST "$API/videos/complete" -d "{\"videoId\":\"$id\"}" -o /dev/null || { echo "complete failed for $i" >&2; return; }
  echo "$id" >> "$WORK/ids"
}

START=$(date +%s)
for i in $(seq 1 "$N"); do create_one "$i" & done
wait
touch "$WORK/ids"
QUEUED=$(wc -l < "$WORK/ids")
echo "Queued $QUEUED/$N jobs in $(( $(date +%s) - START ))s"

# 2. Theo dõi tới khi xong
peak_workers=0
while :; do
  ready=0; failed=0; processing=0
  while read -r id; do
    case $(curl -s "$API/videos/$id" | jq -r .data.status) in
      READY) ready=$((ready + 1)) ;;
      FAILED) failed=$((failed + 1)) ;;
      *) processing=$((processing + 1)) ;;
    esac
  done < "$WORK/ids"
  state=$(cluster_state)
  w=$(sed -n 's/.*workers=\([0-9]*\).*/\1/p' <<<"$state"); (( ${w:-0} > peak_workers )) && peak_workers=$w
  printf '[%4ss] ready=%d failed=%d processing=%d %s\n' $(( $(date +%s) - START )) "$ready" "$failed" "$processing" "$state"
  (( processing == 0 )) && break
  (( $(date +%s) - START > TIMEOUT_SECONDS )) && { echo "Timeout after ${TIMEOUT_SECONDS}s"; break; }
  sleep 15
done

TOTAL=$(( $(date +%s) - START ))
echo
echo "Result: $ready READY, $failed FAILED, $processing unfinished of $QUEUED in ${TOTAL}s (peak workers: $peak_workers)"
if has aws; then
  DLQ=$(aws sqs get-queue-url --queue-name streamforge-dev-transcode-dlq --query QueueUrl --output text 2>/dev/null || true)
  [[ -n $DLQ ]] && echo "DLQ messages: $(aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)"
fi

# 3. Dọn dẹp
if [[ $CLEANUP == 1 ]]; then
  while read -r id; do curl -s -o /dev/null -X DELETE "$API/videos/$id"; done < "$WORK/ids"
  echo "Deleted $QUEUED test videos"
fi

(( failed == 0 && processing == 0 ))
