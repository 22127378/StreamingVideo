terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State của layer này nằm trên máy (terraform.tfstate) vì bucket state do chính layer này tạo.
  # Xem terraform/README.md để chuyển nó lên S3 sau khi tạo xong.
}
