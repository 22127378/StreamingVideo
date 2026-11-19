# Đo cold start, ngày 19/11/2026

## Cold start là gì, và đo ở đây gồm những gì

**Cold start** là khoảng thời gian từ lúc hệ thống cần một chương trình mới chạy (một pod dịch vụ, một Job xử lý video) cho tới lúc chương trình đó **làm được việc**. Thời gian này gồm tối đa bốn đoạn:

| Đoạn | Nghĩa | Khi nào tốn thời gian |
| --- | --- | --- |
| Chờ máy | Pod được tạo tới lúc được xếp lên một máy | Khi không còn máy trống, Karpenter phải thuê máy mới |
| Kéo image | Tải gói chương trình (image) từ ECR về máy | Khi máy chưa từng chạy image đó |
| Khởi động | Pod được xếp tới lúc container chạy (gồm kéo image, cấp mạng cho pod) | Luôn có, thường vài giây |
| Sẵn sàng | Container chạy tới lúc qua kiểm tra sức khoẻ (readiness) | Dịch vụ HTTP; health check chạy mỗi 10 giây nên đoạn này thường làm tròn lên tới 10 giây |

**Cách đo.** Mọi mốc thời gian lấy từ chính Kubernetes, chính xác tới giây:
- tạo pod, xếp lên máy, container chạy, sẵn sàng, kết thúc;
- thời gian kéo image trong Event;
- thời điểm tạo máy.

Công cụ:
- `tests/load/coldstart_report.py` đọc các mốc đó và tính từng đoạn.
- `tests/load/worker-coldstart.sh` upload một video thật và đo cả chuỗi xử lý.

**Bối cảnh.** Cụm `streamforge-dev` vừa dựng lại (máy ứng dụng `t3a.medium` on-demand, máy worker Spot `c5.large`/`c7i.large`). Smoke test sau khi dựng: 51/51 đạt (`00-smoke-after-rebuild.log`).

---

## 1. Dịch vụ HTTP và Job migration ở lần deploy đầu (lạnh nhất)

**Đo cái gì.** Lần deploy đầu tiên lên cụm mới: máy vừa được thuê, chưa có image nào trên máy. Đây là trường hợp chậm nhất của dịch vụ HTTP. Nó xảy ra khi dựng lại cụm, hoặc khi Karpenter thay máy.

**Số liệu** (`01-first-deploy-coldstart.txt`):

| Thành phần | Chờ máy | Kéo image | Sẵn sàng | Tổng |
| --- | --- | --- | --- | --- |
| 5 dịch vụ HTTP (10 pod) | 0 s (máy đã có từ bước cài KEDA) | 10 đến 18 s | 10 đến 11 s | **32 đến 37 s** |
| 3 Job migration | 21 đến 23 s (thuê máy mới) | 8 đến 9 s | chạy 15 đến 16 s | **53 đến 59 s** |
| Pod giữ chỗ cho worker (máy Spot mới) | 23 s | 7,6 s | | 50 s |

**Đo để làm gì.** Biết sau khi dựng lại cụm hoặc khi máy bị thay, dịch vụ mất bao lâu mới phục vụ được.

**Phản ánh điều gì.**
- Một dịch vụ HTTP mới tinh cần khoảng **35 giây**, trong đó **kéo image chiếm khoảng một nửa**.
- Image nhỏ hơn thì cold start ngắn hơn rõ rệt.
- Khi cần máy mới, cộng thêm khoảng **20 giây** để Karpenter thuê máy.
- Migration mỗi Job chỉ chạy khoảng 15 giây. Phần còn lại là chờ máy và kéo image.

## 2. Dịch vụ HTTP khởi động lại khi một pod chết

**Đo cái gì.** Xoá 1 pod của mỗi dịch vụ, giống khi một pod bị lỗi hoặc máy bị thu hồi, rồi đo pod thay thế. Pod còn lại vẫn phục vụ nên người dùng không bị gián đoạn. Mình đo hai lần.

**Lần 1: máy có sẵn nhưng chưa có image** (`04-http-restart-warm-node.txt`). Kubernetes đặt pod thay thế sang máy ứng dụng thứ hai, để hai bản của mỗi dịch vụ nằm hai máy khác nhau. Máy đó chưa từng chạy các image này:

| Dịch vụ | Kéo image | Sẵn sàng | Tổng |
| --- | --- | --- | --- |
| account | 14,7 s | 10 s | 29 s |
| upload | 9,5 s | 12 s | 27 s |
| playback | 6,5 s | 10 s | 25 s |
| catalog | 10,5 s | 2 s | 19 s |
| live | 5,5 s | 1 s | 14 s |

**Lần 2: máy đã có image** (`05-http-restart-cached-image.txt`). Xoá lại chính các pod đó, pod thay thế rơi đúng vào máy giờ đã có image:

| Dịch vụ | Khởi động | Sẵn sàng | Tổng |
| --- | --- | --- | --- |
| playback | 1 s | 1 s | **2 s** |
| catalog | 1 s | 11 s | 12 s |
| live | 2 s | 11 s | 13 s |
| account | 5 s | 11 s | 17 s |
| upload | **32 s** | 11 s | **43 s** |

**Đo để làm gì.** Biết hệ thống tự hồi phục nhanh thế nào khi một pod chết.

**Phản ánh điều gì.**
- **Bản thân ứng dụng khởi động rất nhanh** (1 đến 2 giây, ví dụ playback). Phần lớn con số 11 giây ở cột "sẵn sàng" là chờ lần health check kế tiếp (mỗi 10 giây). Giảm chu kỳ kiểm tra, ví dụ 2 đến 3 giây, sẽ rút ngắn khoảng 8 giây cho mọi lần khởi động.
- **Máy chưa có image thì thêm 5 đến 15 giây.**
- **Phát hiện giới hạn thật: pod upload chậm 32 giây vì không có địa chỉ IP.**
  - Event ghi `failed to assign an IP address to container` hai lần, mỗi lần chờ 16 giây.
  - Máy `t3a.medium` chỉ chứa **tối đa 15 pod**. Máy đó đang chạy 12 pod, lại còn các pod cũ đang tắt mà chưa trả IP.
  - Khi đông pod hoặc nhiều pod cùng khởi động lại, việc này sẽ lặp lại.
  - Cách xử lý: dùng loại máy lớn hơn cho nhóm ứng dụng, hoặc bật "prefix delegation" của VPC CNI để mỗi máy có nhiều IP hơn.

## 3. Worker xử lý video: từ lúc upload xong tới lúc video xem được

**Đo cái gì.** Thời gian người dùng thật sự chờ sau khi bấm xác nhận upload, chia thành từng đoạn:
1. KEDA nhận ra có việc và tạo Job.
2. Job có máy, có image và bắt đầu chạy.
3. Worker xử lý video.
4. Video READY.

Clip thử là 1080p, dài 10 giây, 19,8 MB. Mình đo hai kịch bản:
- **Máy ấm:** pod giữ chỗ đang chạy, như trong giờ hoạt động 08:00 đến 24:00.
- **Máy lạnh:** tạm dừng pod giữ chỗ và chờ Karpenter trả hết máy Spot, như ngoài giờ hoạt động. Job phải thuê máy mới và kéo image FFmpeg.

**Số liệu** (`02-worker-warm.log`, `03-worker-cold.log`):

| Đoạn | Máy ấm | Máy lạnh |
| --- | --- | --- |
| Xác nhận upload, tới lúc KEDA tạo Job | 11,0 s | 15,5 s |
| Job tạo, tới lúc worker chạy | **1,0 s** | **50,0 s** (chờ máy 23 s, kéo image 6,1 s, máy khởi động) |
| **Xác nhận upload, tới lúc worker bắt đầu** (cold start người dùng chịu) | **12 s** | **65,5 s** |
| Worker xử lý video | 21 s (`c5.large`) | 14 s (`c7i.large`, máy mới hơn) |
| **Xác nhận upload, tới lúc video READY** | **33,6 s** | **79,7 s** |
| Worker chờ thêm trước khi thoát | 15 s | khoảng 13 s |

**Đo để làm gì.** Có hai mục đích:
- Kiểm chứng pod giữ chỗ (tốn khoảng $15 đến $22 mỗi tháng) có đáng tiền không.
- Biết người dùng chờ bao lâu ở mỗi trường hợp.

**Phản ánh điều gì.**
- **Pod giữ chỗ rút cold start từ 65,5 giây xuống 12 giây** (nhanh hơn khoảng 5 lần). Thời gian tới khi video xem được giảm từ khoảng 80 giây xuống khoảng 34 giây với clip ngắn. Phần tiết kiệm (khoảng 50 giây) là thời gian thuê máy Spot và kéo image.
- **KEDA mất 11 đến 16 giây để nhận ra có việc**, vì nó kiểm tra hàng đợi mỗi 15 giây. Rút xuống 5 giây sẽ bớt trung bình khoảng 5 giây cho mọi video, đổi lại KEDA hỏi SQS nhiều hơn (chi phí rất nhỏ).
- **Thời gian xử lý phụ thuộc loại máy Spot nhận được:** cùng clip, `c7i.large` nhanh hơn `c5.large` khoảng 30%. Karpenter chọn máy theo giá Spot, nên thời gian xử lý sẽ dao động.
- **Worker chờ thêm 15 giây sau khi xong** (`METRICS_LINGER_SECONDS=15`) để Prometheus kịp thu số liệu. Người dùng không phải chờ phần này, vì video đã READY. Nhưng trong 15 giây đó Job vẫn chiếm một trong 4 suất worker, nên khi đông việc sẽ làm giảm thông lượng.

---

## Tóm tắt

| Trường hợp | Cold start | Đoạn tốn thời gian nhất |
| --- | --- | --- |
| Dịch vụ HTTP, máy đã có image | 2 đến 17 s | Chờ health check (mỗi 10 s) |
| Dịch vụ HTTP, máy chưa có image | 14 đến 37 s | Kéo image (5 đến 18 s) |
| Dịch vụ HTTP khi máy hết IP | 43 s | Chờ IP (2 lần thử, 16 s mỗi lần) |
| Job migration, máy mới | 53 đến 59 s | Chờ máy (khoảng 22 s) |
| Worker, máy ấm | 12 s tới khi chạy, 34 s tới khi video xem được | KEDA phát hiện việc (11 s) |
| Worker, máy lạnh | 66 s tới khi chạy, 80 s tới khi video xem được | Thuê máy Spot và khởi động (50 s) |

## Giới hạn của phép đo

- Mỗi trường hợp chỉ đo **một lần**, chưa lặp lại nhiều lần để lấy trung bình. Thời gian thuê máy Spot và kéo image dao động theo thời điểm và loại máy.
- "Sẵn sàng" bị làm tròn theo chu kỳ health check 10 giây, nên thời gian khởi động thật của ứng dụng ngắn hơn số ghi.
- Clip thử ngắn (10 giây). Video dài hơn thì phần xử lý dài hơn, nhưng cold start (phần trước khi worker bắt đầu) không đổi.
- Chưa đo cold start của Aurora khi tỉnh dậy sau khi tự dừng. Cấu hình ghi khoảng 15 giây nhưng lần này chưa đo.
