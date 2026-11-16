output "bucket" {
  description = "State bucket name"
  value       = aws_s3_bucket.state.id
}

output "kms_key_arn" {
  description = "KMS key that encrypts the state bucket"
  value       = aws_kms_key.state.arn
}
