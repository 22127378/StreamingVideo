# EKS Auto Mode: AWS quản lý node (Karpenter), ALB controller, EBS CSI và Pod Identity agent.
# Node API/KEDA và node Spot cho worker được khai báo bằng NodePool trong k8s/cluster/.
# Pod dùng EKS Pod Identity với các policy của layer identity.

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

data "aws_iam_policy" "api" {
  name = "${local.name_prefix}-api"
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

  # Người chạy terraform apply có quyền admin trong cluster (access entry)
  enable_cluster_creator_admin_permissions = true

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
resource "aws_ecr_repository" "app" {
  for_each = toset(["api", "worker"])

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
  name        = "${local.name_prefix}-alb"
  description = "API load balancer: HTTP from CloudFront origin-facing IPs only"
  vpc_id      = data.aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ---------------- EKS Pod Identity
data "aws_iam_policy_document" "pod_identity_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
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
    api = {
      namespace       = local.namespace
      service_account = "streamforge-api"
      policy_arn      = data.aws_iam_policy.api.arn
    }
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
  assume_role_policy = data.aws_iam_policy_document.pod_identity_trust.json
}

resource "aws_iam_role_policy_attachment" "pod" {
  for_each = local.pod_identities

  role       = aws_iam_role.pod[each.key].name
  policy_arn = each.value.policy_arn
}

resource "aws_eks_pod_identity_association" "pod" {
  for_each = local.pod_identities

  cluster_name    = module.eks.cluster_name
  namespace       = each.value.namespace
  service_account = each.value.service_account
  role_arn        = aws_iam_role.pod[each.key].arn
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

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}
