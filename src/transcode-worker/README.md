# ⚙️ StreamForge - Transcode Worker

Worker xử lý chuyển đổi định dạng video sang chuẩn Adaptive Bitrate HLS bằng FFmpeg.

## Tính năng chính (Sắp triển khai ở Feature 3):
- Lắng nghe job từ **SQS Queue** (`streamforge-transcode-queue`).
- Tải video gốc từ **S3 Raw Uploads Bucket**.
- Dùng **FFmpeg** tạo Adaptive Bitrate HLS đa độ phân giải (`1080p`, `720p`, `480p`, `360p`) và file `master.m3u8`.
- Tự động trích xuất Thumbnail ảnh đại diện tại giây thứ 2.
- Upload toàn bộ file chunk `.ts` và playlist `.m3u8` lên **S3 Processed Bucket**.
- Cập nhật trạng thái `READY` lên **DynamoDB**.
- Hỗ trợ cơ chế retry và Dead Letter Queue (DLQ) khi xảy ra lỗi.
