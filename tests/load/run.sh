#!/usr/bin/env bash
# Chạy một script k6 bằng Docker (không cần cài k6).
#   BASE_URL=https://dxxxx.cloudfront.net SCENARIO=stress ./tests/load/run.sh api.js
# Mọi biến môi trường dạng KEY=value đã liệt kê dưới đây được truyền vào k6.
set -euo pipefail

K6_IMAGE=grafana/k6:2.3.0
SCRIPT=${1:?usage: run.sh <script.js>}
DIR=$(cd "$(dirname "$0")" && pwd)
: "${BASE_URL:?BASE_URL is required, for example https://dxxxx.cloudfront.net}"

mkdir -p "$DIR/results"
STAMP=$(date +%Y%m%d-%H%M%S)
NAME="${SCRIPT%.js}-${SCENARIO:-default}-$STAMP"

# k6 chỉ thấy biến truyền bằng cờ -e của chính nó (không đọc env của container)
env_args=()
for var in BASE_URL SCENARIO VIEWERS DURATION RENDITION REQUESTS LIMIT PODS LIST_P95 DETAIL_P95 SEGMENT_P95 PLAYLIST_P95; do
  if [[ -n ${!var:-} ]]; then env_args+=(-e "$var=${!var}"); fi
done

docker run --rm -i --user "$(id -u):$(id -g)" \
  -v "$DIR:/scripts" -w /scripts \
  "$K6_IMAGE" run "${env_args[@]}" --summary-export "results/$NAME.json" "$SCRIPT"

echo "Summary saved to tests/load/results/$NAME.json"
