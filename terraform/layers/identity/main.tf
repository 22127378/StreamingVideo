# IAM policy cho API và worker, cộng dev role để chạy chúng trên máy với đúng quyền đó.
# Tìm tài nguyên theo tên (quy ước đặt tên của layer storage và messaging), nên không phụ thuộc
# vào state của layer khác. Áp dụng sau storage và messaging.

locals {
  layer = "identity"
}

variable "create_dev_roles" {
  type    = bool
  default = true
}

variable "dev_role_trusted_principals" {
  description = "IAM principal ARNs allowed to assume the dev roles. Empty means any principal in this account that has sts:AssumeRole"
  type        = list(string)
  default     = []
}

data "aws_s3_bucket" "raw" {
  bucket = "${local.name_prefix}-raw-${local.account_id}"
}

data "aws_s3_bucket" "processed" {
  bucket = "${local.name_prefix}-processed-${local.account_id}"
}

data "aws_dynamodb_table" "videos" {
  name = "${local.name_prefix}-videos"
}

data "aws_sqs_queue" "transcode" {
  name = "${local.name_prefix}-transcode"
}

module "app_iam" {
  source = "../../modules/app-iam"

  name_prefix                 = local.name_prefix
  raw_bucket_arn              = data.aws_s3_bucket.raw.arn
  processed_bucket_arn        = data.aws_s3_bucket.processed.arn
  table_arn                   = data.aws_dynamodb_table.videos.arn
  queue_arn                   = data.aws_sqs_queue.transcode.arn
  create_dev_roles            = var.create_dev_roles
  dev_role_trusted_principals = var.dev_role_trusted_principals
}

output "api_policy_arn" {
  value = module.app_iam.api_policy_arn
}

output "worker_policy_arn" {
  value = module.app_iam.worker_policy_arn
}

output "dev_role_arns" {
  value = module.app_iam.dev_role_arns
}

output "dotenv" {
  description = "Values for .env when running the API and worker locally against this AWS account"
  value       = <<-EOT
    AWS_REGION=${var.aws_region}
    AWS_ENDPOINT_URL=
    AWS_S3_PUBLIC_ENDPOINT=
    AWS_S3_FORCE_PATH_STYLE=false
    S3_RAW_UPLOADS_BUCKET=${data.aws_s3_bucket.raw.id}
    S3_PROCESSED_BUCKET=${data.aws_s3_bucket.processed.id}
    SQS_TRANSCODE_QUEUE_URL=${data.aws_sqs_queue.transcode.url}
    DYNAMODB_VIDEOS_TABLE=${data.aws_dynamodb_table.videos.name}
  EOT
}
