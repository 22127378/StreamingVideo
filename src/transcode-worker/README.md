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

Nếu một bước lỗi, video bị đánh dấu `FAILED` và message được giữ lại để SQS thử lại. Sau 3 lần thất bại, message chuyển sang DLQ.

## Chạy

```bash
cd src/transcode-worker
npm install
npm test        # kiểm tra binary FFmpeg, chọn profile, master playlist
npm run dev     # hoặc npm start
```

Các biến môi trường riêng của worker (đều không bắt buộc): `SQS_POLLING_WAIT_TIME` (mặc định 10), `SQS_MAX_MESSAGES` (1), `SQS_VISIBILITY_TIMEOUT` (300), `SQS_HEARTBEAT_INTERVAL` (120, phải nhỏ hơn visibility timeout).
