# Giám sát StreamForge

Bộ Grafana chạy trong cụm, cộng phần CloudWatch cho những gì chỉ AWS thu được.

```
Pod (API, worker, KEDA, ...) ──stdout──▶ Alloy ──▶ Loki ──(S3)
Sự kiện Kubernetes ─────────────────────▶ Alloy ──▶ Loki
/metrics API, worker, KEDA, kubelet ────▶ Prometheus ──▶ Alertmanager ──▶ SNS ──▶ email
SQS, CloudFront metric + access log ────▶ CloudWatch ──▶ (CloudWatch Alarm ──▶ SNS)
                                               ▲
Grafana (https://<cloudfront>/grafana) ─ đọc Prometheus, Loki và CloudWatch
```

| Thành phần | Chart | Ghi chú |
| --- | --- | --- |
| Prometheus, Alertmanager, Grafana, kube-state-metrics | kube-prometheus-stack 93.3.0 | Prometheus lưu 7 ngày trên EBS 20 GiB. Không có node-exporter (máy EKS Auto Mode không cho pod dùng mạng/PID của máy) |
| Loki | grafana/loki 7.5.0 | Single binary, dữ liệu trên S3, giữ 14 ngày |
| Alloy | grafana/alloy 1.15.0 | 1 Deployment, đọc log qua Kubernetes API |

## Cài đặt

```bash
terraform -chdir=terraform/layers/observability apply   # bucket Loki, SNS, Pod Identity, CloudWatch
./k8s/monitoring/install.sh
```

Mật khẩu admin của Grafana:

```bash
kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d
```

## Dữ liệu có gì

Log (Loki, datasource `Loki`):

- Mọi pod, label `namespace`, `pod`, `container`, `app`, `node`.
- API và worker log JSON; Alloy tách `level`, `event`, `service` thành label. Ví dụ:
  - `{namespace="streamforge", level="error"}`: lỗi
  - `{namespace="streamforge", event="http_request"} | json | durationMs > 1000`: request chậm
  - `{namespace="streamforge", event="transcode_finished"} | json | outcome != "done"`: job lỗi
  - `{namespace="streamforge"} |= "<videoId>"`: mọi dòng log về một video
- Sự kiện Kubernetes: `{job="kubernetes-events"}`.

Metric (Prometheus):

| Metric | Nguồn |
| --- | --- |
| `streamforge_http_request_duration_seconds` (histogram, nhãn method, route, status) | API |
| `streamforge_playback_decisions_total` (result, video_tier, user_tier) | API |
| `streamforge_uploads_created_total` | API |
| `streamforge_transcode_jobs_total` (outcome) | Worker |
| `streamforge_transcode_duration_seconds` (histogram) | Worker |
| `streamforge_transcode_in_progress` | Worker |
| `keda_scaler_metrics_value`, `keda_scaler_errors_total` | KEDA |
| CPU/RAM container, trạng thái deployment, restart | kubelet/cAdvisor, kube-state-metrics |

CloudWatch (datasource `CloudWatch`): SQS (độ dài hàng đợi, DLQ, tuổi job cũ nhất), CloudFront (request, tỉ lệ lỗi, dữ liệu tải), log `/streamforge/dev/cloudfront` và audit EKS `/aws/eks/streamforge-dev/cluster`.

Dashboard: "StreamForge overview" (`dashboards/streamforge-overview.json`), cộng các dashboard Kubernetes có sẵn của kube-prometheus-stack.

## Cảnh báo

Gửi email qua SNS topic `streamforge-dev-alerts` (phải bấm xác nhận email đăng ký lần đầu).

| Cảnh báo | Nguồn | Khi nào |
| --- | --- | --- |
| StreamForgeApiDown | Prometheus | Không pod API nào lên trong 5 phút |
| StreamForgeApiHigh5xxRate | Prometheus | > 5% request lỗi 5xx trong 10 phút |
| StreamForgeApiSlow | Prometheus | p95 > 1.5s trong 15 phút |
| StreamForgeTranscodeFailed | Prometheus | Có job failed/rejected trong 15 phút |
| StreamForgeWorkerUnavailable | Prometheus | Không có worker sẵn sàng trong 15 phút (mức provisioned là 1) |
| StreamForgePodCrashLooping | Prometheus | Pod restart > 3 lần trong 15 phút |
| StreamForgeScrapeTargetDown | Prometheus | Không scrape được API/worker/KEDA trong 10 phút |
| dlq-not-empty | CloudWatch | DLQ có message |
| transcode-queue-stuck | CloudWatch | Job chờ > 15 phút |
| cloudfront-5xx | CloudWatch | > 5% request CloudFront lỗi 5xx trong 10 phút |

Cảnh báo có sẵn của kube-prometheus-stack chỉ hiện trong Grafana (Alerting), không gửi email.
