# StreamForge Terraform

Hạ tầng AWS cho StreamForge, chia thành các layer áp dụng độc lập theo thứ tự trong bảng.

| Layer | Tạo gì | Phụ thuộc | Chi phí khi không có traffic |
| --- | --- | --- | --- |
| `backend` | Bucket chứa state (versioning, mã hoá KMS, chỉ cho TLS) và AWS Budget alarm | Không. State của layer này nằm trên máy | ~$1/tháng (KMS) |
| `storage` | Bucket `raw` và `processed` (CloudFront đọc qua OAC), bảng DynamoDB `videos` với GSI `entityType-createdAt-index` | `backend` | Gần 0 |
| `messaging` | SQS `transcode` và DLQ (`maxReceiveCount` 3, visibility 300s) | `backend` | Gần 0 |
| `identity` | IAM policy tối thiểu quyền cho API và worker, cộng hai dev role | `storage`, `messaging` | 0 |
| `networking` | VPC 2 AZ, subnet public/private, 1 NAT gateway | `backend` | ~$33/tháng (NAT) |
| `compute` | EKS Auto Mode, ECR, security group ALB chỉ mở cho CloudFront, Pod Identity cho API, worker và KEDA | `networking`, `identity` | ~$73/tháng (control plane) cộng node |
| `delivery` | CloudFront: HLS từ bucket `processed`, `/api/*` tới ALB | `compute` và Ingress của API | Gần 0, tính theo traffic |

Ứng dụng chạy trên EKS được deploy bằng `k8s/deploy.sh` (xem mục "Deploy ứng dụng" bên dưới).

Khoá state dùng S3 lockfile (`use_lockfile`, Terraform 1.10 trở lên) thay vì bảng DynamoDB.

Tên tài nguyên theo dạng `streamforge-<environment>-...`, bucket có thêm account ID để tên là duy nhất. Layer `identity` tìm tài nguyên theo tên này, không đọc state của layer khác.

## Yêu cầu

- Terraform 1.10 trở lên.
- AWS credentials có quyền tạo S3, KMS, DynamoDB, SQS, IAM và Budgets (ví dụ chạy `aws login`).

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

./k8s/deploy.sh      # build + push image lên ECR, NodePool, KEDA, API, worker; in ra DNS của ALB

cd terraform/layers/delivery
terraform init -backend-config=../../backend.hcl
terraform apply -var "api_alb_dns_name=<DNS của ALB>"
cd -
SKIP_BUILD=1 ./k8s/deploy.sh    # trỏ CDN_BASE_URL sang CloudFront
```

Sau đó API nằm ở `https://<cloudfront-domain>/api/...` và link phát HLS ở `https://<cloudfront-domain>/<videoId>/master.m3u8`.

- Pod: API (2 replica) chạy trên NodePool `streamforge-app` gồm node on-demand t3/t3a. Worker chạy trên NodePool `streamforge-transcode` gồm node Spot, có taint riêng.
- KEDA đọc độ dài queue và co giãn worker từ 0 đến 4 pod. Khi không có job, node Spot bị thu hồi sau 2 phút.
- Nếu `aws login` không dùng được cho backend S3 của Terraform, dùng một profile có `credential_process = aws configure export-credentials --format process`.

Tắt hẳn để không tốn tiền: `terraform destroy` lần lượt các layer `delivery`, `compute`, `networking`. Trước khi destroy `compute`, xoá Ingress (`kubectl delete ns streamforge`) để ALB do Kubernetes tạo được gỡ trước. Các layer còn lại gần như không tốn tiền nên có thể giữ.

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
