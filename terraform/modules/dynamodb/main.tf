# Bảng metadata video. Khớp với scripts/init-aws-local.sh:
# PK videoId, GSI entityType-createdAt-index để liệt kê video mới nhất trước (GET /api/videos).

resource "aws_dynamodb_table" "videos" {
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "videoId"

  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "videoId"
    type = "S"
  }

  attribute {
    name = "entityType"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  global_secondary_index {
    name            = var.created_at_index_name
    hash_key        = "entityType"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }
}
