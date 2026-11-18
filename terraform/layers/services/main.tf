# Microservice: bus sự kiện và quyền riêng của từng service.
#
# - EventBridge bus <prefix>-events. Service phát sự kiện (source "streamforge.<service>"), rule chuyển:
#     VideoUploaded           -> hàng đợi transcode (chỉ phần detail, chính là job của worker)
#     mọi sự kiện StreamForge -> hàng đợi <prefix>-catalog-events (catalog dựng dữ liệu từ đó)
# - Mỗi service HTTP (account, upload, catalog, playback, live) một IAM role gắn vào ServiceAccount qua EKS Pod
#   Identity, chỉ có đúng quyền của service đó. Upload, catalog và live có user Aurora riêng (IAM auth), mỗi
#   user chỉ thấy schema của mình. Worker không còn quyền database, chỉ được phát sự kiện.
# Áp dụng sau compute, auth, database (đọc cụm, user pool, cluster Aurora theo tên).

locals {
  layer        = "services"
  cluster_name = local.name_prefix
  namespace    = "streamforge"
  services     = toset(["account", "upload", "catalog", "playback", "live"])
}

data "aws_s3_bucket" "raw" {
  bucket = "${local.name_prefix}-raw-${local.account_id}"
}

data "aws_s3_bucket" "processed" {
  bucket = "${local.name_prefix}-processed-${local.account_id}"
}

data "aws_sqs_queue" "transcode" {
  name = "${local.name_prefix}-transcode"
}

data "aws_rds_cluster" "db" {
  cluster_identifier = local.name_prefix
}

data "aws_cognito_user_pools" "this" {
  name = local.name_prefix
}

data "aws_iam_role" "worker_pod" {
  name = "${local.name_prefix}-worker-pod"
}

# ---------------- EventBridge
resource "aws_cloudwatch_event_bus" "this" {
  name = "${local.name_prefix}-events"
}

module "catalog_events" {
  source = "../../modules/sqs"

  name = "${local.name_prefix}-catalog-events"
  # Catalog xử lý một sự kiện trong vài chục ms; lỗi thì giao lại sau 60s
  visibility_timeout_seconds = 60
  # Sự kiện đến trước VideoCreated được thử lại nhiều lần trước khi vào DLQ
  max_receive_count = 10
}

resource "aws_cloudwatch_event_rule" "to_transcode" {
  name           = "${local.name_prefix}-video-uploaded-to-transcode"
  description    = "VideoUploaded from the upload service becomes a transcode job"
  event_bus_name = aws_cloudwatch_event_bus.this.name
  event_pattern = jsonencode({
    source        = ["streamforge.upload"]
    "detail-type" = ["VideoUploaded"]
  })
}

resource "aws_cloudwatch_event_target" "to_transcode" {
  rule           = aws_cloudwatch_event_rule.to_transcode.name
  event_bus_name = aws_cloudwatch_event_bus.this.name
  target_id      = "transcode-queue"
  arn            = data.aws_sqs_queue.transcode.arn
  # Worker đọc thẳng job (videoId, rawBucket, rawS3Key, ...), không cần lớp vỏ sự kiện
  input_path = "$.detail"
}

resource "aws_cloudwatch_event_rule" "to_catalog" {
  name           = "${local.name_prefix}-all-to-catalog"
  description    = "Every StreamForge event goes to the catalog read model"
  event_bus_name = aws_cloudwatch_event_bus.this.name
  event_pattern = jsonencode({
    source = [{ prefix = "streamforge." }]
  })
}

resource "aws_cloudwatch_event_target" "to_catalog" {
  rule           = aws_cloudwatch_event_rule.to_catalog.name
  event_bus_name = aws_cloudwatch_event_bus.this.name
  target_id      = "catalog-queue"
  arn            = module.catalog_events.queue_arn
}

# EventBridge chỉ gửi được vào SQS khi queue policy cho phép, giới hạn đúng rule
data "aws_iam_policy_document" "queue_from_rule" {
  for_each = {
    transcode = { queue_arn = data.aws_sqs_queue.transcode.arn, rule_arn = aws_cloudwatch_event_rule.to_transcode.arn }
    catalog   = { queue_arn = module.catalog_events.queue_arn, rule_arn = aws_cloudwatch_event_rule.to_catalog.arn }
  }
  statement {
    sid       = "AllowEventBridgeRule"
    actions   = ["sqs:SendMessage"]
    resources = [each.value.queue_arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [each.value.rule_arn]
    }
  }
}

resource "aws_sqs_queue_policy" "transcode" {
  queue_url = data.aws_sqs_queue.transcode.url
  policy    = data.aws_iam_policy_document.queue_from_rule["transcode"].json
}

resource "aws_sqs_queue_policy" "catalog" {
  queue_url = module.catalog_events.queue_url
  policy    = data.aws_iam_policy_document.queue_from_rule["catalog"].json
}

# ---------------- Quyền của từng service
data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

locals {
  db_user_arn = "arn:aws:rds-db:${var.aws_region}:${local.account_id}:dbuser:${data.aws_rds_cluster.db.cluster_resource_id}"
}

data "aws_iam_policy_document" "publish_events" {
  statement {
    sid       = "PublishEvents"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.this.arn]
  }
}

data "aws_iam_policy_document" "account" {
  statement {
    sid       = "UpgradeToPremium"
    actions   = ["cognito-idp:AdminAddUserToGroup"]
    resources = data.aws_cognito_user_pools.this.arns
  }
}

data "aws_iam_policy_document" "upload" {
  source_policy_documents = [data.aws_iam_policy_document.publish_events.json]
  statement {
    sid = "PresignAndCheckUploads"
    actions = [
      "s3:PutObject", # ký presigned PUT cho trình duyệt
      "s3:GetObject", # HeadObject khi xác nhận upload
    ]
    resources = ["${data.aws_s3_bucket.raw.arn}/raw/*"]
  }
  # HeadObject trả 404 (thay vì 403) cho object chưa có chỉ khi có s3:ListBucket
  statement {
    sid       = "ListForExistenceChecks"
    actions   = ["s3:ListBucket"]
    resources = [data.aws_s3_bucket.raw.arn]
  }
  statement {
    sid       = "ConnectAsUploadUser"
    actions   = ["rds-db:connect"]
    resources = ["${local.db_user_arn}/streamforge_upload"]
  }
}

data "aws_iam_policy_document" "catalog" {
  statement {
    sid       = "DeleteVideoFiles"
    actions   = ["s3:DeleteObject"]
    resources = ["${data.aws_s3_bucket.raw.arn}/raw/*", "${data.aws_s3_bucket.processed.arn}/*"]
  }
  statement {
    sid       = "ListVideoFiles"
    actions   = ["s3:ListBucket"]
    resources = [data.aws_s3_bucket.raw.arn, data.aws_s3_bucket.processed.arn]
  }
  # Distribution nằm ở layer delivery; giới hạn theo account
  statement {
    sid       = "InvalidateDeletedVideos"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = ["arn:aws:cloudfront::${local.account_id}:distribution/*"]
  }
  statement {
    sid = "ConsumeCatalogEvents"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [module.catalog_events.queue_arn]
  }
  statement {
    sid       = "ConnectAsCatalogUser"
    actions   = ["rds-db:connect"]
    resources = ["${local.db_user_arn}/streamforge_catalog"]
  }
}

# Live: quản lý kênh Amazon IVS (mỗi kênh StreamForge một kênh IVS), đọc trạng thái đang phát,
# và tra email (tên hiển thị trong bình luận) từ Cognito
data "aws_iam_policy_document" "live" {
  #checkov:skip=CKV_AWS_356:ivs:ListStreams has no resource-level permissions; every other IVS action is scoped to this account's channels and stream keys
  statement {
    sid = "ManageIvsChannels"
    actions = [
      "ivs:CreateChannel",
      "ivs:DeleteChannel",
      "ivs:GetChannel",
      "ivs:CreateStreamKey",
      "ivs:DeleteStreamKey",
      "ivs:GetStreamKey",
      "ivs:TagResource",
    ]
    resources = [
      "arn:aws:ivs:${var.aws_region}:${local.account_id}:channel/*",
      "arn:aws:ivs:${var.aws_region}:${local.account_id}:stream-key/*",
    ]
  }
  # ListStreams không giới hạn được theo resource
  statement {
    sid       = "ListLiveStreams"
    actions   = ["ivs:ListStreams"]
    resources = ["*"]
  }
  statement {
    sid       = "ResolveDisplayNames"
    actions   = ["cognito-idp:AdminGetUser"]
    resources = data.aws_cognito_user_pools.this.arns
  }
  statement {
    sid       = "ConnectAsLiveUser"
    actions   = ["rds-db:connect"]
    resources = ["${local.db_user_arn}/streamforge_live"]
  }
}

locals {
  service_policies = {
    account  = data.aws_iam_policy_document.account.json
    upload   = data.aws_iam_policy_document.upload.json
    catalog  = data.aws_iam_policy_document.catalog.json
    playback = data.aws_iam_policy_document.publish_events.json
    live     = data.aws_iam_policy_document.live.json
  }
}

resource "aws_iam_role" "service" {
  for_each           = local.services
  name               = "${local.name_prefix}-${each.key}-pod"
  description        = "StreamForge ${each.key} service (EKS Pod Identity)"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy" "service" {
  for_each = local.services
  name     = "${each.key}-service"
  role     = aws_iam_role.service[each.key].name
  policy   = local.service_policies[each.key]
}

resource "aws_eks_pod_identity_association" "service" {
  for_each        = local.services
  cluster_name    = local.cluster_name
  namespace       = local.namespace
  service_account = "streamforge-${each.key}"
  role_arn        = aws_iam_role.service[each.key].arn
}

# Worker (role ở layer compute): báo kết quả transcode bằng sự kiện thay vì ghi database
resource "aws_iam_role_policy" "worker_events" {
  name   = "publish-events"
  role   = data.aws_iam_role.worker_pod.name
  policy = data.aws_iam_policy_document.publish_events.json
}

# ---------------- Outputs (k8s/deploy.sh đưa vào ConfigMap)
output "event_bus_name" {
  value = aws_cloudwatch_event_bus.this.name
}

output "catalog_events_queue_url" {
  value = module.catalog_events.queue_url
}

output "catalog_events_dlq_url" {
  value = module.catalog_events.dlq_url
}
