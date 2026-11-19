#!/usr/bin/env bash
# Đo cold start của worker transcode: từ lúc upload xong tới lúc Job chạy và video sẵn sàng.
#
#   BASE_URL=https://dxxxx.cloudfront.net ./tests/load/worker-coldstart.sh warm
#   BASE_URL=https://dxxxx.cloudfront.net ./tests/load/worker-coldstart.sh cold
#
# warm: pod giữ chỗ đang chạy (máy Spot và image worker có sẵn), như trong giờ hoạt động.
# cold: tạm dừng pod giữ chỗ (annotation paused-replicas của KEDA), chờ Karpenter trả hết máy Spot,
#       rồi upload: Job phải chờ thuê máy mới và kéo image FFmpeg. Bỏ annotation khi xong.
#
# Mốc thời gian lấy từ Kubernetes (tạo Job, xếp pod, container chạy/kết thúc) nên chính xác tới giây;
# thời điểm video READY lấy bằng cách hỏi API mỗi giây. Cần kubectl, aws (admin user pool), jq, python3.
set -euo pipefail

MODE=${1:?usage: worker-coldstart.sh warm|cold}
: "${BASE_URL:?BASE_URL is required}"
API="$BASE_URL/api"
NS=streamforge
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
POOL=${COGNITO_USER_POOL_ID:-$(terraform -chdir="$ROOT/terraform/layers/auth" output -raw user_pool_id)}
CLIENT=${COGNITO_CLIENT_ID:-$(terraform -chdir="$ROOT/terraform/layers/auth" output -raw client_id)}
USER_EMAIL="coldstart-$(date +%s)@example.com"
PASSWORD="Cold-$(openssl rand -hex 8)a1"
VIDEO_ID=""
now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

cleanup() {
  [[ -n $VIDEO_ID && -n ${TOKEN:-} ]] && curl -s -o /dev/null -H "Authorization: Bearer $TOKEN" -X DELETE "$API/videos/$VIDEO_ID" || true
  aws cognito-idp admin-delete-user --user-pool-id "$POOL" --username "$USER_EMAIL" >/dev/null 2>&1 || true
  if [[ $MODE == cold ]]; then
    kubectl -n "$NS" annotate scaledobject streamforge-transcode-placeholder autoscaling.keda.sh/paused-replicas- >/dev/null 2>&1 || true
    log "placeholder resumed"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

spot_nodes() { kubectl get nodes -l streamforge.io/pool=transcode --no-headers 2>/dev/null | wc -l; }
placeholder_ready() { kubectl -n "$NS" get deploy streamforge-transcode-placeholder -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true; }

# 1. Chuẩn bị trạng thái cụm
if [[ $MODE == cold ]]; then
  log "pausing placeholder, waiting for Karpenter to remove every Spot node"
  kubectl -n "$NS" annotate scaledobject streamforge-transcode-placeholder autoscaling.keda.sh/paused-replicas=0 --overwrite >/dev/null
  for _ in $(seq 1 90); do [[ $(spot_nodes) == 0 ]] && break; sleep 10; done
  [[ $(spot_nodes) == 0 ]] || { log "Spot nodes still present after 15 minutes"; exit 1; }
else
  log "waiting for the placeholder pod (warm Spot node)"
  for _ in $(seq 1 60); do [[ $(placeholder_ready) == 1 ]] && break; sleep 10; done
  [[ $(placeholder_ready) == 1 ]] || { log "placeholder not ready"; exit 1; }
fi
log "state: spot_nodes=$(spot_nodes) placeholder_ready=$(placeholder_ready || echo 0)"

# 2. Người dùng tạm và clip 1080p 10 giây
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$USER_EMAIL" --message-action SUPPRESS \
  --user-attributes Name=email,Value="$USER_EMAIL" Name=email_verified,Value=true >/dev/null
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$USER_EMAIL" --password "$PASSWORD" --permanent
TOKEN=$(aws cognito-idp admin-initiate-auth --user-pool-id "$POOL" --client-id "$CLIENT" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters USERNAME="$USER_EMAIL",PASSWORD="$PASSWORD" \
  --query AuthenticationResult.AccessToken --output text)
AUTH="Authorization: Bearer $TOKEN"
source "$ROOT/tests/lib.sh"
FFMPEG=$(find_ffmpeg)
FILE="$WORK/clip.mp4"
"$FFMPEG" -loglevel error -y -f lavfi -i testsrc2=size=1920x1080:rate=30 -f lavfi -i sine=frequency=440 \
  -t 10 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$FILE"
SIZE=$(stat -c %s "$FILE")

# 3. Upload, rồi đánh dấu thời điểm xác nhận upload (lúc này video vào hàng đợi transcode)
R=$(curl -sf -H "$AUTH" -H 'Content-Type: application/json' -X POST "$API/uploads" \
  -d "{\"fileName\":\"coldstart.mp4\",\"contentType\":\"video/mp4\",\"fileSize\":$SIZE,\"title\":\"cold start $MODE\"}")
VIDEO_ID=$(jq -r .data.videoId <<<"$R")
curl -sf -X PUT -H 'Content-Type: video/mp4' --data-binary @"$FILE" "$(jq -r .data.uploadUrl <<<"$R")" -o /dev/null
T_COMPLETE=$(now)
curl -sf -H "$AUTH" -X POST "$API/uploads/$VIDEO_ID/complete" -o /dev/null
log "upload confirmed at $T_COMPLETE (video $VIDEO_ID, $SIZE bytes)"

# 4. Chờ READY, hỏi mỗi giây
T_READY=""
for _ in $(seq 1 900); do
  status=$(curl -s -H "$AUTH" "$API/videos/$VIDEO_ID" | jq -r '.data.status // empty')
  if [[ $status == READY || $status == FAILED ]]; then T_READY=$(now); break; fi
  sleep 1
done
log "video status $status at ${T_READY:-timeout}"

# 5. Mốc của Job vừa chạy (lấy ngay, trước khi Karpenter trả máy và pod bị dọn)
JOB=$(kubectl -n "$NS" get jobs -l app=streamforge-worker --sort-by=.metadata.creationTimestamp -o json |
  jq -r --arg t "$T_COMPLETE" '[.items[] | select(.metadata.creationTimestamp >= ($t | sub("\\.[0-9]+Z$"; "Z")))] | first | .metadata.name // empty')
python3 "$ROOT/tests/load/coldstart_report.py" --since "${T_COMPLETE%.*}Z" --pods "${JOB:-streamforge-worker}"
python3 - "$T_COMPLETE" "$T_READY" "$JOB" "$MODE" <<'PY'
import json, subprocess, sys
from datetime import datetime
t_complete, t_ready, job, mode = sys.argv[1:5]
p = lambda v: datetime.fromisoformat(v.replace('Z', '+00:00')) if v else None
d = lambda a, b: f"{(b - a).total_seconds():.1f}s" if a and b else '-'
if not job:
    print('no worker job found'); sys.exit(0)
j = json.loads(subprocess.check_output(['kubectl', '-n', 'streamforge', 'get', 'job', job, '-o', 'json']))
pods = json.loads(subprocess.check_output(['kubectl', '-n', 'streamforge', 'get', 'pods', '-l', f'job-name={job}', '-o', 'json']))['items']
created = p(j['metadata']['creationTimestamp'])
st = (pods[0]['status'].get('containerStatuses') or [{}])[0].get('state', {}) if pods else {}
run = st.get('running') or st.get('terminated') or {}
started, finished = p(run.get('startedAt')), p((st.get('terminated') or {}).get('finishedAt'))
tc, tr = p(t_complete), p(t_ready)
print(f"\nTóm tắt ({mode})")
print(f"  xác nhận upload -> KEDA tạo Job      : {d(tc, created)}")
print(f"  Job tạo -> container worker chạy      : {d(created, started)}")
print(f"  xác nhận upload -> worker bắt đầu     : {d(tc, started)}   <- cold start người dùng chịu")
print(f"  worker chạy -> kết thúc (transcode)   : {d(started, finished)}")
print(f"  xác nhận upload -> video READY (API)  : {d(tc, tr)}")
PY
