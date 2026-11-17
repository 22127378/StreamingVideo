# Aurora PostgreSQL Serverless v2: metadata video (thay DynamoDB).
#
# - Nằm trong subnet private, chỉ nhận kết nối 5432 từ pod trong cụm EKS (security group của cluster).
# - App không có mật khẩu DB: pod API và worker kết nối bằng IAM database authentication (token 15 phút
#   sinh từ credentials Pod Identity), mỗi service một user DB (streamforge_api, streamforge_worker).
# - Mật khẩu master do RDS quản lý trong Secrets Manager; chỉ Job migration (k8s/db/) dùng nó để tạo schema,
#   tạo user DB và chép dữ liệu cũ từ DynamoDB.
# Áp dụng sau networking và compute (cần cluster để lấy security group), trước khi deploy app.

locals {
  layer        = "database"
  cluster_name = local.name_prefix
  db_name      = "streamforge"
  db_users     = ["streamforge_api", "streamforge_worker"]
}

variable "engine_version" {
  type    = string
  default = "17.11"
}

variable "min_capacity" {
  description = "Minimum ACU. 0 lets the cluster auto-pause when idle (near $0) but the first query after a pause waits ~15s; 0.5 keeps it warm (~$44/month)"
  type        = number
  default     = 0.5
}

variable "max_capacity" {
  type    = number
  default = 4
}

variable "deletion_protection" {
  type    = bool
  default = true
}

data "aws_vpc" "this" {
  tags = { Name = local.name_prefix }
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.this.id]
  }
  tags = { Tier = "private" }
}

data "aws_eks_cluster" "this" {
  name = local.cluster_name
}

resource "aws_db_subnet_group" "this" {
  name       = local.name_prefix
  subnet_ids = data.aws_subnets.private.ids
}

resource "aws_security_group" "db" {
  name        = "${local.name_prefix}-aurora"
  description = "Aurora PostgreSQL: 5432 from EKS pods only"
  vpc_id      = data.aws_vpc.this.id
}

# Pod trên EKS Auto Mode dùng security group của cluster
resource "aws_vpc_security_group_ingress_rule" "db_from_eks" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = data.aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from EKS pods"
}

resource "aws_rds_cluster_parameter_group" "this" {
  name   = "${local.name_prefix}-aurora-pg17"
  family = "aurora-postgresql17"

  # Bắt buộc TLS cho mọi kết nối
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Ghi log câu lệnh chậm hơn 500ms lên CloudWatch
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

resource "aws_rds_cluster" "this" {
  cluster_identifier = local.name_prefix
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.engine_version
  database_name      = local.db_name

  master_username             = "streamforge_admin"
  manage_master_user_password = true # mật khẩu trong Secrets Manager, RDS tự xoay vòng

  iam_database_authentication_enabled = true
  storage_encrypted                   = true
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  db_cluster_parameter_group_name     = aws_rds_cluster_parameter_group.this.name

  backup_retention_period         = 7
  preferred_backup_window         = "18:00-19:00" # 01:00-02:00 giờ Việt Nam
  copy_tags_to_snapshot           = true
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name_prefix}-final"
  enabled_cloudwatch_logs_exports = ["postgresql"]

  # Log group có thời hạn lưu phải có trước, nếu không RDS tự tạo log group lưu vĩnh viễn
  depends_on = [aws_cloudwatch_log_group.postgresql]

  serverlessv2_scaling_configuration {
    min_capacity             = var.min_capacity
    max_capacity             = var.max_capacity
    seconds_until_auto_pause = var.min_capacity == 0 ? 600 : null
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier           = "${local.name_prefix}-writer"
  cluster_identifier   = aws_rds_cluster.this.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.this.engine
  engine_version       = aws_rds_cluster.this.engine_version
  db_subnet_group_name = aws_db_subnet_group.this.name

  performance_insights_enabled = true # 7 ngày miễn phí
  auto_minor_version_upgrade   = true
}

resource "aws_cloudwatch_log_group" "postgresql" {
  name              = "/aws/rds/cluster/${local.name_prefix}/postgresql"
  retention_in_days = 14
}

# ---------------- Quyền kết nối bằng IAM cho pod API và worker
data "aws_iam_role" "pod" {
  for_each = toset(["api", "worker"])
  name     = "${local.name_prefix}-${each.key}-pod"
}

data "aws_iam_policy_document" "connect" {
  for_each = toset(["api", "worker"])
  statement {
    sid       = "ConnectAsServiceUser"
    actions   = ["rds-db:connect"]
    resources = ["arn:aws:rds-db:${var.aws_region}:${local.account_id}:dbuser:${aws_rds_cluster.this.cluster_resource_id}/streamforge_${each.key}"]
  }
}

resource "aws_iam_role_policy" "connect" {
  for_each = toset(["api", "worker"])
  name     = "aurora-connect"
  role     = data.aws_iam_role.pod[each.key].name
  policy   = data.aws_iam_policy_document.connect[each.key].json
}

# ---------------- Job migration (k8s/db/migrate-job.yaml): mật khẩu master + đọc DynamoDB cũ để chép dữ liệu
data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "migrator" {
  statement {
    sid       = "ReadMasterPassword"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_rds_cluster.this.master_user_secret[0].secret_arn]
  }
  statement {
    sid       = "ImportFromDynamoDB"
    actions   = ["dynamodb:Scan", "dynamodb:DescribeTable"]
    resources = ["arn:aws:dynamodb:${var.aws_region}:${local.account_id}:table/${local.name_prefix}-videos"]
  }
}

resource "aws_iam_role" "migrator" {
  name               = "${local.name_prefix}-db-migrator-pod"
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy" "migrator" {
  name   = "db-migrator"
  role   = aws_iam_role.migrator.name
  policy = data.aws_iam_policy_document.migrator.json
}

resource "aws_eks_pod_identity_association" "migrator" {
  cluster_name    = local.cluster_name
  namespace       = "streamforge"
  service_account = "streamforge-db-migrator"
  role_arn        = aws_iam_role.migrator.arn
}

output "endpoint" {
  value = aws_rds_cluster.this.endpoint
}

output "database" {
  value = local.db_name
}

output "master_secret_arn" {
  value = aws_rds_cluster.this.master_user_secret[0].secret_arn
}

output "master_username" {
  value = aws_rds_cluster.this.master_username
}
