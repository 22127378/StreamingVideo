output "name" {
  value = aws_dynamodb_table.videos.name
}

output "arn" {
  value = aws_dynamodb_table.videos.arn
}

output "created_at_index_name" {
  value = var.created_at_index_name
}
