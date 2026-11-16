variable "bucket_name" {
  description = "Globally unique bucket name"
  type        = string
}

variable "force_destroy" {
  description = "Allow terraform destroy to delete a non-empty bucket"
  type        = bool
  default     = false
}

variable "expire_after_days" {
  description = "Delete objects under expire_prefix after this many days. null keeps them forever"
  type        = number
  default     = null
}

variable "expire_prefix" {
  description = "Prefix the expiration rule applies to"
  type        = string
  default     = ""
}

variable "allow_cloudfront_read" {
  description = "Allow CloudFront distributions in this account (Origin Access Control) to read objects"
  type        = bool
  default     = false
}

variable "cors_rules" {
  description = "CORS rules for browser access"
  type = list(object({
    allowed_methods = list(string)
    allowed_origins = list(string)
    allowed_headers = optional(list(string), ["*"])
    expose_headers  = optional(list(string), ["ETag"])
    max_age_seconds = optional(number, 3000)
  }))
  default = []
}
