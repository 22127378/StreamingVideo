#!/usr/bin/env bash
# Cài ArgoCD lên cụm EKS và tạo Application "streamforge" (GitOps cho k8s/gitops/dev).
# Chạy sau k8s/deploy.sh lần đầu (cần namespace, secret, KEDA đã có).
#
#   ./k8s/argocd/install.sh
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

kubectl apply -f "$ROOT/k8s/argocd/application.yaml"
echo
echo "ArgoCD đã cài. Application streamforge theo dõi k8s/gitops/dev trên nhánh main."
echo "Trạng thái: kubectl -n argocd get application streamforge"
