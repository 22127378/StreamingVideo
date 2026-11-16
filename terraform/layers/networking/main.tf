# VPC cho EKS: 2 AZ, subnet public (ALB, NAT) và private (node).
# Một NAT gateway dùng chung để tiết kiệm (~$32/tháng thay vì ~$64); nếu AZ chứa NAT gặp sự cố,
# node ở AZ còn lại mất đường ra internet. Chấp nhận được cho môi trường dev.

locals {
  layer = "networking"
  azs   = slice(data.aws_availability_zones.available.names, 0, 2)
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

data "aws_availability_zones" "available" {
  state = "available"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = local.name_prefix
  cidr = var.vpc_cidr
  azs  = local.azs

  public_subnets  = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 4, i + 1)]

  enable_nat_gateway   = true
  single_nat_gateway   = true
  enable_dns_hostnames = true

  # Tag để ALB (EKS Auto Mode) biết đặt load balancer ở đâu, và để layer compute tìm subnet
  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
    Tier                     = "public"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
    Tier                              = "private"
  }
}

output "vpc_id" {
  value = module.vpc.vpc_id
}

output "private_subnet_ids" {
  value = module.vpc.private_subnets
}

output "public_subnet_ids" {
  value = module.vpc.public_subnets
}
