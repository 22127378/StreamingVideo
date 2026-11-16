# StreamForge API

REST API quản lý video: cấp presigned URL để upload, lưu metadata trong DynamoDB, đẩy job transcode vào SQS và cấp token xem video theo gói free/premium.

## Chạy

```bash
cd src/api
npm install
npm run dev     # http://localhost:4000, tự reload khi sửa code
npm test
```

API đọc cấu hình từ file `.env` ở thư mục gốc repo (xem `.env.example`). LocalStack phải đang chạy (`docker compose up -d`).

## Endpoint

| Method | Path | Việc làm |
| --- | --- | --- |
| GET | `/health` | Kiểm tra service còn sống |
| POST | `/api/videos/upload-url` | Tạo bản ghi `UPLOADING` và trả về presigned PUT URL để browser upload thẳng lên S3 |
| POST | `/api/videos/complete` | Xác nhận đã upload xong. API kiểm tra file có trên S3, chuyển trạng thái sang `PROCESSING` rồi gửi job vào SQS. Gọi lại lần hai sẽ nhận 409 |
| GET | `/api/videos` | Danh sách video. Video `READY` có thêm `streamingUrl` và `thumbnailUrl` |
| GET | `/api/videos/:id` | Chi tiết một video |
| DELETE | `/api/videos/:id` | Xoá bản ghi trong DynamoDB (chưa xoá file trên S3) |
| POST | `/api/auth/playback-token` | Cấp JWT 4 giờ cho gói `free` hoặc `premium` |
| POST | `/api/auth/verify-playback` | Kiểm tra token có được xem video chỉ định hay không |

Trạng thái video đi theo thứ tự `UPLOADING`, `PROCESSING`, rồi `READY` hoặc `FAILED`.

File `api.http` có sẵn request mẫu cho từng bước, mở được bằng REST Client của VS Code.

Phần playback token chỉ là mô phỏng: ai cũng xin được token premium. Trên cloud, phần này sẽ được thay bằng CloudFront signed cookies.
