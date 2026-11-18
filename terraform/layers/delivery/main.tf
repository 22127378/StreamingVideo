# CloudFront trước toàn bộ hệ thống:
#   /api/*     -> ALB của API (do EKS Auto Mode tạo từ Ingress), không cache
#   /grafana*  -> cùng ALB, Grafana (k8s/monitoring), không cache
#   /videos/*  -> bucket processed qua Origin Access Control (HLS: master.m3u8, *.ts, thumbnail.jpg).
#                 CloudFront Function bỏ tiền tố /videos, nên object trên S3 vẫn là {videoId}/...
#   còn lại    -> bucket web (frontend, build từ src/frontend)
# ALB chỉ nhận traffic từ dải IP origin-facing của CloudFront (security group ở layer compute).
#
# Áp dụng sau khi Ingress của API đã có ALB:
#   terraform apply -var "api_alb_dns_name=$(kubectl -n streamforge get ingress streamforge-api \
#     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')"
#
# Chưa làm: domain riêng + ACM.
# CloudFront nói chuyện với ALB bằng HTTP vì ALB chưa có chứng chỉ (cần domain riêng).

locals {
  layer = "delivery"
}

variable "api_alb_dns_name" {
  description = "DNS name of the API ALB created by the streamforge-api Ingress"
  type        = string
}

variable "price_class" {
  description = "PriceClass_200 adds Asia (Vietnam users were routed to Europe with PriceClass_100). PriceClass_100 is the cheapest"
  type        = string
  default     = "PriceClass_200"
}

data "aws_s3_bucket" "processed" {
  bucket = "${local.name_prefix}-processed-${local.account_id}"
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_origin_request_policy" "cors_s3" {
  name = "Managed-CORS-S3Origin"
}

data "aws_cloudfront_response_headers_policy" "cors" {
  name = "Managed-SimpleCORS"
}

data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

# Frontend tĩnh (Vite build). Chỉ CloudFront đọc được.
module "web_bucket" {
  source = "../../modules/s3"

  bucket_name           = "${local.name_prefix}-web-${local.account_id}"
  force_destroy         = true # chỉ chứa file build, tạo lại được
  allow_cloudfront_read = true
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name_prefix}-web"
  description                       = "Read the frontend build from the private web bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# /videos/{id}/master.m3u8 -> {id}/master.m3u8 trên bucket processed
resource "aws_cloudfront_function" "strip_videos_prefix" {
  name    = "${local.name_prefix}-strip-videos-prefix"
  runtime = "cloudfront-js-2.0"
  comment = "Map /videos/* to the processed bucket root"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      request.uri = request.uri.replace(/^\/videos/, '') || '/';
      return request;
    }
  EOT
}

resource "aws_cloudfront_origin_access_control" "processed" {
  name                              = "${local.name_prefix}-processed"
  description                       = "Read HLS output from the private processed bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Khoá ký CloudFront signed cookies. Private key nằm trong state Terraform (S3, mã hoá KMS) và
# được k8s/deploy.sh đưa vào secret của pod API. Đổi khoá: terraform apply -replace=tls_private_key.playback
resource "tls_private_key" "playback" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_cloudfront_public_key" "playback" {
  name        = "${local.name_prefix}-playback"
  comment     = "Verifies signed cookies issued by the API for HLS playback"
  encoded_key = tls_private_key.playback.public_key_pem
}

resource "aws_cloudfront_key_group" "playback" {
  name    = "${local.name_prefix}-playback"
  comment = "Keys trusted for /videos/* signed cookies"
  items   = [aws_cloudfront_public_key.playback.id]
}

resource "aws_cloudfront_distribution" "this" {
  #checkov:skip=CKV_AWS_86:Access logs go to CloudWatch Logs through vended log delivery v2 (layer observability), not the legacy logging_config block
  #checkov:skip=CKV_AWS_174:No custom domain; the default *.cloudfront.net certificate cannot set a minimum TLS version
  #checkov:skip=CKV2_AWS_42:No custom domain, so no ACM certificate
  #checkov:skip=CKV_AWS_310:Single region by design; S3 and ALB origins have no secondary to fail over to
  #checkov:skip=CKV_AWS_374:The service has no country restrictions
  enabled         = true
  comment         = "${local.name_prefix}: HLS playback and API"
  price_class     = var.price_class
  is_ipv6_enabled = true
  http_version    = "http2and3"

  default_root_object = "index.html"

  origin {
    origin_id                = "web-s3"
    domain_name              = module.web_bucket.regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id                = "processed-s3"
    domain_name              = data.aws_s3_bucket.processed.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.processed.id
  }

  origin {
    origin_id   = "api-alb"
    domain_name = var.api_alb_dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Frontend: index.html upload với no-cache, file trong assets/ có hash trong tên nên cache lâu
  default_cache_behavior {
    target_origin_id           = "web-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  # HLS: playlist có Cache-Control no-cache, segment max-age 1 năm (worker đặt khi upload).
  # API invalidate /videos/{id}/* khi xoá video.
  # Thumbnail công khai để thư viện hiện được ảnh khi chưa đăng nhập.
  # Đứng trước /videos/* vì CloudFront chọn behavior khớp đầu tiên theo thứ tự.
  ordered_cache_behavior {
    path_pattern               = "/videos/*/thumbnail.jpg"
    target_origin_id           = "processed-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.cors_s3.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.cors.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.strip_videos_prefix.arn
    }
  }

  # HLS: bắt buộc CloudFront signed cookies (API cấp qua POST /api/videos/{id}/playback sau khi
  # kiểm tra gói). Thiếu, sai hoặc hết hạn cookie thì CloudFront trả 403.
  # Playlist có Cache-Control no-cache, segment max-age 1 năm (worker đặt khi upload).
  # API invalidate /videos/{id}/* và /{id}/* khi xoá video.
  ordered_cache_behavior {
    path_pattern               = "/videos/*"
    target_origin_id           = "processed-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.cors_s3.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.cors.id
    trusted_key_groups         = [aws_cloudfront_key_group.playback.id]

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.strip_videos_prefix.arn
    }
  }

  # Grafana (k8s/monitoring) dùng chung ALB với API, có đăng nhập riêng
  ordered_cache_behavior {
    path_pattern             = "/grafana*"
    target_origin_id         = "api-alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api-alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.this.domain_name
}

output "cdn_base_url" {
  description = "Set as CDN_BASE_URL for the API and worker (HLS lives under /videos)"
  value       = "https://${aws_cloudfront_distribution.this.domain_name}/videos"
}

output "site_url" {
  description = "Frontend URL"
  value       = "https://${aws_cloudfront_distribution.this.domain_name}"
}

output "distribution_id" {
  description = "Set as CLOUDFRONT_DISTRIBUTION_ID for the API (cache invalidation on delete)"
  value       = aws_cloudfront_distribution.this.id
}

output "web_bucket" {
  value = module.web_bucket.id
}

output "playback_key_pair_id" {
  description = "Set as CLOUDFRONT_KEY_PAIR_ID for the API"
  value       = aws_cloudfront_public_key.playback.id
}

output "playback_private_key_pem" {
  description = "Set as CLOUDFRONT_PRIVATE_KEY for the API (k8s/deploy.sh stores it in a Kubernetes secret)"
  value       = tls_private_key.playback.private_key_pem
  sensitive   = true
}
