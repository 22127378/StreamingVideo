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
| GET | `/api/videos` | Danh sách video, mới nhất trước. Video `READY` có `streamingUrl` và `thumbnailUrl` |
| GET | `/api/videos/:id` | Chi tiết một video |
| DELETE | `/api/videos/:id` | Xoá video cùng file gốc và file HLS trên S3. Trả 409 khi video đang `PROCESSING` |
| POST | `/api/auth/playback-token` | Cấp JWT 4 giờ cho gói `free` hoặc `premium`, dùng cho một video (`videoId`) hoặc mọi video |
| POST | `/api/auth/verify-playback` | Kiểm tra token có được xem video chỉ định hay không |

Trạng thái video đi theo thứ tự `UPLOADING`, `PROCESSING`, rồi `READY` hoặc `FAILED`. Trong lúc xoá, video ở trạng thái `DELETING`; nếu xoá file trên S3 bị lỗi, gọi DELETE lại là được.

### Danh sách và phân trang

`GET /api/videos` nhận các tham số:

- `limit`: 1 đến 100, mặc định 20.
- `status`: lọc theo `UPLOADING`, `PROCESSING`, `READY` hoặc `FAILED`.
- `nextToken`: lấy từ response trước để đọc trang tiếp theo. Response trả `nextToken: null` khi đã hết.

Danh sách đọc từ GSI `entityType-createdAt-index`. Khi lọc theo `status`, một trang có thể ít hơn `limit` phần tử dù vẫn còn trang sau, vì DynamoDB áp dụng `limit` trước khi lọc. Hãy dựa vào `nextToken`, đừng dựa vào số phần tử.

### Xác minh quyền xem

`verify-playback` cần header `Authorization: Bearer <token>` và body `{ "videoId": "..." }`. Kết quả:

| Mã | Khi nào |
| --- | --- |
| 200 | Được phép xem |
| 401 | Thiếu token, token sai chữ ký, sai issuer hoặc hết hạn |
| 403 | Token cấp cho video khác, hoặc video premium mà token là gói free |
| 404 | Video không tồn tại |
| 409 | Video chưa `READY` |

Phần playback token chỉ là mô phỏng: ai cũng xin được token premium. Trên cloud, phần này sẽ được thay bằng đăng nhập thật và CloudFront signed cookies. Khi `NODE_ENV=production`, API không khởi động nếu thiếu `JWT_SECRET` hoặc secret ngắn hơn 32 ký tự.

File `api.http` có sẵn request mẫu cho từng bước, mở được bằng REST Client của VS Code.
