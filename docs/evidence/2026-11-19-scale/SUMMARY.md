# Bằng chứng kiểm thử scale, ngày 19/11/2026

Môi trường: cụm EKS `streamforge-dev` dựng lại cùng ngày (us-east-1), Aurora khôi phục từ bản chụp `streamforge-dev-final`, pod dùng IRSA. Máy chạy test ở Việt Nam, đi qua CloudFront `d1vg93793a6nw0.cloudfront.net` nên độ trễ đo được gồm cả đường truyền quốc tế.

## Các file

| File | Nội dung |
| --- | --- |
| `01-deploy.log`, `02-deploy-cdn.log` | `k8s/deploy.sh` lần đầu và lần trỏ CDN |
| `03-frontend-deploy.log`, `04-monitoring-install.log` | Deploy frontend, cài Prometheus/Loki/Alloy/Grafana |
| `05-smoke.log` | Smoke test 51 kiểm tra. `05-smoke-aborted-no-credentials.log` là lần chạy hỏng do thiếu credential, giữ lại để không nhầm |
| `06-burst.log`, `06-burst-timeline.log` | Bài burst 10 video và diễn biến cụm mỗi 5 giây |
| `07-k6-load.log`, `07-k6-load-summary.json`, `07-load-timeline.log` | k6 kịch bản load (20 người dùng ảo) và số pod/node mỗi 10 giây |
| `08-k6-stress.log`, `08-k6-stress-summary.json` | k6 kịch bản stress (tới 200 người dùng ảo) |
| `09-cluster-state.txt` | Trạng thái cụm sau test: node, pod, Rollout, ScaledJob, HPA, ServiceAccount và role IRSA |

## Kết quả

### 1. Smoke test sau khi chuyển sang IRSA: 51/51 đạt
Đăng nhập, upload, transcode, khoá Premium, giới hạn 720p, lượt xem, đánh giá, xoá video.

### 2. Burst transcode: 10 video 1080p (59 MB mỗi video) cùng lúc, scale của worker và node
- 10 READY, 0 FAILED, hàng đợi lỗi 0 phiếu, tổng 360 giây (gồm 112 giây upload từ máy test).
- KEDA đưa số Job worker chạy cùng lúc lên **4** (mức trần `maxReplicaCount`).
- Karpenter cấp thêm node Spot: **1 lên 4**. Pod giữ chỗ bị đuổi khi Job thật tới rồi được dựng lại trên node mới, đúng thiết kế.
- Hàng đợi SQS đạt 9 phiếu chờ rồi về 0. Mỗi Job xử lý đúng một video, mất 39 đến 77 giây.
- **Scale-in:** sau khi rảnh, node Spot thu về từ 4 xuống 1 (chỉ còn node giữ pod giữ chỗ). Xem `07-load-timeline.log` (cột `transcode_nodes` giảm 4, 3, 2, 1) và `09-cluster-state.txt`.

### 3. Tải HTTP bằng k6 (chỉ gọi hai endpoint đọc: danh sách và chi tiết video)

| | Load (20 VU, 4m30s) | Stress (tới 200 VU, 10m) |
| --- | --- | --- |
| Số request | 5.449 | 75.937 |
| Tốc độ trung bình | 20 req/s | 126 req/s |
| Lỗi | 0 | 1 request (0,001%) |
| Độ trễ p95 | 528 ms | 428 ms |
| Độ trễ p99 | 562 ms | 590 ms |
| Ngưỡng của bài test | Đạt | Đạt |

- Prometheus ghi nhận đỉnh khoảng 241 req/s toàn hệ thống (có cả request nội bộ như health check).
- Catalog dùng đỉnh khoảng 0,53 vCPU cho cả 2 pod và khoảng 70 MiB RAM mỗi pod. Các dịch vụ khác gần như không tốn CPU vì không nhận tải.

## Giới hạn và điều cần biết (nói thẳng)

1. **Các dịch vụ HTTP không tự scale.** Mỗi dịch vụ cố định 2 pod, không có HPA (xem mục HPA trong `09-cluster-state.txt`: chỉ có HPA của pod giữ chỗ). Trong bài stress, số pod giữ nguyên 2 mỗi dịch vụ và 2 node ứng dụng (`07-load-timeline.log`). Hệ thống chịu được tải này là nhờ dư sức, chưa phải do co giãn. Chỉ **worker (KEDA) và số node Spot (Karpenter)** co giãn.
2. **Chưa tìm ra điểm gãy.** Độ trễ không xấu đi khi tăng từ 20 lên 200 người dùng ảo, nên 200 VU chưa phải trần của hệ thống. Có thể trần nằm ở máy chạy k6 hoặc đường truyền chứ chưa phải ở cụm.
3. **CPU request quá thấp so với thực tế.** Catalog xin 50m mỗi pod nhưng dùng khoảng 265m mỗi pod ở đỉnh. Karpenter và scheduler tính chỗ theo mức xin, nên đang nghĩ pod nhẹ hơn thực tế.
4. **Độ trễ gồm cả đường truyền** từ Việt Nam sang Mỹ. Chưa tách phần xử lý ở server.
5. **k6 chỉ đo đường đọc.** Upload, playback (cấp cookie) và live-service chưa có bài tải riêng. Bài burst có đo upload ở quy mô 10 video.
6. **Log của Job worker không còn** để chụp: pod của Job đã hoàn thành bị dọn trước khi mình lấy log. Bằng chứng về worker nằm ở `06-burst.log` (trạng thái từng video) và `06-burst-timeline.log` (số Job, node, hàng đợi theo thời gian).
7. **Canary chưa được thử** (không có phiên bản mới để cập nhật trong lần test này).

## Lỗi phát hiện trong lúc test

- **Cảnh báo giả `StreamForgeWorkerUnavailable`:** luật cảnh báo báo khi không có Job worker nào chạy 15 phút, nhưng worker về 0 khi rảnh là đúng thiết kế. Sau bài burst, cảnh báo này đang ở trạng thái `firing` dù hệ thống khoẻ (kiểm tra qua Prometheus). Luật nên đổi thành "có phiếu trong hàng đợi mà không có Job nào chạy".
- **Bài burst cũ lỗi thời:** gọi route cũ và không gửi token. Đã sửa trong `tests/load/pipeline-burst.sh` (chưa commit).
