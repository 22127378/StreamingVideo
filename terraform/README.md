# StreamForge Terraform

Hạ tầng AWS cho StreamForge, chia thành các layer áp dụng độc lập theo thứ tự trong bảng.

| Layer | Tạo gì | Phụ thuộc | Chi phí khi không có traffic |
| --- | --- | --- | --- |
| `backend` | Bucket chứa state (versioning, mã hoá KMS, chỉ cho TLS) và AWS Budget alarm | Không. State của layer này nằm trên máy | ~$1/tháng (KMS) |
| `storage` | Bucket `raw` và `processed` (CloudFront đọc qua OAC), bảng DynamoDB `videos` cũ (dữ liệu đã chuyển sang Aurora, sẽ gỡ) | `backend` | Gần 0 |
| `messaging` | SQS `transcode` và DLQ (`maxReceiveCount` 3, visibility 300s) | `backend` | Gần 0 |
| `identity` | IAM policy tối thiểu quyền cho API và worker, cộng hai dev role | `storage`, `messaging` | 0 |
| `networking` | VPC 2 AZ, subnet public/private, 1 NAT gateway | `backend` | ~$33/tháng (NAT) |
| `compute` | EKS Auto Mode, ECR, security group ALB chỉ mở cho CloudFront, Pod Identity cho API, worker và KEDA | `networking`, `identity` | ~$73/tháng (control plane) cộng node |
| `auth` | Cognito user pool (tier LITE), app client cho SRP, group `premium` và `admin`. Mật khẩu tối thiểu 8 ký tự | `compute` | Miễn phí tới 10.000 user/tháng |
| `database` | Aurora PostgreSQL 17 Serverless v2 (0.5 đến 4 ACU), bắt buộc TLS, IAM auth cho user `streamforge_api` và `streamforge_worker`, mật khẩu master trong Secrets Manager | `networking`, `compute` | ~$45/tháng (0.5 ACU luôn chạy) cộng storage |
| `observability` | SNS topic gửi email cảnh báo, bucket Loki, Pod Identity cho Loki, Alertmanager và Grafana, log CloudFront vào CloudWatch, alarm DLQ, queue bị kẹt và CloudFront 5xx (gửi qua EventBridge để email dễ đọc) | `compute`, `delivery` | Vài USD/tháng |
| `delivery` | Bucket `web` cho frontend và CloudFront: `/` là frontend, `/api/*` và `/grafana*` tới ALB, `/videos/*` là HLS từ bucket `processed` (CloudFront Function bỏ tiền tố `/videos`), cần signed cookie từ key group. Thumbnail để public. `PriceClass_200` để có edge ở châu Á | `compute` và Ingress của API | Gần 0, tính theo traffic |

Ứng dụng chạy trên EKS được deploy bằng `k8s/deploy.sh` (xem mục "Deploy ứng dụng" bên dưới).

Khoá state dùng S3 lockfile (`use_lockfile`, Terraform 1.10 trở lên) thay vì bảng DynamoDB.

Tên tài nguyên theo dạng `streamforge-<environment>-...`, bucket có thêm account ID để tên là duy nhất. Layer `identity` tìm tài nguyên theo tên này, không đọc state của layer khác.

## Yêu cầu

- Terraform 1.10 trở lên.
- AWS credentials có quyền tạo S3, KMS, SQS, IAM, Budgets, EKS, RDS, Cognito, CloudFront và CloudWatch (ví dụ chạy `aws login`).

## Áp dụng lần đầu

```bash
cd terraform/layers/backend
cp terraform.tfvars.example terraform.tfvars    # điền email nhận cảnh báo chi phí
terraform init
terraform apply
terraform output -raw backend_hcl > ../../backend.hcl

for layer in storage messaging identity; do
  (cd ../$layer && terraform init -backend-config=../../backend.hcl && terraform apply)
done
```

AWS gửi email xác nhận cho từng địa chỉ trong `budget_alert_emails`. Phải bấm xác nhận thì mới nhận được cảnh báo.

`terraform.tfvars` và `backend.hcl` chứa email và account ID nên đã nằm trong `.gitignore`. Chỉ commit các file `.example`.

## Chạy API và worker trên máy với AWS thật

```bash
cd terraform/layers/identity
terraform output -raw dotenv          # dán vào .env ở thư mục gốc
terraform output -json dev_role_arns
```

Trong `.env`, xoá hai dòng `AWS_ACCESS_KEY_ID` và `AWS_SECRET_ACCESS_KEY` (giá trị `test` của LocalStack). Nếu không, AWS SDK sẽ dùng chúng thay cho credentials thật.

Để chạy với đúng quyền production thay vì quyền admin của bạn, thêm profile assume dev role vào `~/.aws/config`:

```ini
[profile streamforge-api-dev]
role_arn       = arn:aws:iam::<account-id>:role/streamforge-dev-api-dev
source_profile = default
```

rồi chạy `AWS_PROFILE=streamforge-api-dev npm run dev` trong `src/api` (tương tự với `worker`). Thiếu quyền nào thì request sẽ báo `AccessDenied`, đúng như khi chạy trên EKS.

Bucket `processed` là private, nên `streamingUrl` chưa phát được trên AWS thật cho tới khi có CloudFront. Luồng upload, transcode, `READY` và xoá vẫn chạy đầy đủ.

## Deploy ứng dụng lên EKS

```bash
for layer in networking compute; do
  (cd terraform/layers/$layer && terraform init -backend-config=../../backend.hcl && terraform apply)
done

for layer in auth database; do
  (cd terraform/layers/$layer && terraform init -backend-config=../../backend.hcl && terraform apply)
done

./k8s/deploy.sh      # build + push image lên ECR, NodePool, KEDA, migrate DB, API, worker; in ra DNS của ALB

cd terraform/layers/delivery
terraform init -backend-config=../../backend.hcl
terraform apply -var "api_alb_dns_name=<DNS của ALB>"
cd -
SKIP_BUILD=1 ./k8s/deploy.sh    # trỏ CDN_BASE_URL sang CloudFront
./src/frontend/deploy.sh        # build và đẩy frontend lên bucket web

(cd terraform/layers/observability && terraform init -backend-config=../../backend.hcl && terraform apply)
./k8s/monitoring/install.sh     # Prometheus, Loki, Alloy, Grafana tại /grafana
```

Layer `delivery` và `observability` đọc nhau qua biến trong `terraform.tfvars` (DNS của ALB, ID của distribution), không đọc state của nhau.

Sau đó frontend nằm ở `https://<cloudfront-domain>/`, API ở `https://<cloudfront-domain>/api/...` và link phát HLS ở `https://<cloudfront-domain>/videos/<videoId>/master.m3u8`.

- Pod: API (2 replica) chạy trên NodePool `streamforge-app` gồm node on-demand t3/t3a. Worker chạy trên NodePool `streamforge-transcode` gồm node Spot, có taint riêng.
- KEDA đọc độ dài queue và co giãn worker từ 1 đến 4 pod. Một worker luôn chạy sẵn để không phải chờ node Spot khởi động; đặt `WORKER_MIN_REPLICAS=0` khi chạy `deploy.sh` để co về 0 và tiết kiệm khoảng $22/tháng.
- Mỗi lần deploy chạy Job `streamforge-db-migrate`: áp file trong `src/api/src/db/migrations`, tạo hai user IAM cho API và worker. Xem log bằng `kubectl -n streamforge logs job/streamforge-db-migrate`.
- `deploy.sh` bỏ qua bước cài KEDA nếu bản đang chạy đã đúng phiên bản. Đặt `FORCE_KEDA=1` để cài lại (ví dụ khi đổi value của chart).
- Nếu `aws login` không dùng được cho backend S3 của Terraform, dùng một profile có `credential_process = aws configure export-credentials --format process`.

Tắt hẳn để không tốn tiền: `terraform destroy` lần lượt các layer `observability`, `delivery`, `database`, `auth`, `compute`, `networking`. Aurora tạo snapshot cuối trước khi xoá. Trước khi destroy `compute`, xoá Ingress (`kubectl delete ns streamforge`) để ALB do Kubernetes tạo được gỡ trước. Các layer còn lại gần như không tốn tiền nên có thể giữ.

## Kiểm tra trước khi áp dụng

```bash
terraform fmt -check -recursive
cd layers/<layer> && terraform init -backend=false && terraform validate
```

CI chạy hai lệnh này cho mọi layer.

Bộ cấu hình này đã được `apply` thử lên LocalStack 4.4 (bật thêm IAM, KMS, STS) bằng file `*_override.tf` trỏ endpoint sang LocalStack. Chạy `plan` lần hai không ra thay đổi nào, và API cùng worker chạy được trên các tài nguyên đó. Hai giới hạn khi thử như vậy:

- LocalStack bản community không thực thi IAM, nên quyền tối thiểu của các policy phải kiểm tra trên AWS thật.
- AWS provider 6.x đọc tag của bucket qua S3 Control, mà LocalStack 4.4 chưa hỗ trợ API này. Khi thử với LocalStack, ghim provider về `~> 5.0` trong file override.

## Xoá

Thứ tự ngược lại: `identity`, `messaging`, `storage`, rồi `backend`.

- Bảng DynamoDB bật deletion protection và bucket không xoá được khi còn object. Với môi trường dùng xong là bỏ, apply `storage` với `-var allow_destroy_with_data=true` trước khi destroy.
- Bucket state có `prevent_destroy`, nên muốn xoá phải sửa code. Đây là chủ ý.
