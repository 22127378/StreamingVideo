# Bucket video (raw và processed) và bảng metadata.

locals {
  layer = "storage"
}

variable "cors_allowed_origins" {
  description = "Browser origins allowed to upload to the raw bucket and fetch HLS from the processed bucket"
  type        = list(string)
  default     = ["http://localhost:5173"]
}

variable "raw_upload_retention_days" {
  description = "Delete source uploads after this many days (HLS output is kept). null keeps them"
  type        = number
  default     = null
}

variable "allow_destroy_with_data" {
  description = "Let terraform destroy remove non-empty buckets and the table. Keep false outside throwaway environments"
  type        = bool
  default     = false
}

module "raw_bucket" {
  source = "../../modules/s3"

  bucket_name       = "${local.name_prefix}-raw-${local.account_id}"
  force_destroy     = var.allow_destroy_with_data
  expire_after_days = var.raw_upload_retention_days
  expire_prefix     = "raw/"

  # Browser PUT thẳng lên presigned URL
  cors_rules = [{
    allowed_methods = ["PUT"]
    allowed_origins = var.cors_allowed_origins
  }]
}

module "processed_bucket" {
  source = "../../modules/s3"

  bucket_name   = "${local.name_prefix}-processed-${local.account_id}"
  force_destroy = var.allow_destroy_with_data

  # Người xem tải HLS qua CloudFront (layer delivery), bucket vẫn private
  allow_cloudfront_read = true

  # Player đọc playlist và segment (khi đi qua CloudFront thì CloudFront chuyển tiếp header CORS)
  cors_rules = [{
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    expose_headers  = ["ETag", "Content-Length", "Content-Range"]
  }]
}

module "videos_table" {
  source = "../../modules/dynamodb"

  table_name          = "${local.name_prefix}-videos"
  deletion_protection = !var.allow_destroy_with_data
}

output "raw_bucket" {
  value = module.raw_bucket.id
}

output "processed_bucket" {
  value = module.processed_bucket.id
}

output "processed_bucket_regional_domain_name" {
  value = module.processed_bucket.regional_domain_name
}

output "videos_table" {
  value = module.videos_table.name
}

output "videos_created_at_index" {
  value = module.videos_table.created_at_index_name
}
