# Đăng nhập bằng Amazon Cognito.
# - Người dùng tự đăng ký bằng email, đăng nhập qua trang có sẵn của Cognito (OAuth code + PKCE).
# - Gói Premium = thành viên group "premium". API (POST /api/auth/upgrade) thêm người dùng vào group.
# - API xác minh access token; frontend nhận cấu hình qua GET /api/auth/config.
# Áp dụng sau layer delivery (cần domain CloudFront cho callback URL) và compute (role của pod API).

locals {
  layer = "auth"
}

variable "app_urls" {
  description = "Origins of the frontend, used as OAuth callback and logout URLs, for example the CloudFront domain and http://localhost:5173"
  type        = list(string)
}

variable "deletion_protection" {
  type    = bool
  default = true
}

resource "aws_cognito_user_pool" "this" {
  name                = local.name_prefix
  user_pool_tier      = "LITE"
  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  # Nới để có tài khoản test dễ nhớ (theo yêu cầu): chỉ cần 8 ký tự, không bắt buộc chữ.
  # Nên bật lại require_lowercase/require_numbers trước khi mở trang cho người dùng thật.
  password_policy {
    minimum_length                   = 8
    require_lowercase                = false
    require_numbers                  = false
    require_symbols                  = false
    require_uppercase                = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Cognito tự gửi email xác minh (giới hạn 50 email/ngày, đủ cho dev)
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }
}

resource "aws_cognito_user_group" "premium" {
  name         = "premium"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Premium viewers: may watch premium videos"
}

# Admin: xem mọi video và quản lý (xoá) video của mọi người
resource "aws_cognito_user_group" "admin" {
  name         = "admin"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Administrators: may manage every video"
}

resource "aws_cognito_user_pool_domain" "this" {
  domain                = "${local.name_prefix}-${local.account_id}"
  user_pool_id          = aws_cognito_user_pool.this.id
  managed_login_version = 1 # trang đăng nhập classic, dùng được với tier LITE
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name_prefix}-web"
  user_pool_id = aws_cognito_user_pool.this.id

  # Ứng dụng trên trình duyệt không giữ được secret: client công khai + PKCE
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = [for u in var.app_urls : "${trimsuffix(u, "/")}/"]
  logout_urls                          = [for u in var.app_urls : "${trimsuffix(u, "/")}/"]

  # USER_SRP_AUTH: form đăng nhập trong trang web (mật khẩu không gửi dưới dạng gốc).
  # ADMIN_USER_PASSWORD_AUTH chỉ gọi được bằng IAM credentials (smoke test), không mở cho trình duyệt.
  explicit_auth_flows = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_ADMIN_USER_PASSWORD_AUTH"]

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
}

# Pod API được thêm người dùng vào group premium (POST /api/auth/upgrade)
data "aws_iam_role" "api_pod" {
  name = "${local.name_prefix}-api-pod"
}

data "aws_iam_policy_document" "api_cognito" {
  statement {
    sid       = "UpgradeToPremium"
    actions   = ["cognito-idp:AdminAddUserToGroup"]
    resources = [aws_cognito_user_pool.this.arn]
  }
}

resource "aws_iam_role_policy" "api_cognito" {
  name   = "cognito-upgrade"
  role   = data.aws_iam_role.api_pod.name
  policy = data.aws_iam_policy_document.api_cognito.json
}

output "user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "domain" {
  description = "Hosted sign-in domain, passed to the frontend through GET /api/auth/config"
  value       = "https://${aws_cognito_user_pool_domain.this.domain}.auth.${var.aws_region}.amazoncognito.com"
}
