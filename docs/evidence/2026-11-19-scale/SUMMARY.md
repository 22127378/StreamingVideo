# Bằng chứng kiểm thử scale, ngày 19/11/2026

## Bối cảnh

- **Hệ thống được đo:** cụm EKS `streamforge-dev` (us-east-1), dựng lại trong ngày.
  - Aurora khôi phục từ bản chụp `streamforge-dev-final`.
  - Pod lấy quyền AWS qua IRSA, vừa đổi từ Pod Identity trước khi đo.
- **Cấu hình lúc đo:**
  - 5 dịch vụ HTTP (account, upload, catalog, playback, live), mỗi dịch vụ 2 pod, chạy trên 2 máy on-demand.
  - Worker xử lý video là KEDA ScaledJob: 0 Job khi rảnh, tối đa 4 Job, chạy trên máy Spot.
- **Máy chạy bài đo:** đặt ở Việt Nam. Mọi yêu cầu đi qua CloudFront `d1vg93793a6nw0.cloudfront.net` rồi tới ALB ở Mỹ, nên **độ trễ đo được gồm cả đường truyền quốc tế**.
- **Nguồn số liệu:** công cụ test (smoke, burst, k6), lệnh `kubectl` ghi trạng thái cụm theo thời gian, và Prometheus trong cụm.

Thứ tự đo: smoke test (kiểm tra đúng chức năng), rồi burst transcode (scale của pipeline xử lý video), rồi k6 load, rồi k6 stress (tải lên API).

---

## 1. Smoke test: hệ thống có chạy đúng không

**Đo cái gì.** 51 kiểm tra đầu-cuối trên hệ thống thật, đi qua CloudFront như người dùng thật:

| Nhóm | Ví dụ kiểm tra |
| --- | --- |
| Đăng nhập | Cognito, tài khoản Free và Premium |
| Upload | Từ chối khi chưa đăng nhập; S3 chặn file lớn hơn kích thước đã khai; chỉ chủ video được xác nhận upload |
| Xử lý video | Video chuyển sang READY (lần này mất 45 giây cho clip dọc 6 giây) |
| Quyền xem | Free bị chặn video Premium; chủ video Free xem được video Premium của mình |
| Giới hạn 720p | Với vé xem của Free, CloudFront chặn file 1080p (403); video dọc giữ đúng tỉ lệ (720x1280) |
| Vé xem | Cookie chỉ dùng được cho đúng video đó; sửa chữ ký thì bị từ chối |
| Lượt xem, đánh giá | Lượt xem được cộng qua sự kiện; điểm trung bình tính đúng (5 và 4 ra 4,5); điểm ngoài 1 đến 5 bị từ chối |
| Nâng gói, xoá video | Nâng Free lên Premium thì thấy 1080p; xoá video thì không xem được nữa kể cả còn cookie |

**Đo bằng cách nào.** `tests/e2e/smoke.sh`:
1. Tạo 3 người dùng tạm.
2. Upload một clip dọc 6 giây, chờ xử lý xong.
3. Chạy lần lượt các kiểm tra, mỗi kiểm tra so mã trả về hoặc nội dung với giá trị mong đợi.
4. Xoá dữ liệu tạm.

**Số liệu.** **51/51 đạt, 0 lỗi** (`05-smoke.log`).

**Đo để làm gì.** Có hai mục đích:
- Xác nhận việc đổi sang IRSA không làm hỏng quyền của dịch vụ nào. Mỗi dịch vụ đều gọi AWS: upload ghi S3 và gửi sự kiện, catalog đọc hàng đợi và đăng nhập database, worker đọc và ghi S3.
- Có mốc "hệ thống đúng" trước khi tạo tải. Nếu hệ thống sai sẵn thì số đo tải không có nghĩa.

**Kết quả phản ánh điều gì.**
- Mọi chức năng chính chạy đúng trên hạ tầng mới.
- Mọi role IRSA đủ quyền cho đúng việc của nó. Một role thiếu quyền sẽ làm hỏng ít nhất một kiểm tra.
- Smoke test chỉ có một người dùng tại một thời điểm, nên **không nói gì về hiệu năng**.

`05-smoke-aborted-no-credentials.log` là lần chạy hỏng vì máy chạy test thiếu thông tin đăng nhập AWS, không phải lỗi hệ thống. Log được giữ lại để không bị nhầm với kết quả thật.

---

## 2. Burst transcode: pipeline xử lý video có tự mở rộng khi việc dồn tới không

**Đo cái gì.**
- Chuyện gì xảy ra khi **10 video được đẩy lên cùng lúc**.
- Thời gian để tất cả xử lý xong, số video lỗi.
- KEDA tạo bao nhiêu Job worker, Karpenter thuê thêm bao nhiêu máy Spot.
- Hàng đợi dâng lên rồi rút xuống ra sao.
- Sau đó máy có được trả lại không.

**Đo bằng cách nào.**
- `tests/load/pipeline-burst.sh` tạo một clip 1080p dài 30 giây (59 MB). Nó đẩy 10 bản song song qua `/api/uploads`, rồi hỏi trạng thái từng video mỗi khoảng 20 giây.
- Song song, một script ghi trạng thái cụm mỗi vòng (khoảng 20 giây): số Job, số worker đang chạy, pod giữ chỗ, số máy Spot, số tin trong hàng đợi SQS. Kết quả ở `06-burst-timeline.log`.

**Số liệu** (`06-burst.log`, `06-burst-timeline.log`, giờ UTC):

| Thời điểm | Diễn biến |
| --- | --- |
| 0 giây | Bắt đầu upload 10 video từ Việt Nam |
| 112 giây (~04:52:40) | Upload xong, 10 phiếu vào hàng đợi |
| 04:52:51 | **Job đầu tiên đã chạy**, trên máy Spot giữ sẵn. Pod giữ chỗ bị đẩy ra (`placeholder=0`), nên video đầu không phải chờ thuê máy |
| 04:53:28 | Hàng đợi cao nhất: **9 phiếu chờ**, 1 đang xử lý |
| 04:53:10 đến 04:54:26 | Karpenter thuê thêm máy Spot: **1, 2, 3, 4 máy**. Mỗi máy mới sẵn sàng sau khoảng 1 phút |
| 04:54:26 | **4 Job chạy cùng lúc**, đúng mức trần |
| 04:56:25 | Hàng đợi về 0 |
| 360 giây (~04:57) | **10/10 video READY**, 0 lỗi, hàng đợi lỗi (DLQ) 0 phiếu |
| Sau đó | Máy Spot được trả dần **4, 3, 2, 1** (xem cột `transcode_nodes` ở `07-load-timeline.log`). Còn 1 máy cho pod giữ chỗ |

- Mỗi Job xử lý đúng 1 video, mất **39 đến 77 giây** cho clip 30 giây. Clip được làm thành các bản 1080p, 720p, 480p, 360p.
- Phần xử lý (từ lúc vào hàng đợi tới lúc xong) mất khoảng **4 phút cho 10 video**, tức khoảng 2,5 video mỗi phút với 4 worker.

**Đo để làm gì.** Kiểm tra lời hứa chính của thiết kế:
- Rảnh thì không tốn máy, có việc thì tự mở rộng.
- Không mất video nào khi đông.
- Hết việc thì tự thu về để không tốn tiền.

**Kết quả phản ánh điều gì.**
- **Co giãn theo hàng đợi hoạt động đúng.** KEDA tạo Job theo số phiếu chờ, Karpenter thuê máy theo số Job cần chạy, cả hai tự thu về khi hết việc.
- **Pod giữ chỗ có tác dụng.** Video đầu tiên đã chạy ở lần ghi kế tiếp sau khi upload xong (dưới 20 giây, bằng khoảng cách giữa hai lần ghi). Nếu không có pod giữ chỗ, video đầu phải chờ khoảng 1 phút để thuê máy (đúng bằng thời gian các máy thứ 2 đến 4 cần để sẵn sàng).
- **Không mất việc:** 0 video lỗi, 0 phiếu vào hàng đợi lỗi.
- **Giới hạn là trần 4 worker:** 10 video phải xử lý thành khoảng 3 lượt. Muốn nhanh hơn khi đông thì nâng `maxReplicaCount` (và giới hạn CPU của nhóm máy Spot).
- Thời gian upload (112 giây) phụ thuộc mạng của máy chạy test, không phải năng lực hệ thống.

---

## 3. k6 load: API trả lời nhanh và ổn định ở mức tải bình thường không

**Đo cái gì.**
- **Độ trễ** (thời gian từ lúc gửi yêu cầu tới lúc nhận xong trả lời) và **tỉ lệ lỗi** của API.
- Hai đường đọc được dùng nhiều nhất: **danh sách video** (`GET /api/videos?limit=20`) và **chi tiết một video** (`GET /api/videos/{id}`, chọn ngẫu nhiên).

**Đo bằng cách nào.**
- Công cụ k6 (`tests/load/run.sh api.js`, kịch bản `load`): **20 người dùng ảo** chạy liên tục 4,5 phút (tăng dần 1 phút, giữ 3 phút, giảm 30 giây).
- Mỗi người dùng ảo lặp lại: gọi danh sách, gọi chi tiết, nghỉ một chút.
- Ngưỡng đạt đặt sẵn trong bài: p95 danh sách dưới 800 ms, p95 chi tiết dưới 500 ms, lỗi dưới 1%, kiểm tra nội dung đạt trên 99%.

**Cách đọc số.**
- **avg** là trung bình.
- **med** (trung vị): một nửa số yêu cầu nhanh hơn số này.
- **p95**: 95% số yêu cầu nhanh hơn số này. Đây là số thường dùng để nói "hầu hết người dùng chờ bao lâu", vì trung bình bị vài yêu cầu rất nhanh hoặc rất chậm kéo lệch.
- **p99**: 99% nhanh hơn. **max** là yêu cầu chậm nhất.

**Số liệu** (`07-k6-load.log`, `07-k6-load-summary.json`):

| | Tất cả | Danh sách | Chi tiết |
| --- | --- | --- | --- |
| Số yêu cầu | 5.449 (khoảng 20 mỗi giây) | | |
| Lỗi | **0** | | |
| Trung vị | 314 ms | 315 ms | 312 ms |
| p95 | **528 ms** | 539 ms (ngưỡng 800) | 380 ms (ngưỡng 500) |
| p99 | 562 ms | 628 ms | 545 ms |
| Chậm nhất | 1,45 s | 1,30 s | 0,79 s |

Mọi ngưỡng đều đạt.

**Đo để làm gì.** Lấy mốc hiệu năng ở mức tải "bình thường" để so với bài stress, và xác nhận đường đọc không lỗi khi có nhiều người cùng dùng.

**Kết quả phản ánh điều gì.**
- **Ổn định:** 0 lỗi, độ trễ đều (trung vị và p95 chênh nhau ít).
- **Phần lớn độ trễ là đường truyền, không phải máy chủ.**
  - Trung vị khoảng 314 ms gần bằng thời gian một vòng đi về Việt Nam và Mỹ qua CloudFront.
  - Log của catalog trong lúc test ghi thời gian xử lý mỗi yêu cầu chỉ **vài mili-giây** (thường 1 đến 6 ms). Log này đọc trực tiếp trên cụm, không lưu vào thư mục này.
  - Người dùng ở gần region us-east-1 sẽ thấy nhanh hơn nhiều. Muốn nhanh hơn cho người dùng ở Việt Nam thì phải đặt máy chủ gần hơn (ví dụ region Singapore), không phải thêm máy.
- **Danh sách chậm hơn chi tiết một chút** ở p95 và p99, vì trả về 20 video thay vì 1.

---

## 4. k6 stress: tải tăng gấp 10 lần thì sao, và hệ thống có tự mở rộng không

**Đo cái gì.**
- Cùng hai đường đọc như bài load, nhưng **tăng dần lên 200 người dùng ảo**.
- Xem độ trễ có tăng không, lỗi có xuất hiện không, và số pod có tăng theo tải không.

**Đo bằng cách nào.**
- k6 kịch bản `stress`, 10 phút: lên 50 người dùng ảo (giữ 2 phút), lên 100 (giữ 2 phút), lên 200 (giữ 2 phút), rồi giảm về 0.
- Song song, script ghi số pod của từng dịch vụ và số máy mỗi 10 giây (`07-load-timeline.log`).
- Sau bài, mình hỏi Prometheus CPU và RAM của từng dịch vụ trong suốt khoảng thời gian đo.

**Số liệu** (`08-k6-stress.log`, `08-k6-stress-summary.json`, `07-load-timeline.log`):

| | Kết quả |
| --- | --- |
| Số yêu cầu | 75.937 (trung bình 126 mỗi giây; đỉnh khoảng **241 mỗi giây** theo Prometheus, số này gồm cả kiểm tra sức khoẻ nội bộ) |
| Lỗi | **1** trên 75.937 (0,001%): một lần gọi chi tiết không trả 200 |
| Trung vị / p95 / p99 | 316 ms / **428 ms** / 590 ms |
| p95 danh sách / chi tiết | 533 ms / 370 ms (ngưỡng 800 / 500, đạt) |
| Chậm nhất | 2,1 s |
| Số pod mỗi dịch vụ | **Giữ nguyên 2** suốt bài (43/43 lần ghi, mỗi 10 giây) |
| Số máy ứng dụng | **Giữ nguyên 2** |
| CPU catalog lúc đỉnh | khoảng **0,53 vCPU cho 2 pod** (khoảng 265m mỗi pod) |
| RAM catalog lúc đỉnh | khoảng **70 MiB mỗi pod** (giới hạn 256 MiB) |
| CPU các dịch vụ khác | khoảng 0,01 vCPU (không nhận tải trong bài này) |

**Đo để làm gì.**
- Tìm xem hệ thống bắt đầu chậm hoặc lỗi ở mức tải nào (điểm gãy).
- Kiểm tra phần dịch vụ HTTP có tự mở rộng khi tải tăng không.

**Kết quả phản ánh điều gì.**
- **Chịu được tải gấp 10 lần mà không chậm đi.** Độ trễ ở 200 người dùng ảo không tệ hơn ở 20. p95 thấp hơn một chút, khác biệt nằm trong dao động của mạng, không có ý nghĩa. Tỉ lệ lỗi gần như bằng 0.
- **Chưa tìm ra điểm gãy.** Tải chưa đủ lớn để làm hệ thống chậm đi. Giới hạn lúc này có thể nằm ở máy chạy k6 và đường truyền của nó, chứ chưa phải ở cụm.
- **Dịch vụ HTTP không tự mở rộng.** Số pod giữ nguyên 2 vì không có HPA (`09-cluster-state.txt`, mục HPA, chỉ có HPA của pod giữ chỗ). Hệ thống chịu được tải là nhờ **còn dư sức**, không phải nhờ co giãn. Với tải lớn hơn nhiều, cần thêm HPA.
- **Mức CPU "xin" của catalog quá thấp so với thực tế.** Catalog xin 50m nhưng dùng tới khoảng 265m mỗi pod. Kubernetes và Karpenter xếp chỗ theo mức xin, nên đang nghĩ máy còn rộng hơn thật. Khi nhiều thứ cùng tải nặng, các pod có thể tranh nhau CPU. Nên nâng mức xin hoặc dùng HPA theo CPU.
- **RAM không đáng lo:** 70 MiB trên giới hạn 256 MiB.

---

## 5. Trạng thái cụm và quyền (IRSA) sau khi đo

**Đo cái gì.** Ảnh chụp trạng thái cụm sau các bài đo (`09-cluster-state.txt`):
- Máy, pod, Rollout, ScaledJob, HPA, các Job worker đã chạy.
- ServiceAccount nào gắn role IAM nào.

**Đo để làm gì.** Làm bằng chứng cho các nhận định ở trên:
- Chỉ worker và pod giữ chỗ có cơ chế co giãn.
- Mọi ServiceAccount đều có đúng một role IRSA riêng.

**Kết quả phản ánh điều gì.**
- 11 ServiceAccount (5 dịch vụ, worker, migration, KEDA, Loki, Alertmanager, Grafana) mỗi cái trỏ tới role riêng của mình.
- Không có HPA cho dịch vụ HTTP.
- 5 Job worker gần nhất đều `Complete`. Pod của chúng đã bị dọn trước khi lấy log, nên **không có log của từng Job**. Bằng chứng về worker nằm ở mục 2.

---

## Chưa đo trong lần này

- **Upload, playback và livestream dưới tải:** k6 chỉ gọi hai đường đọc. Upload chỉ được đo ở quy mô 10 video (mục 2).
- **Canary:** không có phiên bản mới để cập nhật.
- **Độ trễ phía máy chủ tách riêng:** chưa lưu số p95 của máy chủ từ Prometheus, chỉ có ví dụ từ log.
- **Điểm gãy của API:** cần tải lớn hơn, chạy từ máy gần region hơn hoặc từ nhiều máy.

## Lỗi phát hiện trong lúc đo

- **Cảnh báo giả `StreamForgeWorkerUnavailable`:**
  - Luật cũ báo khi không có Job worker nào chạy 15 phút, nhưng worker về 0 khi rảnh là đúng thiết kế. Sau bài burst, cảnh báo này ở trạng thái `firing` dù hệ thống khoẻ.
  - **Đã sửa sau đó** (commit `e04a3ad`): chỉ báo khi có video chờ mà 10 phút không có Job nào chạy. Luật mới có kiểm thử bằng `promtool` cho 3 tình huống.
- **Bài burst cũ lỗi thời:** gọi đường dẫn của API cũ, không gửi token. Đã sửa (commit `eb9ae18`).

## Danh sách file

| File | Nội dung |
| --- | --- |
| `01-deploy.log`, `02-deploy-cdn.log` | `k8s/deploy.sh` lần đầu và lần trỏ CDN |
| `03-frontend-deploy.log`, `04-monitoring-install.log` | Deploy frontend, cài Prometheus/Loki/Alloy/Grafana |
| `05-smoke.log` | Smoke test (mục 1). `05-smoke-aborted-no-credentials.log`: lần chạy hỏng do thiếu thông tin đăng nhập |
| `06-burst.log`, `06-burst-timeline.log` | Burst 10 video và diễn biến cụm (mục 2) |
| `07-k6-load.log`, `07-k6-load-summary.json` | k6 load (mục 3) |
| `07-load-timeline.log` | Số pod và máy trong suốt load và stress, gồm cả lúc máy Spot được trả về |
| `07-load-start-utc.txt`, `07-load-end-utc.txt`, `08-stress-end-utc.txt` | Mốc thời gian để tra Prometheus |
| `08-k6-stress.log`, `08-k6-stress-summary.json` | k6 stress (mục 4) |
| `09-cluster-state.txt` | Trạng thái cụm và quyền sau khi đo (mục 5) |
