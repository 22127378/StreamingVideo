#!/usr/bin/env bash
# Build frontend và đẩy lên bucket web sau CloudFront (layer terraform delivery).
#   ./src/frontend/deploy.sh
# File trong assets/ có hash trong tên nên cache 1 năm; index.html luôn no-cache để
# người dùng nhận bản mới ngay sau deploy.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
TF="$DIR/../../terraform/layers/delivery"
BUCKET=$(terraform -chdir="$TF" output -raw web_bucket)
DISTRIBUTION=$(terraform -chdir="$TF" output -raw distribution_id)
SITE=$(terraform -chdir="$TF" output -raw site_url)

cd "$DIR"
npm ci --no-audit --no-fund
npm run build

aws s3 sync dist/assets "s3://$BUCKET/assets" --delete \
  --cache-control "public, max-age=31536000, immutable"
aws s3 sync dist "s3://$BUCKET" --delete --exclude "assets/*" \
  --cache-control "no-cache"

aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" --paths "/index.html" "/" \
  --query 'Invalidation.Id' --output text

echo "Deployed to $SITE"
