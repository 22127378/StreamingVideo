#!/usr/bin/env bash
# Build image, đẩy lên ECR và deploy StreamForge lên EKS.
#
# Yêu cầu: các layer Terraform backend -> compute đã apply; aws, docker, kubectl, helm, jq.
# Chạy lại an toàn: image đã có trên ECR thì bỏ qua build, manifest apply theo kiểu khai báo.
#
#   ./k8s/deploy.sh             # build + deploy
#   SKIP_BUILD=1 ./k8s/deploy.sh   # chỉ cập nhật cấu hình (ví dụ sau khi có CloudFront)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TF="$ROOT/terraform/layers"
REGION=${AWS_REGION:-us-east-1}
KEDA_VERSION=2.20.2
# Số worker luôn chạy sẵn (chống cold start). 1 ~ +$22/tháng tiền Spot; 0 = co về 0 khi không có job
WORKER_MIN_REPLICAS=${WORKER_MIN_REPLICAS:-1}
OVERLAY="$ROOT/k8s/app/overlays/live"
DB_OVERLAY="$ROOT/k8s/app/overlays/db"

tf_out() { terraform -chdir="$TF/$1" output -raw "$2"; }
log() { printf '\n==> %s\n' "$*"; }

log "Reading Terraform outputs"
CLUSTER=$(tf_out compute cluster_name)
ECR_JSON=$(terraform -chdir="$TF/compute" output -json ecr_repository_urls)
API_REPO=$(jq -r .api <<<"$ECR_JSON")
WORKER_REPO=$(jq -r .worker <<<"$ECR_JSON")
ALB_SG=$(tf_out compute alb_security_group_id)
RAW_BUCKET=$(tf_out storage raw_bucket)
PROCESSED_BUCKET=$(tf_out storage processed_bucket)
# Bảng DynamoDB cũ: chỉ dùng để Job migration chép dữ liệu sang PostgreSQL
TABLE=$(tf_out storage videos_table 2>/dev/null || echo "")
DB_HOST=$(tf_out database endpoint)
DB_NAME=$(tf_out database database)
DB_MASTER_SECRET_ARN=$(tf_out database master_secret_arn)
QUEUE_URL=$(tf_out messaging transcode_queue_url)
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
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${API_REPO%%/*}"
  build_push() { # repo dockerfile context
    local repo=$1 name=${1##*/}
    if aws ecr describe-images --region "$REGION" --repository-name "$name" --image-ids imageTag="$TAG" >/dev/null 2>&1; then
      echo "$repo:$TAG already in ECR, skipping build"
      return
    fi
    docker build --platform linux/amd64 -f "$ROOT/$2" -t "$repo:$TAG" "$ROOT/$3"
    docker push "$repo:$TAG"
  }
  build_push "$API_REPO" docker/api.Dockerfile src/api
  build_push "$WORKER_REPO" docker/worker.Dockerfile src/transcode-worker
else
  # Giữ image đang chạy
  TAG=$(kubectl -n streamforge get deploy streamforge-api -o jsonpath='{.spec.template.spec.containers[0].image}' | sed 's/.*://')
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

log "Rendering overlay $OVERLAY"
mkdir -p "$OVERLAY"
cat > "$OVERLAY/config.env" <<EOF
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
LOG_FORMAT=json
EOF
cat > "$OVERLAY/kustomization.yaml" <<EOF
# Sinh bởi k8s/deploy.sh, không commit (chứa account ID)
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
images:
  - name: streamforge-api
    newName: $API_REPO
    newTag: $TAG
  - name: streamforge-worker
    newName: $WORKER_REPO
    newTag: $TAG
configMapGenerator:
  - name: streamforge-config
    namespace: streamforge
    envs:
      - config.env
patches:
  - target:
      kind: Ingress
      name: streamforge-api
    patch: |-
      - op: add
        path: /metadata/annotations/alb.ingress.kubernetes.io~1security-groups
        value: $ALB_SG
  - target:
      kind: ScaledObject
      name: streamforge-worker
    patch: |-
      - op: replace
        path: /spec/triggers/0/metadata/queueURL
        value: $QUEUE_URL
      - op: replace
        path: /spec/minReplicaCount
        value: $WORKER_MIN_REPLICAS
EOF

log "Database migration"
mkdir -p "$DB_OVERLAY"
cp "$OVERLAY/config.env" "$DB_OVERLAY/config.env"
# SEED_DEMO_STATS=true ./k8s/deploy.sh: thêm lượt xem và đánh giá mẫu cho video READY chưa có số liệu
printf 'DB_MASTER_SECRET_ARN=%s\nIMPORT_DYNAMODB_TABLE=%s\nSEED_DEMO_STATS=%s\n' \
  "$DB_MASTER_SECRET_ARN" "$TABLE" "${SEED_DEMO_STATS:-false}" > "$DB_OVERLAY/migrate.env"
cat > "$DB_OVERLAY/kustomization.yaml" <<EOF
# Sinh bởi k8s/deploy.sh, không commit (chứa account ID)
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../../db
images:
  - name: streamforge-api
    newName: $API_REPO
    newTag: $TAG
configMapGenerator:
  - name: streamforge-config
    namespace: streamforge
    envs:
      - config.env
  - name: streamforge-db-migrate
    namespace: streamforge
    envs:
      - migrate.env
EOF
# Job không sửa được sau khi tạo: xoá bản cũ rồi chạy lại (migration chạy lại an toàn)
kubectl -n streamforge delete job streamforge-db-migrate --ignore-not-found >/dev/null
kubectl apply -k "$DB_OVERLAY" >/dev/null
if ! kubectl -n streamforge wait --for=condition=complete job/streamforge-db-migrate --timeout=10m; then
  kubectl -n streamforge logs job/streamforge-db-migrate --tail=50 || true
  echo "Database migration failed" >&2
  exit 1
fi
kubectl -n streamforge logs job/streamforge-db-migrate --tail=20

log "Applying application"
kubectl apply -k "$OVERLAY"
kubectl -n streamforge rollout status deploy/streamforge-api --timeout=10m

log "Waiting for the API load balancer"
for _ in $(seq 1 60); do
  ALB=$(kubectl -n streamforge get ingress streamforge-api -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
  [[ -n $ALB ]] && break
  sleep 10
done
echo "ALB: ${ALB:-<not ready yet>}"
echo "Next (first deploy only): terraform -chdir=$TF/delivery apply -var api_alb_dns_name=$ALB"
echo "then: SKIP_BUILD=1 $0   to point CDN_BASE_URL at CloudFront, and src/frontend/deploy.sh for the site"
