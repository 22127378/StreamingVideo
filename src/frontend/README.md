# StreamForge frontend

Trang web một màn hình (React + Vite) để upload, theo dõi và xem video. Phát HLS bằng hls.js (bản light), có chọn chất lượng; trên Safari iOS dùng HLS của trình duyệt.

Chức năng:

- Upload bằng kéo thả hoặc chọn file, có thanh tiến trình. File được PUT thẳng lên S3 qua presigned URL; kích thước và kiểu file đã được ký nên S3 từ chối file khác với lúc khai báo.
- Thư viện video có trạng thái (chờ upload, đang xử lý, sẵn sàng, lỗi), tự làm mới mỗi 5 giây khi còn video đang xử lý, có nút "Xem thêm" để phân trang và nút xoá.
- Chọn gói xem Free hoặc Premium ở góc trên để mô phỏng tài khoản. Trước khi phát, trang xin token theo gói rồi gọi `verify-playback`; video Premium với gói Free sẽ hiện thông báo khoá.

## Chạy trên máy

```bash
cd src/frontend
npm install
npm run dev          # http://localhost:5173, /api chuyển tới http://localhost:4000
```

Các service phải đang chạy (`docker compose --profile app up -d --build`, gateway ở cổng 4000). Đặt `API_URL` để trỏ `/api` tới chỗ khác. Bucket raw phải cho phép origin `http://localhost:5173` trong CORS (LocalStack đã mở sẵn).

## Deploy

```bash
./src/frontend/deploy.sh
```

Script build rồi đồng bộ `dist/` lên bucket `web` của layer Terraform `delivery`: file trong `assets/` cache 1 năm (tên có hash), `index.html` để `no-cache`, sau đó invalidate `/index.html` trên CloudFront.

Trang được phục vụ ở gốc domain CloudFront, cùng domain với API (`/api/*`) và HLS (`/videos/*`), nên không cần CORS cho API.
