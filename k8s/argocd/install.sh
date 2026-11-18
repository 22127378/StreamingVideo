#!/usr/bin/env bash
# Cài ArgoCD lên cụm EKS và tạo Application gốc "root" (App-of-Apps) trỏ vào repo cấu hình.
# Từ đó ArgoCD tự cài cluster, KEDA, Argo Rollouts và ứng dụng (xem README của repo cấu hình).
# Chạy sau k8s/deploy.sh lần đầu (cần namespace và secret).
#
#   ./k8s/argocd/install.sh
#   CONFIG_REPO_URL=https://github.com/<owner>/<repo>.git ./k8s/argocd/install.sh
#
# Mở UI: kubectl -n argocd port-forward svc/argocd-server 8443:443  rồi vào https://localhost:8443
# Tài khoản admin, mật khẩu:
#   kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CHART_VERSION=10.11.7 # ArgoCD v3.5.7

helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
helm repo update argo >/dev/null
helm upgrade --install argocd argo/argo-cd --version "$CHART_VERSION" \
  --namespace argocd --create-namespace --wait --timeout 10m \
  -f "$ROOT/k8s/argocd/values.yaml"

CONFIG_REPO_URL=${CONFIG_REPO_URL:-https://github.com/22127378/StreamingVideo-config.git}
sed "s#repoURL: https://github.com/22127378/StreamingVideo-config.git#repoURL: $CONFIG_REPO_URL#"   "$ROOT/k8s/argocd/root-app.yaml" | kubectl apply -f -
# Application "streamforge" cũ (trỏ vào k8s/gitops/dev) trùng tên với Application con mới trong
# apps/streamforge.yaml, nên root ghi đè spec của nó: không cần xoá tay.
echo
echo "ArgoCD đã cài. Application root theo dõi apps/ của $CONFIG_REPO_URL."
echo "Trạng thái: kubectl -n argocd get applications"
