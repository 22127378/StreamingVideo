variable "name_prefix" {
  type = string
}

variable "raw_bucket_arn" {
  type = string
}

variable "processed_bucket_arn" {
  type = string
}

variable "table_arn" {
  type = string
}

variable "queue_arn" {
  type = string
}

variable "create_dev_roles" {
  description = "Create <prefix>-api-dev and <prefix>-worker-dev roles to run the services locally against real AWS"
  type        = bool
  default     = true
}

variable "dev_role_trusted_principals" {
  description = "IAM principal ARNs allowed to assume the dev roles. Empty means any principal in this account that has sts:AssumeRole"
  type        = list(string)
  default     = []
}
