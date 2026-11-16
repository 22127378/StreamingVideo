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
OVERLAY="$ROOT/k8s/app/overlays/live"

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
TABLE=$(tf_out storage videos_table)
INDEX=$(tf_out storage videos_created_at_index)
QUEUE_URL=$(tf_out messaging transcode_queue_url)
# Trước khi có layer delivery thì chưa có CloudFront; link phát chưa dùng được nhưng API vẫn chạy
CDN_BASE_URL=$(tf_out delivery cdn_base_url 2>/dev/null || echo "https://cdn-not-configured.invalid")

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
aws eks update-kubeconfig --name "$CLUSTER" --region "$REGION" >/dev/null

log "Cluster resources (NodePools, IngressClass)"
kubectl apply -f "$ROOT/k8s/cluster/"

log "KEDA $KEDA_VERSION"
helm repo add kedacore https://kedacore.github.io/charts >/dev/null 2>&1 || true
helm repo update kedacore >/dev/null
helm upgrade --install keda kedacore/keda --version "$KEDA_VERSION" \
  --namespace keda --create-namespace --wait --timeout 10m \
  --set podIdentity.aws.irsa.enabled=false

log "Namespace and secret"
kubectl apply -f "$ROOT/k8s/app/base/namespace.yaml"
if ! kubectl -n streamforge get secret streamforge-secrets >/dev/null 2>&1; then
  kubectl -n streamforge create secret generic streamforge-secrets \
    --from-literal=JWT_SECRET="$(openssl rand -hex 32)"
fi

log "Rendering overlay $OVERLAY"
mkdir -p "$OVERLAY"
cat > "$OVERLAY/config.env" <<EOF
NODE_ENV=production
AWS_REGION=$REGION
S3_RAW_UPLOADS_BUCKET=$RAW_BUCKET
S3_PROCESSED_BUCKET=$PROCESSED_BUCKET
SQS_TRANSCODE_QUEUE_URL=$QUEUE_URL
DYNAMODB_VIDEOS_TABLE=$TABLE
DYNAMODB_VIDEOS_CREATED_AT_INDEX=$INDEX
CDN_BASE_URL=$CDN_BASE_URL
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
EOF

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
echo "then: SKIP_BUILD=1 $0   to point CDN_BASE_URL at CloudFront"
