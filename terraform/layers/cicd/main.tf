# GitHub Actions đăng nhập AWS bằng OIDC: không có access key tĩnh nào trong GitHub Secrets.
# Workflow xin token OIDC của GitHub, STS đổi lấy credential tạm (1 giờ) của role bên dưới.
# Layer này tách khỏi compute (hay bị destroy) và chỉ cần apply một lần. ECR repo nằm ở layer
# compute; quyền ở đây tính theo tên repo nên không phụ thuộc state của compute.

locals {
  layer = "cicd"
}

# Một provider OIDC cho mỗi account. Thumbprint không còn được AWS dùng để xác thực GitHub,
# nhưng API vẫn yêu cầu trường này.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_policy_document" "github_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Chỉ workflow chạy trên nhánh main của đúng repo. Pull request (kể cả từ fork) có "sub"
    # dạng repo:<repo>:pull_request nên không assume được.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/${var.github_branch}"]
    }
  }
}

resource "aws_iam_role" "github_ci" {
  name                 = "${local.name_prefix}-github-ci"
  description          = "GitHub Actions on ${var.github_repository}@${var.github_branch}: push images to ECR"
  assume_role_policy   = data.aws_iam_policy_document.github_trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "push_images" {
  # GetAuthorizationToken không giới hạn được theo resource
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "PushServiceImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = ["arn:aws:ecr:${var.aws_region}:${local.account_id}:repository/${local.name_prefix}-*"]
  }
}

resource "aws_iam_role_policy" "push_images" {
  name   = "push-images"
  role   = aws_iam_role.github_ci.id
  policy = data.aws_iam_policy_document.push_images.json
}

output "github_ci_role_arn" {
  description = "Set as the AWS_CI_ROLE_ARN repository variable in GitHub"
  value       = aws_iam_role.github_ci.arn
}
