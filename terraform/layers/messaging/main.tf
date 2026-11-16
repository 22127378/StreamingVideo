# Hàng đợi transcode và DLQ.
# Chưa có EventBridge: API tự gửi job khi client gọi POST /api/videos/complete.
# Nếu thêm rule S3 -> EventBridge -> SQS mà vẫn giữ luồng đó, mỗi video sẽ bị transcode hai lần.

locals {
  layer = "messaging"
}

module "transcode_queue" {
  source = "../../modules/sqs"

  name                       = "${local.name_prefix}-transcode"
  visibility_timeout_seconds = 300
  max_receive_count          = 3
}

output "transcode_queue_url" {
  value = module.transcode_queue.queue_url
}

output "transcode_dlq_url" {
  value = module.transcode_queue.dlq_url
}
