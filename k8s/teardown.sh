#!/usr/bin/env bash
# Huỷ cụm EKS tạm thời để không tốn tiền (control plane, node, ALB, ổ EBS của monitoring).
#
# Giữ lại: VPC + NAT gateway (~$33/tháng), Aurora (tự dừng khi rảnh, chỉ tính storage), S3 (video),
# Cognito, CloudFront, SQS, EventBridge, IAM role của service. Video và dữ liệu không mất.
# Mất: image trên ECR (repository có force_delete), số liệu Prometheus và cache Loki (log cũ trên S3 vẫn còn).
#
#   ./k8s/teardown.sh
#
# Muốn về gần $0 thì xoá thêm database (Aurora, chụp bản sao cuối trước khi xoá) và networking. Tên bản sao
# phải chưa tồn tại, nên đặt theo ngày giờ (huỷ hai lần trong một ngày vẫn không trùng); apply trước để tên
# mới nằm trong state rồi mới destroy:
#   SNAP=streamforge-dev-final-$(date +%Y%m%d-%H%M)
#   terraform -chdir=terraform/layers/database apply   -var deletion_protection=false -var final_snapshot_identifier=$SNAP
#   terraform -chdir=terraform/layers/database destroy -var deletion_protection=false -var final_snapshot_identifier=$SNAP
#   terraform -chdir=terraform/layers/networking destroy
# Bản sao gần nhất: aws rds describe-db-cluster-snapshots --snapshot-type manual --query 'DBClusterSnapshots[].[DBClusterSnapshotIdentifier,SnapshotCreateTime]' 
#
# Dựng lại (nếu đã xoá database và networking thì làm hai dòng đầu, không thì bỏ qua):
#   terraform -chdir=terraform/layers/networking apply
#   terraform -chdir=terraform/layers/database apply -var restore_snapshot_identifier=<bản sao gần nhất>
#   terraform -chdir=terraform/layers/compute apply
#   terraform -chdir=terraform/layers/database apply      # rule security group từ cụm vào Aurora, role IRSA của migration
#   terraform -chdir=terraform/layers/services apply      # role IRSA của service (trust theo OIDC của cụm mới), quyền của worker
#   terraform -chdir=terraform/layers/observability apply # role IRSA của Loki, Alertmanager, Grafana (trust theo OIDC của cụm mới)
#   ./k8s/deploy.sh && ./k8s/argocd/install.sh            # ArgoCD cài KEDA, Argo Rollouts và app
#   ./k8s/monitoring/install.sh
#   # ALB mới có DNS mới: cập nhật api_alb_dns_name trong terraform/layers/delivery/terraform.tfvars
#   terraform -chdir=terraform/layers/delivery apply
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TF="$ROOT/terraform/layers"
log() { printf '\n==> %s\n' "$*"; }

CLUSTER=$(terraform -chdir="$TF/compute" output -raw cluster_name 2>/dev/null || true)
if [[ -z $CLUSTER ]]; then
  echo "compute layer has no cluster, nothing to tear down"
  exit 0
fi

log "Removing workloads so controllers delete the ALB and EBS volumes"
if kubectl get ns >/dev/null 2>&1; then
  # Application con có finalizer: gỡ trước, không thì namespace argocd kẹt khi ArgoCD đã bị gỡ
  for app in $(kubectl -n argocd get applications -o name 2>/dev/null); do
    kubectl -n argocd patch "$app" --type merge -p '{"metadata":{"finalizers":null}}' >/dev/null || true
  done
  helm -n argocd uninstall argocd >/dev/null 2>&1 || true # ArgoCD sẽ tạo lại tài nguyên nếu còn chạy
  kubectl delete ns streamforge monitoring argocd argo-rollouts keda --ignore-not-found --wait=true --timeout=10m || true
  # Ingress bị xoá thì AWS Load Balancer Controller của Auto Mode gỡ ALB; chờ cho chắc
  for _ in $(seq 1 60); do
    n=$(aws elbv2 describe-load-balancers --query "length(LoadBalancers[?starts_with(LoadBalancerName, 'k8s-streamforge')])" --output text)
    [[ $n == 0 ]] && break
    sleep 10
  done
  echo "ALB remaining: ${n:-?}"
fi

log "Detaching cross-layer references to the cluster"
# Rule security group Aurora <- cluster: không gỡ thì không xoá được security group của cụm
terraform -chdir="$TF/database" destroy -auto-approve -target='aws_vpc_security_group_ingress_rule.db_from_eks[0]'
# Policy gắn vào role worker (role thuộc layer compute)
terraform -chdir="$TF/services" destroy -auto-approve -target=aws_iam_role_policy.worker_events

log "Destroying compute (EKS, node, ECR, pod roles)"
terraform -chdir="$TF/compute" destroy -auto-approve

echo
echo "Cluster $CLUSTER destroyed. See the header of this script to bring it back."
