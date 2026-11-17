#!/usr/bin/env bash
# Cài bộ giám sát vào cụm: kube-prometheus-stack (Prometheus, Alertmanager, Grafana), Loki, Alloy.
#
# Yêu cầu: terraform/layers/observability đã apply (bucket Loki, SNS, Pod Identity), k8s/deploy.sh đã chạy
# (namespace streamforge, KEDA). Chạy lại an toàn.
#   ./k8s/monitoring/install.sh
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
TF="$DIR/../../terraform/layers"
NS=monitoring
KPS_VERSION=93.3.0
LOKI_VERSION=7.5.0
ALLOY_VERSION=1.15.0

tf_out() { terraform -chdir="$TF/$1" output -raw "$2"; }
log() { printf '\n==> %s\n' "$*"; }

log "Reading Terraform outputs"
LOKI_BUCKET=$(tf_out observability loki_bucket)
SNS_TOPIC=$(tf_out observability alerts_topic_arn)
SITE_URL=$(tf_out delivery site_url)
CLOUDFRONT_ID=$(tf_out delivery distribution_id)
ALB_SG=$(tf_out compute alb_security_group_id)
ACCOUNT_ID=$(cut -d: -f5 <<<"$SNS_TOPIC")
DOMAIN=${SITE_URL#https://}
echo "loki=$LOKI_BUCKET grafana=$SITE_URL/grafana"

kubectl apply -f "$DIR/../cluster/storageclass.yaml"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

if ! kubectl -n "$NS" get secret grafana-admin >/dev/null 2>&1; then
  kubectl -n "$NS" create secret generic grafana-admin \
    --from-literal=admin-user=admin \
    --from-literal=admin-password="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  echo "Created Grafana admin password (kubectl -n $NS get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
fi

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update prometheus-community grafana >/dev/null

# Alertmanager gửi mọi cảnh báo tới SNS (cùng topic với CloudWatch Alarm), ký request bằng Pod Identity
ALERTMANAGER_VALUES=$(mktemp)
trap 'rm -f "$ALERTMANAGER_VALUES"' EXIT
cat > "$ALERTMANAGER_VALUES" <<EOF
alertmanager:
  config:
    route:
      # Mặc định không gửi đi (cảnh báo có sẵn của kube-prometheus-stack chỉ xem trong Grafana)
      receiver: "null"
      group_by: [alertname]
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        - receiver: sns
          matchers:
            - alertname =~ "StreamForge.*"
    receivers:
      - name: "null"
      - name: sns
        sns_configs:
          - topic_arn: $SNS_TOPIC
            sigv4:
              region: us-east-1
            subject: '[StreamForge] {{ .Status | toUpper }} {{ .CommonLabels.alertname }}'
            message: |
              {{ range .Alerts }}{{ .Status | toUpper }}: {{ .Annotations.summary }}
              {{ if .Annotations.description }}{{ .Annotations.description }}{{ end }}
              {{ end }}
grafana:
  grafana.ini:
    server:
      domain: $DOMAIN
      root_url: https://$DOMAIN/grafana
EOF

log "kube-prometheus-stack $KPS_VERSION"
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --version "$KPS_VERSION" --namespace "$NS" \
  -f "$DIR/values-kube-prometheus-stack.yaml" -f "$ALERTMANAGER_VALUES" \
  --wait --timeout 15m

log "Loki $LOKI_VERSION"
helm upgrade --install loki grafana/loki --version "$LOKI_VERSION" --namespace "$NS" \
  -f "$DIR/values-loki.yaml" \
  --set "loki.storage.bucketNames.chunks=$LOKI_BUCKET" \
  --set "loki.storage.bucketNames.ruler=$LOKI_BUCKET" \
  --set "loki.storage.bucketNames.admin=$LOKI_BUCKET" \
  --wait --timeout 10m

log "Alloy $ALLOY_VERSION"
helm upgrade --install alloy grafana/alloy --version "$ALLOY_VERSION" --namespace "$NS" \
  -f "$DIR/values-alloy.yaml" --wait --timeout 5m

log "Monitors, rules, dashboards, ingress"
kubectl apply -f "$DIR/app-monitors.yaml" -f "$DIR/rules.yaml"
sed -e "s/__ACCOUNT_ID__/$ACCOUNT_ID/g" -e "s/__CLOUDFRONT_ID__/$CLOUDFRONT_ID/g" \
  "$DIR/dashboards/streamforge-overview.json" > "$DIR/dashboards/.rendered.json"
kubectl -n "$NS" create configmap dashboard-streamforge-overview \
  --from-file=streamforge-overview.json="$DIR/dashboards/.rendered.json" --dry-run=client -o yaml |
  kubectl label --local -f - grafana_dashboard=1 -o yaml | kubectl apply -f - >/dev/null
rm -f "$DIR/dashboards/.rendered.json"
kubectl apply -f "$DIR/grafana-ingress.yaml"
kubectl -n "$NS" annotate ingress grafana --overwrite "alb.ingress.kubernetes.io/security-groups=$ALB_SG" >/dev/null

echo
echo "Grafana: $SITE_URL/grafana (user admin, password in secret $NS/grafana-admin)"
