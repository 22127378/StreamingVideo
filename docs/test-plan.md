# Kịch bản test StreamForge

Tài liệu này mô tả các kịch bản test cho bản deploy trên AWS (EKS + CloudFront): kiểm thử chức năng, bảo mật, khả năng phục hồi và stress test. Script nằm trong `tests/`.

Mọi script nhận `BASE_URL` là domain CloudFront, lấy bằng `terraform -chdir=terraform/layers/delivery output -raw cdn_base_url`.

| Script | Dùng cho | Thời gian | Chi phí |
| --- | --- | --- | --- |
| `tests/e2e/smoke.sh` | 20 kiểm tra chức năng và bảo mật, từ trang chủ tới xoá video | 2 tới 6 phút | Không đáng kể |
| `tests/load/run.sh api.js` | Tải lên API đọc (smoke, load, stress, spike, soak) | 30 giây tới 30 phút | Vài cent |
| `tests/load/run.sh hls.js` | Người xem phát HLS qua CloudFront | Tuỳ `DURATION` | ~$0.40 cho 50 người xem trong 5 phút |
| `tests/load/pipeline-burst.sh` | Nhiều video transcode cùng lúc: KEDA, node Spot | 5 tới 15 phút | ~$0.05 tiền Spot |
| `tests/load/run.sh rate-limit.js` | Kiểm tra rate limit endpoint ghi | ~10 giây | 0 |

Yêu cầu: `curl`, `jq`, Docker (cho k6). Script tạo video test dùng `ffmpeg` trong PATH, hoặc binary trong `src/transcode-worker/node_modules` sau khi `npm install`. `kubectl` và `aws` là tuỳ chọn, dùng để quan sát cụm khi chạy `pipeline-burst.sh`.

## 1. Chức năng (tests/e2e/smoke.sh)

```bash
BASE_URL=https://dxxxx.cloudfront.net ./tests/e2e/smoke.sh            # tự tạo clip dọc 6 giây
BASE_URL=https://dxxxx.cloudfront.net ./tests/e2e/smoke.sh my.mp4     # dùng file của bạn
KEEP=1 BASE_URL=... ./tests/e2e/smoke.sh                               # giữ video lại để xem
```

| # | Kịch bản | Kỳ vọng |
| --- | --- | --- |
| F0 | Trang chủ (frontend) | 200, có `<div id="root">` |
| F1 | `GET /api/videos` | 200 |
| F2 | `upload-url` thiếu `fileSize` | 400 |
| F3 | `upload-url` hợp lệ | 201, có `videoId` dạng UUID và `uploadUrl` |
| F4 | `complete` trước khi PUT file | 400 (file chưa có trên S3) |
| F5 | PUT file lớn hơn `fileSize` đã khai báo | 403 từ S3 (kích thước được ký vào URL) |
| F6 | PUT đúng file | 200 |
| F7 | `complete` | 200, video sang `PROCESSING` |
| F8 | `complete` lần hai | 409 |
| F9 | `DELETE` khi đang `PROCESSING` | 409 |
| F10 | Chờ transcode | `READY` trong vòng 10 phút. Lần đầu mất khoảng 75 giây vì phải cấp node Spot |
| F11 | `master.m3u8` qua CloudFront | 200 |
| F12 | Playlist của một rendition | 200 |
| F13 | Một segment `.ts` | 200 |
| F14 | Video dọc giữ đúng tỷ lệ | `master.m3u8` có `RESOLUTION=720x1280` |
| F15 | `verify-playback` với token cấp cho video đó | 200 |
| F16 | `verify-playback` không có token | 401 |
| F17 | `DELETE` video `READY` | 200 |
| F18 | `GET` video đã xoá | 404 |
| F19 | Segment của video đã xoá | 403 hoặc 404 trong vòng 6 phút (API invalidate cache CloudFront khi xoá) |

Các kịch bản sau chưa có trong script, kiểm tra tay:

| # | Kịch bản | Cách làm | Kỳ vọng |
| --- | --- | --- | --- |
| F20 | Phát thật trên player | Mở `streamingUrl` bằng Safari, VLC hoặc https://hlsjs.video-dev.org/demo | Phát được, đổi chất lượng được |
| F21 | Video premium với token free | `upload-url` với `"tier":"premium"`, xin token `"tier":"free"` rồi `verify-playback` | 403 |
| F22 | Danh sách có phân trang | `GET /api/videos?limit=2`, gọi tiếp bằng `nextToken` | Trang sau không trùng trang trước, trang cuối có `nextToken: null` |
| F23 | File không phải video | PUT một file text đã đổi đuôi `.mp4` | Video sang `FAILED` sau 3 lần thử, message vào DLQ |
| F24 | Video quá dài | Video dài hơn 30 phút | `FAILED` ngay, không retry |

## 2. Bảo mật

| # | Kịch bản | Cách kiểm tra | Kỳ vọng |
| --- | --- | --- | --- |
| S1 | Bucket processed không public | `curl https://<processed-bucket>.s3.us-east-1.amazonaws.com/<id>/master.m3u8` | 403 |
| S2 | ALB chỉ nhận traffic từ CloudFront | `curl --max-time 8 http://<alb-dns>/api/videos` (`kubectl -n streamforge get ingress`) | Timeout |
| S3 | Giới hạn dung lượng upload | F5 | 403 |
| S4 | Rate limit endpoint ghi | `rate-limit.js` (mục 4.4) | Có request bị 429 kèm `Retry-After` |
| S5 | Token giả hoặc hết hạn | Token ký bằng secret khác | 401 |
| S6 | `videoId` không phải UUID | `GET /api/videos/abc`, `DELETE /api/videos/..%2F..` | 400 |
| S7 | Pod chỉ có quyền tối thiểu | `kubectl -n streamforge logs deploy/streamforge-worker` khi chạy F10 | Không có `AccessDenied` |

## 3. Phục hồi

Chạy trong lúc `pipeline-burst.sh` đang transcode.

| # | Kịch bản | Cách làm | Kỳ vọng |
| --- | --- | --- | --- |
| R1 | Worker bị tắt giữa chừng | `kubectl -n streamforge delete pod -l app=streamforge-worker` | Worker trả message về queue trong ≤ 25 giây, pod mới nhận lại job, video vẫn `READY`. Không có video `FAILED` |
| R2 | Mất node Spot | `kubectl delete node <node transcode>` (giống Spot bị thu hồi) | Như R1, Karpenter cấp node mới |
| R3 | Mất một pod API | `kubectl -n streamforge delete pod <một pod api>` | Không có request lỗi, vì PDB giữ ít nhất 1 pod và ALB bỏ target hỏng |
| R4 | Co về 0 | Chờ khoảng 5 phút sau khi queue rỗng | `streamforge-worker` còn 0 replica, node `transcode` bị thu hồi |

## 4. Stress test

Chạy theo thứ tự smoke, load, stress, spike. Kết quả dạng JSON được lưu ở `tests/load/results/` (đã gitignore).

### 4.1 API đọc (api.js)

```bash
export BASE_URL=https://dxxxx.cloudfront.net
SCENARIO=smoke  ./tests/load/run.sh api.js    # 1 VU, 30 giây
SCENARIO=load   ./tests/load/run.sh api.js    # 20 VU, ~4.5 phút
SCENARIO=stress ./tests/load/run.sh api.js    # 50 -> 100 -> 200 VU, ~10 phút
SCENARIO=spike  ./tests/load/run.sh api.js    # 5 -> 200 VU trong 10 giây
SCENARIO=soak   ./tests/load/run.sh api.js    # 10 VU, 30 phút
```

Mỗi VU gọi `GET /api/videos?limit=20` và `GET /api/videos/:id` rồi nghỉ 1 giây. Request `/api/*` không được cache, nên đi thẳng tới ALB, pod API và DynamoDB.

Ngưỡng mặc định: lỗi < 1%, p95 của list < 800ms, p95 của detail < 500ms. Latency phụ thuộc khoảng cách tới edge CloudFront, chỉnh bằng `LIST_P95` và `DETAIL_P95`.

Điều cần tìm:
- **load:** đạt ngưỡng.
- **stress:** mức VU mà p95 tăng vọt hoặc bắt đầu có 5xx. Dự đoán điểm nghẽn đầu tiên là CPU của 2 pod API (request 100m, trên 1 node `t3a.medium` loại burstable, có thể hết CPU credit).
- **spike:** hệ thống có trở lại latency bình thường sau đợt tăng không.
- **soak:** pod có restart không, bộ nhớ có tăng dần không.

Lệnh theo dõi khi chạy:

```bash
kubectl -n streamforge get pods -w
kubectl get nodes -L streamforge.io/pool,node.kubernetes.io/instance-type
# CloudWatch: ALB TargetResponseTime, HTTPCode_Target_5XX_Count; DynamoDB ThrottledRequests
```

### 4.2 Phát HLS (hls.js)

```bash
VIEWERS=50 DURATION=5m ./tests/load/run.sh hls.js
RENDITION=1080p VIEWERS=20 ./tests/load/run.sh hls.js   # cố định rendition
```

Mỗi VU tải `master.m3u8`, chọn một rendition rồi tải từng segment cách nhau 4 giây, như một player thật. Ngưỡng: segment p95 < 1500ms (segment dài 4 giây, phải tải xong nhanh hơn nhiều), playlist p95 < 500ms. Metric `cloudfront_cache_hit` cho biết tỉ lệ request được CloudFront trả từ cache.

### 4.3 Pipeline transcode (pipeline-burst.sh)

```bash
BASE_URL=https://dxxxx.cloudfront.net N=10 ./tests/load/pipeline-burst.sh
```

Script tạo N clip 1080p dài 30 giây cùng lúc, rồi in tiến độ mỗi 15 giây: số video `READY`/`FAILED`, số worker, số node Spot.

Kỳ vọng:
- Worker tăng từ 0 lên tối đa 4 pod.
- Có 1 tới 2 node Spot.
- Mọi video `READY`, DLQ rỗng.
- Sau khi xong, worker và node co về 0 (R4).
- Script tự xoá video test; đặt `CLEANUP=0` để giữ lại.

Mỗi video tốn 2 request ghi, nên với rate limit hiện tại N tối đa khoảng 25.

### 4.4 Rate limit (rate-limit.js)

```bash
./tests/load/run.sh rate-limit.js
```

Script gửi 100 request `POST /api/auth/playback-token` từ 5 VU.

Kỳ vọng:
- Số request được cho qua ≤ 30 × số pod (60 với 2 pod).
- Phần còn lại nhận 429 kèm `Retry-After`.

Chạy kịch bản này cuối cùng: sau đó IP của bạn bị chặn các endpoint ghi trong 10 phút.

## 5. Kết quả lần chạy đầu (16/11/2026, chạy từ Việt Nam)

| Test | Kết quả |
| --- | --- |
| `smoke.sh` | 18/19 PASS. F19 FAIL (xem dưới). Transcode mất 73 giây, gồm cả thời gian cấp node Spot |
| `api.js` smoke | 0% lỗi. list p95 469ms, detail p95 557ms (vượt ngưỡng 500ms) |
| `hls.js` 2 người xem, 20 giây | 0% lỗi. segment p95 1.07s, playlist p95 800ms (vượt ngưỡng 500ms), cache hit 42% |

Latency cao ngay cả với 1 người dùng là do mạng, không phải do tải: request đi qua edge CloudFront ở Milan (`x-amz-cf-pop: MXP53`), riêng bắt tay TCP đã mất 221ms.

## Lỗi đã sửa sau lần chạy đầu

1. **Video đã xoá vẫn xem được qua CloudFront (F19).** Segment có `max-age` 1 năm nên bản cache trên edge vẫn phát được sau khi file trên S3 bị xoá. API giờ gọi `CreateInvalidation` cho `/videos/{videoId}/*` khi xoá video. Invalidation mất 1 tới 5 phút mới có hiệu lực ở mọi edge.
2. **Người dùng ở châu Á bị phục vụ từ edge ở châu Âu.** CloudFront đổi từ `PriceClass_100` sang `PriceClass_200`. Request từ Việt Nam giờ đi qua edge Hong Kong (`HKG54`) thay vì Milan (`MXP53`).
3. **CI fail ở `npm audit`.** zod < 4.6.6 (high) và qs < 6.16.1 (moderate). API nâng lên zod 4 và express 4.22.3.

Đường dẫn HLS đổi từ `/{videoId}/...` sang `/videos/{videoId}/...` khi thêm frontend vào cùng distribution. API luôn tính link từ `CDN_BASE_URL`, nên video cũ vẫn có link đúng.
