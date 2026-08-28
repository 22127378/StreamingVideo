# ⚙️ StreamForge - Transcode Worker

Dịch vụ Worker xử lý video theo kiến trúc hướng sự kiện (Event-driven Architecture), tự động chuyển đổi file video gốc thành định dạng **Adaptive Bitrate HLS (HTTP Live Streaming)** bằng **FFmpeg**.

---

## 🌟 Tính năng Cốt lõi

1. **Lắng nghe sự kiện từ SQS Queue**: Tiêu thụ message từ hàng đợi `streamforge-transcode-queue` qua cơ chế Long Polling.
2. **Tải dữ liệu từ S3 Raw Bucket**: Tải video gốc tự động về bộ nhớ tạm (`temp/`).
3. **Phân tích kỹ thuật qua FFprobe**: Trích xuất độ dài, tỷ lệ khung hình, độ phân giải gốc để tối ưu cấu hình transcode.
4. **Trích xuất Thumbnail tự động**: Chụp ảnh đại diện JPG độ nét cao (1280x720) tại giây thứ 2.
5. **Adaptive Bitrate Transcoding (HLS)**: Chuyển đổi song song/tuần tự sang các profile phân giải:
   - **1080p (Full HD)**: 4500 kbps, 1920x1080
   - **720p (HD)**: 2500 kbps, 1280x720
   - **480p (SD)**: 1200 kbps, 854x480
   - **360p (Low)**: 800 kbps, 640x360
   - Phân đoạn video thành các file `.ts` dài 4 giây và tạo playlist con tương ứng.
6. **Sinh Master Playlist (`master.m3u8`)**: Ghép nối các dải bitrate theo chuẩn HLS RFC 8216 để trình phát (Player) tự động chuyển đổi chất lượng theo tốc độ mạng của người xem.
7. **Upload lên S3 Processed Bucket**: Đẩy toàn bộ playlist và segment `.ts` lên S3 với đúng định dạng MIME type và thiết lập cache control.
8. **Cập nhật Database & Dọn dẹp**: Cập nhật trạng thái `READY` lên DynamoDB và xóa file tạm giải phóng ổ đĩa.

---

## 🚀 Hướng dẫn Chạy Worker

### 1. Cài đặt dependencies
```bash
cd src/transcode-worker
npm install
```

### 2. Chạy Unit Test kiểm tra FFmpeg
```bash
npm test
```

### 3. Khởi động Worker
```bash
npm start
# Hoặc chế độ dev tự reload khi đổi code:
npm run dev
```
