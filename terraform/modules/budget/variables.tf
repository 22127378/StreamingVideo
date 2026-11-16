variable "name_prefix" {
  description = "Prefix for resource names"
  type        = string
}

variable "monthly_limit_usd" {
  description = "Monthly cost limit in USD"
  type        = number
}

variable "alert_emails" {
  description = "Email addresses that receive budget alerts"
  type        = list(string)

  validation {
    condition     = length(var.alert_emails) > 0
    error_message = "At least one alert email is required."
  }
}
