output "api_policy_arn" {
  value = aws_iam_policy.api.arn
}

output "worker_policy_arn" {
  value = aws_iam_policy.worker.arn
}

output "dev_role_arns" {
  description = "Map of service name to dev role ARN (empty when create_dev_roles is false)"
  value       = { for k, r in aws_iam_role.dev : k => r.arn }
}
