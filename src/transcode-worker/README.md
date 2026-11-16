# StreamForge transcode worker

Worker đọc job từ SQS và chuyển video gốc thành HLS nhiều mức bitrate bằng FFmpeg.

## Một job đi qua những bước nào

1. Long polling hàng đợi `streamforge-transcode-queue`. Trong lúc xử lý, worker gia hạn visibility timeout mỗi 120 giây để video dài không bị một worker khác nhận trùng.
2. Tải video gốc từ bucket raw về thư mục `temp/`.
3. Dùng ffprobe đọc độ dài, kích thước, fps và góc xoay. Video quay dọc bằng điện thoại được tính theo kích thước hiển thị sau khi xoay.
4. Chụp thumbnail JPG cao 720px ở giây thứ 2, hoặc ở giữa video nếu video ngắn hơn 2 giây.
5. Transcode sang các profile phù hợp với nguồn. Profile được chọn theo cạnh ngắn của video, không upscale và giữ nguyên tỷ lệ khung hình:

   | Profile | Cạnh ngắn | Video bitrate |
   | --- | --- | --- |
   | 1080p | 1080 px | 4500 kbps |
   | 720p | 720 px | 2500 kbps |
   | 480p | 480 px | 1200 kbps |
   | 360p | 360 px | 800 kbps |

   Output dùng H.264 (yuv420p) và AAC, chia segment `.ts` dài 4 giây, keyframe mỗi 2 giây theo fps thật của nguồn.
6. Ghi `master.m3u8` liệt kê các rendition với độ phân giải thật, để player tự đổi chất lượng theo tốc độ mạng.
7. Upload playlist, segment và thumbnail lên bucket processed. Playlist đặt `no-cache`, segment được cache một năm.
8. Cập nhật DynamoDB sang `READY`, xoá message khỏi queue và dọn thư mục tạm.

Nếu một bước lỗi, video vẫn ở `PROCESSING` kèm `lastError` và `attempt`, còn message được hẹn giờ quay lại queue sau 30 giây, rồi 60 giây. Đến lần thứ 3 vẫn lỗi thì video chuyển sang `FAILED` và SQS đưa message vào DLQ ngay. Message có body không hợp lệ hoặc thiếu `videoId`/`rawS3Key` thì bị bỏ qua và cũng đi vào DLQ sau 3 lần.

Khi nhận SIGTERM hoặc SIGINT, worker ngừng nhận job mới và chờ job đang chạy tối đa 25 giây. Hết thời gian đó (hoặc khi nhận tín hiệu lần hai), worker kill ffmpeg, dọn thư mục tạm và trả message về queue để worker khác nhận ngay. Video không bị đánh dấu lỗi trong trường hợp này.

Khi upload kết quả, segment được đọc dạng stream, tối đa 8 file cùng lúc. Playlist được upload sau cùng để player không đọc phải playlist trỏ tới segment chưa có.

## Chạy

```bash
cd src/transcode-worker
npm install
npm test        # kiểm tra binary FFmpeg, chọn profile, master playlist
npm run dev     # hoặc npm start
```

Các biến môi trường riêng của worker, đều không bắt buộc:

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `SQS_POLLING_WAIT_TIME` | 10 | Số giây long poll |
| `SQS_MAX_MESSAGES` | 1 | Số message nhận mỗi lần poll |
| `SQS_VISIBILITY_TIMEOUT` | 300 | Visibility timeout khi nhận message |
| `SQS_HEARTBEAT_INTERVAL` | 120 | Chu kỳ gia hạn visibility, phải nhỏ hơn visibility timeout |
| `SQS_MAX_RECEIVE_COUNT` | 3 | Phải khớp `maxReceiveCount` của redrive policy |
| `SQS_RETRY_DELAY` | 30 | Lần thử thứ n chờ n lần số giây này |
| `SHUTDOWN_GRACE_SECONDS` | 25 | Thời gian chờ job hiện tại khi tắt worker |
| `S3_UPLOAD_CONCURRENCY` | 8 | Số file upload song song |
| `FFMPEG_PATH`, `FFPROBE_PATH` | (trống) | Đường dẫn binary. Docker image đặt sẵn `/usr/bin/ffmpeg` của Debian |

Khi không đặt `FFMPEG_PATH`/`FFPROBE_PATH`, worker dùng binary trong package `@ffmpeg-installer` (optionalDependencies, chỉ để dev trên máy cho tiện), không có thì tìm `ffmpeg` trong `PATH`. Bản ffmpeg đi kèm package này đã cũ và ffprobe của nó từng bị segfault khi đọc file `.ts`, nên nếu máy đã cài ffmpeg thì nên đặt hai biến này.
