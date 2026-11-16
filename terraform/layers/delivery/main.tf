# CloudFront trước toàn bộ hệ thống:
#   /api/*   -> ALB của API (do EKS Auto Mode tạo từ Ingress), không cache
#   còn lại  -> bucket processed qua Origin Access Control (HLS: master.m3u8, *.ts, thumbnail.jpg)
# ALB chỉ nhận traffic từ dải IP origin-facing của CloudFront (security group ở layer compute).
#
# Áp dụng sau khi Ingress của API đã có ALB:
#   terraform apply -var "api_alb_dns_name=$(kubectl -n streamforge get ingress streamforge-api \
#     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')"
#
# Chưa làm: CloudFront signed cookies theo tier (API vẫn mô phỏng bằng JWT), domain riêng + ACM.
# CloudFront nói chuyện với ALB bằng HTTP vì ALB chưa có chứng chỉ (cần domain riêng).

locals {
  layer = "delivery"
}

variable "api_alb_dns_name" {
  description = "DNS name of the API ALB created by the streamforge-api Ingress"
  type        = string
}

variable "price_class" {
  description = "PriceClass_100 serves from North America and Europe edges only, the cheapest option"
  type        = string
  default     = "PriceClass_100"
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

resource "aws_cloudfront_origin_access_control" "processed" {
  name                              = "${local.name_prefix}-processed"
  description                       = "Read HLS output from the private processed bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  comment         = "${local.name_prefix}: HLS playback and API"
  price_class     = var.price_class
  is_ipv6_enabled = true
  http_version    = "http2and3"

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

  # HLS: playlist có Cache-Control no-cache, segment max-age 1 năm (worker đặt khi upload)
  default_cache_behavior {
    target_origin_id           = "processed-s3"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.cors_s3.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.cors.id
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
  description = "Set as CDN_BASE_URL for the API and worker"
  value       = "https://${aws_cloudfront_distribution.this.domain_name}"
}
