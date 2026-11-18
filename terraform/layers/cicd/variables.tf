variable "project" {
  type    = string
  default = "streamforge"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "github_repository" {
  description = "GitHub repository (owner/name) allowed to push images"
  type        = string
  default     = "22127378/StreamingVideo"
}

variable "github_branch" {
  description = "Only workflow runs on this branch can assume the CI role"
  type        = string
  default     = "main"
}
