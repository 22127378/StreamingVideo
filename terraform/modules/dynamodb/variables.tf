variable "table_name" {
  type = string
}

variable "created_at_index_name" {
  description = "Must match DYNAMODB_VIDEOS_CREATED_AT_INDEX of the API"
  type        = string
  default     = "entityType-createdAt-index"
}

variable "deletion_protection" {
  description = "Block table deletion, including terraform destroy"
  type        = bool
  default     = true
}

variable "point_in_time_recovery" {
  type    = bool
  default = true
}
