#!/usr/bin/env bash
# Huỷ cụm EKS tạm thời để không tốn tiền (control plane, node, ALB, ổ EBS của monitoring).
#
# Giữ lại: VPC + NAT gateway (~$33/tháng), Aurora (tự dừng khi rảnh, chỉ tính storage), S3 (video),
# Cognito, CloudFront, SQS, EventBridge, IAM role của service. Video và dữ liệu không mất.
# Mất: image trên ECR (repository có force_delete), số liệu Prometheus và cache Loki (log cũ trên S3 vẫn còn).
#
#   ./k8s/teardown.sh
#
# Dựng lại:
#   terraform -chdir=terraform/layers/compute apply
#   terraform -chdir=terraform/layers/database apply      # rule security group từ cụm vào Aurora
#   terraform -chdir=terraform/layers/services apply      # Pod Identity của service, quyền của worker
#   terraform -chdir=terraform/layers/observability apply # Pod Identity của Loki, Alertmanager, Grafana
#   ./k8s/deploy.sh && ./k8s/monitoring/install.sh        # (và ./k8s/argocd/install.sh nếu dùng ArgoCD)
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
  helm -n argocd uninstall argocd >/dev/null 2>&1 || true # ArgoCD sẽ tạo lại tài nguyên nếu còn chạy
  kubectl delete ns streamforge monitoring argocd --ignore-not-found --wait=true --timeout=10m || true
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
terraform -chdir="$TF/database" destroy -auto-approve -target=aws_vpc_security_group_ingress_rule.db_from_eks
# Policy gắn vào role worker (role thuộc layer compute)
terraform -chdir="$TF/services" destroy -auto-approve -target=aws_iam_role_policy.worker_events

log "Destroying compute (EKS, node, ECR, pod roles)"
terraform -chdir="$TF/compute" destroy -auto-approve

echo
echo "Cluster $CLUSTER destroyed. See the header of this script to bring it back."
