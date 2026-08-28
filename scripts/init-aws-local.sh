#!/bin/bash
set -eo pipefail

echo "=================================================="
echo "🚀 [StreamForge] Initializing Local AWS Resources..."
echo "=================================================="

AWS_REGION="us-east-1"
RAW_BUCKET="streamforge-raw-uploads"
PROCESSED_BUCKET="streamforge-processed"
QUEUE_NAME="streamforge-transcode-queue"
DLQ_NAME="streamforge-transcode-dlq"
DYNAMO_TABLE="streamforge-videos"

# 1. Create S3 Buckets & Set CORS
echo "📦 1. Creating S3 Buckets..."
awslocal s3 mb s3://${RAW_BUCKET} --region ${AWS_REGION} || true
awslocal s3 mb s3://${PROCESSED_BUCKET} --region ${AWS_REGION} || true

if [ -f /tmp/cors-config.json ]; then
  echo "🌐 Applying CORS Configuration to S3 Buckets..."
  awslocal s3api put-bucket-cors --bucket ${RAW_BUCKET} --cors-configuration file:///tmp/cors-config.json || true
  awslocal s3api put-bucket-cors --bucket ${PROCESSED_BUCKET} --cors-configuration file:///tmp/cors-config.json || true
fi

# 2. Create SQS Queues (DLQ + Main Queue)
echo "📬 2. Creating SQS Queues..."
DLQ_URL=$(awslocal sqs create-queue --queue-name ${DLQ_NAME} --region ${AWS_REGION} --query 'QueueUrl' --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url ${DLQ_URL} --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

echo "DLQ created: ${DLQ_ARN}"

REDRIVE_POLICY="{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"3\"}"
awslocal sqs create-queue \
  --queue-name ${QUEUE_NAME} \
  --attributes "{\"RedrivePolicy\":$(echo $REDRIVE_POLICY | jq -R .),\"VisibilityTimeout\":\"300\"}" \
  --region ${AWS_REGION} || true

echo "Main SQS Queue created: ${QUEUE_NAME}"

# 3. Create DynamoDB Table
echo "🗄️ 3. Creating DynamoDB Table (${DYNAMO_TABLE})..."
awslocal dynamodb create-table \
  --table-name ${DYNAMO_TABLE} \
  --attribute-definitions AttributeName=videoId,AttributeType=S \
  --key-schema AttributeName=videoId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ${AWS_REGION} || true

echo "=================================================="
echo "✅ [StreamForge] Local AWS Resources Ready!"
echo "=================================================="
