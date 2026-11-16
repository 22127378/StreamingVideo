# Layer áp dụng đầu tiên: bucket state (KMS) và cảnh báo chi phí.

locals {
  layer = "backend"
}

variable "budget_limit_usd" {
  description = "Monthly cost limit for the budget alarm"
  type        = number
  default     = 20
}

variable "budget_alert_emails" {
  description = "Who receives budget alerts. Set it in terraform.tfvars (gitignored)"
  type        = list(string)
  default     = []
}

variable "enable_budget" {
  description = "Create the budget alarm. Only turn this off for LocalStack tests"
  type        = bool
  default     = true
}

module "backend" {
  source      = "../../modules/backend"
  name_prefix = local.name_prefix
}

module "budget" {
  source = "../../modules/budget"
  count  = var.enable_budget ? 1 : 0

  name_prefix       = local.name_prefix
  monthly_limit_usd = var.budget_limit_usd
  alert_emails      = var.budget_alert_emails
}

output "state_bucket" {
  value = module.backend.bucket
}

output "backend_hcl" {
  description = "Save as terraform/backend.hcl, then run terraform init -backend-config=../../backend.hcl in the other layers"
  value       = <<-EOT
    bucket     = "${module.backend.bucket}"
    region     = "${var.aws_region}"
    kms_key_id = "${module.backend.kms_key_arn}"
  EOT
}
