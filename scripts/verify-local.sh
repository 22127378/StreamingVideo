#!/bin/bash
set -e

ENDPOINT="http://localhost:4566"
REGION="us-east-1"

echo "=================================================="
echo "🔍 [StreamForge] Checking LocalStack Services..."
echo "=================================================="

# Check health
if curl -s -f "${ENDPOINT}/_localstack/health" > /dev/null; then
    echo "✅ LocalStack is UP!"
else
    echo "❌ LocalStack is NOT running at ${ENDPOINT}. Run 'docker compose up -d' first."
    exit 1
fi

echo ""
echo "📦 S3 Buckets:"
aws --endpoint-url=${ENDPOINT} s3 ls || true

echo ""
echo "🗄️ DynamoDB Tables:"
aws --endpoint-url=${ENDPOINT} dynamodb list-tables --region ${REGION} || true

echo ""
echo "📬 SQS Queues:"
aws --endpoint-url=${ENDPOINT} sqs list-queues --region ${REGION} || true

echo ""
echo "=================================================="
echo "🎉 Verification completed!"
echo "=================================================="
