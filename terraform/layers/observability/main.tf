# Giám sát. Trong cụm dùng bộ Grafana (k8s/monitoring/): Alloy gom log pod -> Loki, Prometheus gom metric
# (pod, node, Kubernetes, /metrics của API và worker), Alertmanager gửi cảnh báo, Grafana hiển thị tất cả.
# Layer này tạo phần AWS mà bộ đó cần, và phần chỉ AWS thu được:
#   - Bucket S3 cho Loki; role Pod Identity cho Loki (S3), Alertmanager (SNS) và Grafana (đọc CloudWatch).
#   - SNS -> email: kênh cảnh báo chung cho Alertmanager và CloudWatch Alarm.
#   - CloudFront access log -> CloudWatch Logs /streamforge/<env>/cloudfront (Grafana đọc qua datasource CloudWatch).
#   - CloudWatch Alarm cho SQS và CloudFront: vẫn báo được khi cụm gặp sự cố.
#   - Audit log của EKS nằm ở /aws/eks/<cluster>/cluster (bật ở layer compute).
#
# Áp dụng sau compute (cluster) và delivery (CloudFront distribution), trước k8s/monitoring/install.sh.

locals {
  layer        = "observability"
  cluster      = local.name_prefix
  namespace    = "monitoring"
  dlq_name     = "${local.name_prefix}-transcode-dlq"
  queue_name   = "${local.name_prefix}-transcode"
  cf_log_group = "/streamforge/${var.environment}/cloudfront"
}

variable "alert_email" {
  description = "Email that receives alerts (confirm the SNS subscription email)"
  type        = string
}

variable "cloudfront_distribution_id" {
  description = "Distribution from the delivery layer (terraform -chdir=../delivery output -raw distribution_id)"
  type        = string
}

variable "site_domain" {
  description = "CloudFront domain of the site, used for links in alert emails"
  type        = string
}

variable "log_retention_days" {
  description = "Retention for Loki chunks and CloudWatch log groups"
  type        = number
  default     = 14
}

# ---------------- Kênh cảnh báo
resource "aws_sns_topic" "alerts" {
  name = "${local.name_prefix}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------------- Loki lưu log trên S3
module "loki_bucket" {
  source = "../../modules/s3"

  bucket_name       = "${local.name_prefix}-loki-${local.account_id}"
  force_destroy     = true # chỉ chứa log, có thời hạn
  expire_after_days = var.log_retention_days + 1
}

# ---------------- Pod Identity cho các thành phần giám sát
data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "loki" {
  statement {
    sid       = "LokiChunks"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${module.loki_bucket.arn}/*"]
  }
  statement {
    sid       = "LokiList"
    actions   = ["s3:ListBucket"]
    resources = [module.loki_bucket.arn]
  }
}

data "aws_iam_policy_document" "alertmanager" {
  statement {
    sid       = "PublishAlerts"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }
}

# Datasource CloudWatch của Grafana: đọc metric và log (SQS, CloudFront, audit EKS), không ghi gì
data "aws_iam_policy_document" "grafana" {
  statement {
    sid = "ReadMetrics"
    actions = [
      "cloudwatch:DescribeAlarms",
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:ListMetrics",
      "tag:GetResources",
      "ec2:DescribeRegions",
    ]
    resources = ["*"]
  }
  statement {
    sid = "ReadLogs"
    actions = [
      "logs:DescribeLogGroups",
      "logs:GetLogGroupFields",
      "logs:StartQuery",
      "logs:StopQuery",
      "logs:GetQueryResults",
      "logs:GetLogEvents",
    ]
    resources = ["*"]
  }
}

locals {
  pod_identities = {
    loki         = { service_account = "loki", policy = data.aws_iam_policy_document.loki.json }
    alertmanager = { service_account = "alertmanager", policy = data.aws_iam_policy_document.alertmanager.json }
    grafana      = { service_account = "grafana", policy = data.aws_iam_policy_document.grafana.json }
  }
}

resource "aws_iam_role" "monitoring" {
  for_each           = local.pod_identities
  name               = "${local.name_prefix}-${each.key}-pod"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy" "monitoring" {
  for_each = local.pod_identities
  name     = each.key
  role     = aws_iam_role.monitoring[each.key].name
  policy   = each.value.policy
}

resource "aws_eks_pod_identity_association" "monitoring" {
  for_each        = local.pod_identities
  cluster_name    = local.cluster
  namespace       = local.namespace
  service_account = each.value.service_account
  role_arn        = aws_iam_role.monitoring[each.key].arn
}

# ---------------- CloudFront access log -> CloudWatch Logs (vended logs v2)
resource "aws_cloudwatch_log_group" "cloudfront" {
  name              = local.cf_log_group
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_delivery_source" "cloudfront" {
  name         = "${local.name_prefix}-cloudfront"
  log_type     = "ACCESS_LOGS"
  resource_arn = "arn:aws:cloudfront::${local.account_id}:distribution/${var.cloudfront_distribution_id}"
}

resource "aws_cloudwatch_log_delivery_destination" "cloudfront" {
  name          = "${local.name_prefix}-cloudfront-logs"
  output_format = "json"

  delivery_destination_configuration {
    destination_resource_arn = aws_cloudwatch_log_group.cloudfront.arn
  }
}

resource "aws_cloudwatch_log_delivery" "cloudfront" {
  delivery_source_name     = aws_cloudwatch_log_delivery_source.cloudfront.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.cloudfront.arn
}

# ---------------- Cảnh báo phía AWS (không phụ thuộc vào cụm)
locals {
  alarms = {
    dlq-not-empty = {
      description = "Có job transcode thất bại 3 lần và nằm trong DLQ: kiểm tra log worker trong Grafana"
      namespace   = "AWS/SQS"
      metric      = "ApproximateNumberOfMessagesVisible"
      dimensions  = { QueueName = local.dlq_name }
      statistic   = "Maximum"
      periods     = 1
      threshold   = 0
    }
    catalog-events-dlq-not-empty = {
      description = "Catalog không xử lý được sự kiện sau 10 lần (DLQ streamforge-dev-catalog-events-dlq): video có thể sai trạng thái, xem log catalog trong Grafana"
      namespace   = "AWS/SQS"
      metric      = "ApproximateNumberOfMessagesVisible"
      dimensions  = { QueueName = "${local.name_prefix}-catalog-events-dlq" }
      statistic   = "Maximum"
      periods     = 1
      threshold   = 0
    }
    transcode-queue-stuck = {
      description = "Job cũ nhất trong hàng đợi đã chờ hơn 15 phút: worker không chạy hoặc không nhận được máy Spot"
      namespace   = "AWS/SQS"
      metric      = "ApproximateAgeOfOldestMessage"
      dimensions  = { QueueName = local.queue_name }
      statistic   = "Maximum"
      periods     = 1
      threshold   = 900
    }
    cloudfront-5xx = {
      description = "Hơn 5% request qua CloudFront trả lỗi 5xx trong 10 phút"
      namespace   = "AWS/CloudFront"
      metric      = "5xxErrorRate"
      dimensions  = { DistributionId = var.cloudfront_distribution_id, Region = "Global" }
      statistic   = "Average"
      periods     = 2
      threshold   = 5
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each = local.alarms

  alarm_name          = "${local.name_prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dimensions
  statistic           = each.value.statistic
  period              = 300
  evaluation_periods  = each.value.periods
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  # Không gửi thẳng SNS (email là JSON khó đọc, gửi cả lúc vừa tạo alarm). EventBridge bên dưới
  # định dạng lại và chỉ gửi khi vào ALARM hoặc hết ALARM.
}

# ---------------- Email cảnh báo dễ đọc: CloudWatch Alarm -> EventBridge -> SNS
# Chỉ gửi khi alarm chuyển sang ALARM, và khi hết sự cố (ALARM -> OK). Bỏ qua lúc mới tạo
# (INSUFFICIENT_DATA -> OK). Tiêu đề email do SNS đặt cố định ("AWS Notification Message").
data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid       = "EventBridgePublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
  statement {
    sid       = "OwnerPublish"
    actions   = ["sns:Publish", "sns:Subscribe", "sns:GetTopicAttributes"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

locals {
  alarm_events = {
    firing = {
      description = "StreamForge alarm entered ALARM"
      state       = { value = ["ALARM"] }
      template    = <<-EOT
        "[StreamForge] CẢNH BÁO: <alarm>"
        "Có sự cố: <description>"
        ""
        "Thời điểm (UTC): <time>"
        "Chi tiết: <reason>"
        ""
        "Dashboard: https://__SITE__/grafana/d/streamforge-overview"
        "Alarm: https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#alarmsV2:alarm/<alarm>"
      EOT
    }
    resolved = {
      description = "StreamForge alarm recovered from ALARM"
      state       = { value = ["OK"] }
      template    = <<-EOT
        "[StreamForge] ĐÃ HẾT: <alarm>"
        "Sự cố đã hết: <description>"
        ""
        "Thời điểm (UTC): <time>"
      EOT
    }
  }
}

resource "aws_cloudwatch_event_rule" "alarm" {
  for_each    = local.alarm_events
  name        = "${local.name_prefix}-alarm-${each.key}"
  description = each.value.description
  event_pattern = jsonencode(merge(
    {
      source        = ["aws.cloudwatch"]
      "detail-type" = ["CloudWatch Alarm State Change"]
    },
    {
      detail = merge(
        { alarmName = [{ prefix = "${local.name_prefix}-" }], state = each.value.state },
        each.key == "resolved" ? { previousState = { value = ["ALARM"] } } : {}
      )
    }
  ))
}

resource "aws_cloudwatch_event_target" "alarm" {
  for_each = local.alarm_events
  rule     = aws_cloudwatch_event_rule.alarm[each.key].name
  arn      = aws_sns_topic.alerts.arn

  input_transformer {
    input_paths = {
      alarm       = "$.detail.alarmName"
      description = "$.detail.configuration.description"
      reason      = "$.detail.state.reason"
      time        = "$.time"
    }
    input_template = replace(each.value.template, "__SITE__", var.site_domain)
  }
}

# ---------------- Truy vấn Logs Insights cho log chỉ có ở CloudWatch
resource "aws_cloudwatch_query_definition" "cloudfront_errors" {
  name            = "${local.name_prefix}/cloudfront-errors"
  log_group_names = [aws_cloudwatch_log_group.cloudfront.name]
  query_string    = <<-EOT
    # Tên trường của CloudFront có dấu gạch ngang nên phải đặt trong dấu backtick; sc-status là chuỗi
    fields @timestamp, `sc-status` as status, `cs-method` as method, `cs-uri-stem` as path, `x-edge-result-type` as result
    | filter `sc-status` like /^[45]/
    | stats count() as hits by status, path
    | sort hits desc
    | limit 50
  EOT
}

resource "aws_cloudwatch_query_definition" "eks_audit_changes" {
  name            = "${local.name_prefix}/eks-audit-changes"
  log_group_names = ["/aws/eks/${local.cluster}/cluster"]
  query_string    = <<-EOT
    # Ai thay đổi gì trong cụm (create/update/patch/delete), bỏ qua tài khoản hệ thống
    fields @timestamp, user.username, verb, objectRef.resource, objectRef.namespace, objectRef.name
    | filter @logStream like "kube-apiserver-audit" and verb in ["create", "update", "patch", "delete"]
    | filter user.username not like "system:"
    | sort @timestamp desc
    | limit 100
  EOT
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "loki_bucket" {
  value = module.loki_bucket.id
}

output "cloudfront_log_group" {
  value = aws_cloudwatch_log_group.cloudfront.name
}
