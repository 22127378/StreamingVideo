# EKS Auto Mode: AWS quản lý node (Karpenter), ALB controller, EBS CSI.
# Node API/KEDA và node Spot cho worker được khai báo bằng NodePool trong k8s/cluster/.
# Pod dùng IRSA (OIDC của cụm) với các policy của layer identity.

locals {
  layer        = "compute"
  cluster_name = local.name_prefix
  namespace    = "streamforge"
}

variable "kubernetes_version" {
  type    = string
  default = "1.36"
}

variable "endpoint_public_access_cidrs" {
  description = "CIDRs allowed to reach the Kubernetes API endpoint (authentication is still required)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ---------------- Tài nguyên của các layer trước, tìm theo tên/tag
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

data "aws_iam_policy" "worker" {
  name = "${local.name_prefix}-worker"
}

data "aws_sqs_queue" "transcode" {
  name = "${local.name_prefix}-transcode"
}

# ---------------- Cluster
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = local.cluster_name
  kubernetes_version = var.kubernetes_version

  endpoint_public_access       = true
  endpoint_public_access_cidrs = var.endpoint_public_access_cidrs

  # OIDC provider cho IRSA (các role pod ở layer compute, database, services, observability)
  enable_irsa = true

  # Người chạy terraform apply có quyền admin trong cluster (access entry)
  enable_cluster_creator_admin_permissions = true

  # Log control plane lên CloudWatch: audit (ai làm gì trong cụm) và authenticator (ai đăng nhập).
  # Bỏ "api" vì quá nhiều (~4.7 GB/tháng chỉ với cụm nhỏ này).
  enabled_log_types                      = ["audit", "authenticator"]
  cloudwatch_log_group_retention_in_days = 7

  compute_config = {
    enabled = true
    # Giữ các pool có sẵn để Auto Mode tạo NodeClass "default"; NodePool riêng (k8s/cluster/)
    # có weight cao hơn nên được ưu tiên.
    node_pools = ["general-purpose", "system"]
  }

  vpc_id     = data.aws_vpc.this.id
  subnet_ids = data.aws_subnets.private.ids
}

# ---------------- Container registry
# Một repository cho mỗi image: 5 service HTTP và worker
resource "aws_ecr_repository" "app" {
  for_each = toset(["worker", "account", "upload", "catalog", "playback", "live"])

  name                 = "${local.name_prefix}-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 10 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------- ALB chỉ nhận traffic từ CloudFront
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  #checkov:skip=CKV2_AWS_5:Attached by the EKS Auto Mode load balancer controller through the Ingress annotation, outside Terraform
  name        = "${local.name_prefix}-alb"
  description = "API load balancer: HTTP from CloudFront origin-facing IPs only"
  vpc_id      = data.aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  #checkov:skip=CKV_AWS_260:Source is the CloudFront origin-facing prefix list, not 0.0.0.0/0
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from CloudFront origin-facing IPs"
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  description       = "ALB to pod targets in the VPC and health checks"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ---------------- IRSA (IAM Roles for Service Accounts)
# Mỗi role chỉ tin đúng một ServiceAccount của cụm này, qua OIDC provider mà module EKS tạo. Pod nhận token
# từ webhook của EKS (ServiceAccount có annotation eks.amazonaws.com/role-arn) và đổi lấy credential tạm.
# OIDC provider gắn với từng cụm: dựng lại cụm thì phải apply lại các layer có role IRSA để cập nhật trust.
data "aws_iam_policy_document" "irsa_trust" {
  for_each = local.pod_identities

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:sub"
      values   = ["system:serviceaccount:${each.value.namespace}:${each.value.service_account}"]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "keda" {
  statement {
    sid       = "ReadQueueDepth"
    actions   = ["sqs:GetQueueAttributes"]
    resources = [data.aws_sqs_queue.transcode.arn]
  }
}

resource "aws_iam_policy" "keda" {
  name        = "${local.name_prefix}-keda"
  description = "KEDA operator: read transcode queue depth for autoscaling"
  policy      = data.aws_iam_policy_document.keda.json
}

locals {
  pod_identities = {
    worker = {
      namespace       = local.namespace
      service_account = "streamforge-worker"
      policy_arn      = data.aws_iam_policy.worker.arn
    }
    keda = {
      namespace       = "keda"
      service_account = "keda-operator"
      policy_arn      = aws_iam_policy.keda.arn
    }
  }
}

resource "aws_iam_role" "pod" {
  for_each = local.pod_identities

  name               = "${local.name_prefix}-${each.key}-pod"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust[each.key].json
}

resource "aws_iam_role_policy_attachment" "pod" {
  for_each = local.pod_identities

  role       = aws_iam_role.pod[each.key].name
  policy_arn = each.value.policy_arn
}

# ---------------- Outputs
output "cluster_name" {
  value = module.eks.cluster_name
}

output "kubeconfig_command" {
  value = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.aws_region}"
}

output "ecr_repository_urls" {
  value = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "pod_role_arns" {
  description = "Role IRSA của worker và KEDA (k8s/deploy.sh gắn vào ServiceAccount)"
  value       = { for k, r in aws_iam_role.pod : k => r.arn }
}

output "oidc_provider_arn" {
  value = module.eks.oidc_provider_arn
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}
