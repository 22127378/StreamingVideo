#!/usr/bin/env bash
# Build image, đẩy lên ECR, chuẩn bị cụm EKS và sinh cấu hình GitOps cho StreamForge.
#
# Yêu cầu: các layer Terraform đã apply; aws, docker, kubectl, helm, jq.
# Chạy lại an toàn: image đã có trên ECR thì bỏ qua build.
#
# Script làm phần "bootstrap" trực tiếp trên cụm (NodePool, KEDA, namespace, secret), rồi ghi
# k8s/gitops/dev (tag image, cấu hình) để commit. Từ đó:
#   - Có ArgoCD (k8s/argocd/install.sh): commit + push k8s/gitops/dev, ArgoCD tự đồng bộ.
#   - Chưa có ArgoCD (lần đầu): script tự chạy migration và apply thư mục đó.
#
#   ./k8s/deploy.sh                # build + chuẩn bị + ghi k8s/gitops/dev
#   SKIP_BUILD=1 ./k8s/deploy.sh   # giữ tag image hiện tại, chỉ cập nhật cấu hình
#   DIRECT_APPLY=1 ./k8s/deploy.sh # apply thẳng kể cả khi đã có ArgoCD (ArgoCD selfHeal sẽ đưa về Git)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TF="$ROOT/terraform/layers"
REGION=${AWS_REGION:-us-east-1}
KEDA_VERSION=2.20.2
# Worker scale về 0. Pod giữ chỗ (k8s/app/base/transcode-placeholder.yaml) giữ sẵn node Spot và image
# trong khung giờ cron dưới đây (giờ Việt Nam) để video đầu tiên không chịu cold start.
# Mỗi replica giữ 1 node, khoảng $0.03/giờ Spot; PLACEHOLDER_REPLICAS=0 để tắt hẳn.
PLACEHOLDER_REPLICAS=${PLACEHOLDER_REPLICAS:-1}
PLACEHOLDER_START=${PLACEHOLDER_START:-0 8 * * *}
PLACEHOLDER_END=${PLACEHOLDER_END:-0 0 * * *}
# Thư mục ArgoCD đồng bộ (commit vào Git)
GITOPS="$ROOT/k8s/gitops/dev"

tf_out() { terraform -chdir="$TF/$1" output -raw "$2"; }
log() { printf '\n==> %s\n' "$*"; }

log "Reading Terraform outputs"
CLUSTER=$(tf_out compute cluster_name)
ECR_JSON=$(terraform -chdir="$TF/compute" output -json ecr_repository_urls)
# Mỗi service một image: 5 service HTTP và transcode worker
SERVICES=(account upload catalog playback live)
repo_of() { jq -r --arg k "$1" '.[$k]' <<<"$ECR_JSON"; }
WORKER_REPO=$(repo_of worker)
ALB_SG=$(tf_out compute alb_security_group_id)
RAW_BUCKET=$(tf_out storage raw_bucket)
PROCESSED_BUCKET=$(tf_out storage processed_bucket)
DB_HOST=$(tf_out database endpoint)
DB_NAME=$(tf_out database database)
DB_MASTER_SECRET_ARN=$(tf_out database master_secret_arn)
QUEUE_URL=$(tf_out messaging transcode_queue_url)
# Sự kiện giữa các service (layer services)
EVENT_BUS_NAME=$(tf_out services event_bus_name)
CATALOG_EVENTS_QUEUE_URL=$(tf_out services catalog_events_queue_url)
# Trước khi có layer delivery thì chưa có CloudFront; link phát chưa dùng được nhưng API vẫn chạy
CDN_BASE_URL=$(tf_out delivery cdn_base_url 2>/dev/null || echo "https://cdn-not-configured.invalid")
CLOUDFRONT_DISTRIBUTION_ID=$(tf_out delivery distribution_id 2>/dev/null || echo "")
CLOUDFRONT_KEY_PAIR_ID=$(tf_out delivery playback_key_pair_id 2>/dev/null || echo "")
# Layer auth (Cognito). Chưa apply thì API không khởi động được ở production, nên dừng sớm.
COGNITO_USER_POOL_ID=$(tf_out auth user_pool_id 2>/dev/null || echo "")
COGNITO_CLIENT_ID=$(tf_out auth client_id 2>/dev/null || echo "")
COGNITO_DOMAIN=$(tf_out auth domain 2>/dev/null || echo "")
if [[ -z $COGNITO_USER_POOL_ID ]]; then
  echo "terraform/layers/auth has no outputs yet: apply it before deploying the API" >&2
  exit 1
fi

# Tag theo commit; working tree có thay đổi chưa commit thì thêm hậu tố (ECR tag là immutable)
TAG=${IMAGE_TAG:-$(git -C "$ROOT" rev-parse --short HEAD)}
if [[ -z ${IMAGE_TAG:-} && -n $(git -C "$ROOT" status --porcelain -- src docker) ]]; then
  TAG="$TAG-dirty-$(date +%s)"
fi
echo "cluster=$CLUSTER tag=$TAG cdn=$CDN_BASE_URL"

if [[ -z ${SKIP_BUILD:-} ]]; then
  log "Building and pushing images"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${WORKER_REPO%%/*}"
  build_push() { # repo dockerfile [build args...]; context là src/ (để copy src/shared)
    local repo=$1 dockerfile=$2 name=${1##*/}
    shift 2
    if aws ecr describe-images --region "$REGION" --repository-name "$name" --image-ids imageTag="$TAG" >/dev/null 2>&1; then
      echo "$repo:$TAG already in ECR, skipping build"
      return
    fi
    docker build --platform linux/amd64 -f "$ROOT/$dockerfile" "$@" -t "$repo:$TAG" "$ROOT/src"
    docker push "$repo:$TAG"
  }
  for svc in "${SERVICES[@]}"; do
    build_push "$(repo_of "$svc")" docker/service.Dockerfile --build-arg "SERVICE=$svc-service"
  done
  build_push "$WORKER_REPO" docker/worker.Dockerfile
else
  # Giữ tag đang ghi trong k8s/gitops/dev
  TAG=$(awk '/name: streamforge-catalog/{f=1} f && /newTag:/{print $2; exit}' "$GITOPS/kustomization.yaml")
  echo "SKIP_BUILD: keeping image tag $TAG"
fi

log "Configuring kubectl"
env -u AWS_PROFILE -u AWS_CONFIG_FILE aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" >/dev/null

log "Cluster resources (NodePools, IngressClass)"
kubectl apply -f "$ROOT/k8s/cluster/"

log "KEDA $KEDA_VERSION"
# helm upgrade --wait mất vài phút kể cả khi không đổi gì, nên bỏ qua nếu đã đúng phiên bản.
# FORCE_KEDA=1 để cài lại, ví dụ khi đổi các --set bên dưới.
installed_keda=$(helm -n keda list --filter '^keda$' --deployed -o json 2>/dev/null | jq -r '.[0].chart // empty')
if [[ "$installed_keda" == "keda-$KEDA_VERSION" && -z "${FORCE_KEDA:-}" ]]; then
  echo "keda-$KEDA_VERSION already deployed, skipping (FORCE_KEDA=1 to reinstall)"
else
  helm repo add kedacore https://kedacore.github.io/charts >/dev/null 2>&1 || true
  helm repo update kedacore >/dev/null
  helm upgrade --install keda kedacore/keda --version "$KEDA_VERSION" \
    --namespace keda --create-namespace --wait --timeout 10m \
    --set podIdentity.aws.irsa.enabled=false \
    --set prometheus.operator.enabled=true
fi

log "Namespace and secrets"
kubectl apply -f "$ROOT/k8s/app/base/namespace.yaml"
if ! kubectl -n streamforge get secret streamforge-secrets >/dev/null 2>&1; then
  kubectl -n streamforge create secret generic streamforge-secrets \
    --from-literal=JWT_SECRET="$(openssl rand -hex 32)"
fi
# Private key ký CloudFront signed cookies (từ state Terraform của layer delivery), cập nhật mỗi lần deploy
if [[ -n $CLOUDFRONT_KEY_PAIR_ID ]]; then
  terraform -chdir="$TF/delivery" output -raw playback_private_key_pem |
    kubectl -n streamforge create secret generic streamforge-cloudfront \
      --from-file=private_key=/dev/stdin --dry-run=client -o yaml |
    kubectl apply -f - >/dev/null
fi

log "Writing $GITOPS"
mkdir -p "$GITOPS"
cat > "$GITOPS/config.env" <<EOF
NODE_ENV=production
AWS_REGION=$REGION
S3_RAW_UPLOADS_BUCKET=$RAW_BUCKET
S3_PROCESSED_BUCKET=$PROCESSED_BUCKET
SQS_TRANSCODE_QUEUE_URL=$QUEUE_URL
DB_HOST=$DB_HOST
DB_PORT=5432
DB_NAME=$DB_NAME
DB_IAM_AUTH=true
DB_SSL=true
CDN_BASE_URL=$CDN_BASE_URL
CLOUDFRONT_DISTRIBUTION_ID=$CLOUDFRONT_DISTRIBUTION_ID
CLOUDFRONT_KEY_PAIR_ID=$CLOUDFRONT_KEY_PAIR_ID
COGNITO_USER_POOL_ID=$COGNITO_USER_POOL_ID
COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID
COGNITO_DOMAIN=$COGNITO_DOMAIN
EVENT_BUS_NAME=$EVENT_BUS_NAME
CATALOG_EVENTS_QUEUE_URL=$CATALOG_EVENTS_QUEUE_URL
LIVE_NAME_PREFIX=${CLUSTER}
LOG_FORMAT=json
EOF
# SEED_DEMO_STATS=true ./k8s/deploy.sh: thêm lượt xem và đánh giá mẫu cho video READY chưa có số liệu
printf 'DB_MASTER_SECRET_ARN=%s\nSEED_DEMO_STATS=%s\n' \
  "$DB_MASTER_SECRET_ARN" "${SEED_DEMO_STATS:-false}" > "$GITOPS/migrate.env"
images_yaml=""
for svc in "${SERVICES[@]}" worker; do
  images_yaml+="  - name: streamforge-$svc
    newName: $(repo_of "$svc")
    newTag: $TAG
"
done
cat > "$GITOPS/kustomization.yaml" <<EOF
# Sinh bởi k8s/deploy.sh. ArgoCD (k8s/argocd/application.yaml) đồng bộ thư mục này lên cụm.
# Các giá trị là định danh tài nguyên AWS, không phải bí mật; secret được tạo ngoài Git.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../app/base
  - ../../db
configurations:
  - kustomizeconfig.yaml
images:
${images_yaml}generatorOptions:
  annotations:
    argocd.argoproj.io/sync-wave: "-2"
configMapGenerator:
  - name: streamforge-config
    namespace: streamforge
    envs:
      - config.env
  - name: streamforge-db-migrate
    namespace: streamforge
    envs:
      - migrate.env
patches:
  - target:
      kind: Ingress
      name: streamforge-api
    patch: |-
      - op: add
        path: /metadata/annotations/alb.ingress.kubernetes.io~1security-groups
        value: $ALB_SG
  - target:
      kind: ScaledJob
      name: streamforge-worker
    patch: |-
      - op: replace
        path: /spec/triggers/0/metadata/queueURL
        value: $QUEUE_URL
  - target:
      kind: ScaledObject
      name: streamforge-transcode-placeholder
    patch: |-
      - op: replace
        path: /spec/triggers/0/metadata/start
        value: "$PLACEHOLDER_START"
      - op: replace
        path: /spec/triggers/0/metadata/end
        value: "$PLACEHOLDER_END"
      - op: replace
        path: /spec/triggers/0/metadata/desiredReplicas
        value: "$PLACEHOLDER_REPLICAS"
  - target:
      kind: Namespace
      name: streamforge
    patch: |-
      - op: add
        path: /metadata/annotations
        value:
          argocd.argoproj.io/sync-wave: "-3"
  - target:
      kind: ServiceAccount
      name: streamforge-db-migrator
    patch: |-
      - op: add
        path: /metadata/annotations
        value:
          argocd.argoproj.io/sync-wave: "-2"
  # Migration (catalog, upload) là hook Sync: chạy lại ở mỗi lần đồng bộ, xong thì ArgoCD mới rollout app
  - target:
      kind: Job
      labelSelector: app=streamforge-migrate
    patch: |-
      - op: add
        path: /metadata/annotations
        value:
          argocd.argoproj.io/hook: Sync
          argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
          argocd.argoproj.io/sync-wave: "-1"
EOF
kubectl kustomize "$GITOPS" >/dev/null

if kubectl -n argocd get application streamforge >/dev/null 2>&1 && [[ -z ${DIRECT_APPLY:-} ]]; then
  log "ArgoCD manages the app"
  git -C "$ROOT" status --short -- k8s/gitops/dev
  echo "Commit and push k8s/gitops/dev; ArgoCD syncs within ~3 minutes (migration runs first)."
  echo "Status: kubectl -n argocd get application streamforge"
  exit 0
fi

log "Applying $GITOPS directly (no ArgoCD yet)"
MIGRATE_JOBS=(streamforge-migrate-catalog streamforge-migrate-upload streamforge-migrate-live)
# Job không sửa được sau khi tạo: xoá bản cũ rồi apply lại (migration chạy lại an toàn)
kubectl -n streamforge delete job "${MIGRATE_JOBS[@]}" streamforge-db-migrate --ignore-not-found >/dev/null
kubectl apply -k "$GITOPS"
# Chờ từng Job xong hoặc thất bại (kubectl wait chỉ chờ được một điều kiện, lỗi thì phải đợi hết timeout)
for job in "${MIGRATE_JOBS[@]}"; do
  state=""
  for _ in $(seq 1 120); do
    state=$(kubectl -n streamforge get job "$job" -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type}{" "}{end}')
    [[ $state == *Complete* || $state == *Failed* ]] && break
    sleep 5
  done
  kubectl -n streamforge logs "job/$job" --tail=20 || true
  if [[ $state != *Complete* ]]; then
    echo "Migration $job failed (${state:-timeout})" >&2
    exit 1
  fi
done
# Gỡ phần của kiến trúc cũ nếu còn: API gộp (nay là 4 service), worker Deployment + ScaledObject (nay là ScaledJob)
kubectl -n streamforge delete deployment streamforge-api streamforge-worker --ignore-not-found
kubectl -n streamforge delete service,poddisruptionbudget,serviceaccount streamforge-api --ignore-not-found
kubectl -n streamforge delete scaledobject streamforge-worker --ignore-not-found
for svc in "${SERVICES[@]}"; do
  kubectl -n streamforge rollout status "deploy/streamforge-$svc" --timeout=10m
done

log "Waiting for the API load balancer"
for _ in $(seq 1 60); do
  ALB=$(kubectl -n streamforge get ingress streamforge-api -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
  [[ -n $ALB ]] && break
  sleep 10
done
echo "ALB: ${ALB:-<not ready yet>}"
echo "Next (first deploy only): terraform -chdir=$TF/delivery apply -var api_alb_dns_name=$ALB"
echo "then: SKIP_BUILD=1 $0   to point CDN_BASE_URL at CloudFront, and src/frontend/deploy.sh for the site"
