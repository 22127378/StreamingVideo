# IAM policy theo nguyên tắc quyền tối thiểu cho API và worker.
# Từ thời API gộp: trên EKS các service dùng role riêng qua IRSA (layer compute, services,
# observability, database). Module này chỉ còn dev role (create_dev_roles) để chạy API/worker
# cũ trên máy với đúng các quyền này; sẽ gỡ cùng bảng DynamoDB cũ.

data "aws_caller_identity" "current" {}

locals {
  table_arns = [var.table_arn, "${var.table_arn}/index/*"]
}

# ---------------- API
data "aws_iam_policy_document" "api" {
  statement {
    sid = "UploadAndManageRawObjects"
    actions = [
      "s3:PutObject",    # ký presigned PUT cho browser
      "s3:GetObject",    # HeadObject khi /complete kiểm tra file đã upload
      "s3:DeleteObject", # DELETE /api/videos/:id
    ]
    resources = ["${var.raw_bucket_arn}/raw/*"]
  }

  statement {
    sid       = "DeleteProcessedObjects"
    actions   = ["s3:DeleteObject"]
    resources = ["${var.processed_bucket_arn}/*"]
  }

  # Không đặt điều kiện s3:prefix: HeadObject trả 404 cho object không tồn tại chỉ khi có
  # s3:ListBucket, mà request HeadObject không mang khoá s3:prefix (thiếu quyền thì S3 trả 403).
  statement {
    sid       = "ListForExistenceChecksAndDeletes"
    actions   = ["s3:ListBucket"]
    resources = [var.raw_bucket_arn, var.processed_bucket_arn]
  }

  statement {
    sid = "VideoMetadata"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
    ]
    resources = local.table_arns
  }

  statement {
    sid       = "QueueTranscodeJobs"
    actions   = ["sqs:SendMessage"]
    resources = [var.queue_arn]
  }

  # DELETE /api/videos/:id xoá cache HLS trên CloudFront. Giới hạn theo account vì
  # distribution được tạo ở layer delivery, sau layer identity.
  statement {
    sid       = "InvalidateDeletedVideos"
    actions   = ["cloudfront:CreateInvalidation"]
    resources = ["arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/*"]
  }
}

resource "aws_iam_policy" "api" {
  name        = "${var.name_prefix}-api"
  description = "StreamForge API: presign uploads, manage video metadata, queue transcode jobs"
  policy      = data.aws_iam_policy_document.api.json
}

# ---------------- Worker
data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "ReadRawUploads"
    actions   = ["s3:GetObject"]
    resources = ["${var.raw_bucket_arn}/raw/*"]
  }

  statement {
    sid       = "WriteHlsOutput"
    actions   = ["s3:PutObject"]
    resources = ["${var.processed_bucket_arn}/*"]
  }

  statement {
    sid       = "UpdateVideoStatus"
    actions   = ["dynamodb:UpdateItem"]
    resources = [var.table_arn]
  }

  statement {
    sid = "ConsumeTranscodeJobs"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [var.queue_arn]
  }
}

resource "aws_iam_policy" "worker" {
  name        = "${var.name_prefix}-worker"
  description = "StreamForge transcode worker: read uploads, write HLS, update status, consume the queue"
  policy      = data.aws_iam_policy_document.worker.json
}

# ---------------- Dev roles (chạy API/worker trên máy với quyền giống production)
data "aws_iam_policy_document" "dev_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = coalescelist(var.dev_role_trusted_principals, ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"])
    }
  }
}

resource "aws_iam_role" "dev" {
  for_each = var.create_dev_roles ? { api = aws_iam_policy.api.arn, worker = aws_iam_policy.worker.arn } : {}

  name                 = "${var.name_prefix}-${each.key}-dev"
  description          = "Assume locally to run the ${each.key} with production permissions"
  assume_role_policy   = data.aws_iam_policy_document.dev_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "dev" {
  for_each = aws_iam_role.dev

  role       = each.value.name
  policy_arn = each.key == "api" ? aws_iam_policy.api.arn : aws_iam_policy.worker.arn
}
