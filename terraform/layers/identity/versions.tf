terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # bucket, region, kms_key_id lấy từ ../../backend.hcl (output backend_hcl của layer backend)
  backend "s3" {
    key          = "identity/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
