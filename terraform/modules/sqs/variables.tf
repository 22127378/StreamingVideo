variable "name" {
  description = "Queue name. The dead letter queue is named <name>-dlq"
  type        = string
}

variable "visibility_timeout_seconds" {
  description = "Must match SQS_VISIBILITY_TIMEOUT of the worker"
  type        = number
  default     = 300
}

variable "message_retention_seconds" {
  description = "How long an unprocessed job stays in the main queue"
  type        = number
  default     = 345600 # 4 ngày
}

variable "max_receive_count" {
  description = "Deliveries before a message moves to the DLQ. Must match SQS_MAX_RECEIVE_COUNT of the worker"
  type        = number
  default     = 3
}
