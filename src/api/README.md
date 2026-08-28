# 🚀 StreamForge - Backend API

Dịch vụ REST API quản lý video, xử lý presigned URL và cấp phát quyền xem video.

## Tính năng chính (Sắp triển khai ở Feature 2):
- `POST /api/videos/upload-url`: Sinh S3 Presigned URL để upload video dung lượng lớn trực tiếp từ browser lên S3.
- `POST /api/videos`: Nhận thông báo upload hoàn tất & đẩy sự kiện vào SQS transcode queue.
- `GET /api/videos`: Lấy danh sách video cùng trạng thái (UPLOADING, PROCESSING, READY, FAILED).
- `GET /api/videos/:id`: Lấy chi tiết metadata và playlist stream HLS.
- `POST /api/auth/token`: Cấp token mô phỏng signed cookies cho playback phân quyền.
