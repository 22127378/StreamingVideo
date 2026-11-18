#!/bin/bash
set -eo pipefail

echo "[StreamForge] Initializing local AWS resources..."

AWS_REGION="us-east-1"
RAW_BUCKET="streamforge-raw-uploads"
PROCESSED_BUCKET="streamforge-processed"
QUEUE_NAME="streamforge-transcode-queue"
DLQ_NAME="streamforge-transcode-dlq"

# 1. Create S3 Buckets & Set CORS
echo "1. Creating S3 Buckets..."
awslocal s3 mb s3://${RAW_BUCKET} --region ${AWS_REGION} || true
awslocal s3 mb s3://${PROCESSED_BUCKET} --region ${AWS_REGION} || true

if [ -f /tmp/cors-config.json ]; then
  echo "Applying CORS Configuration to S3 Buckets..."
  awslocal s3api put-bucket-cors --bucket ${RAW_BUCKET} --cors-configuration file:///tmp/cors-config.json || true
  awslocal s3api put-bucket-cors --bucket ${PROCESSED_BUCKET} --cors-configuration file:///tmp/cors-config.json || true
fi

# 2. Create SQS Queues (DLQ + Main Queue)
echo "2. Creating SQS Queues..."
DLQ_URL=$(awslocal sqs create-queue --queue-name ${DLQ_NAME} --region ${AWS_REGION} --query 'QueueUrl' --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url ${DLQ_URL} --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

echo "DLQ created: ${DLQ_ARN}"

# RedrivePolicy là một chuỗi JSON lồng trong JSON. Image LocalStack không có jq nên escape thủ công.
# maxReceiveCount phải khớp SQS_MAX_RECEIVE_COUNT của worker.
QUEUE_ATTRIBUTES=$(printf '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"3\\"}","VisibilityTimeout":"300"}' "${DLQ_ARN}")
awslocal sqs create-queue \
  --queue-name ${QUEUE_NAME} \
  --attributes "${QUEUE_ATTRIBUTES}" \
  --region ${AWS_REGION}

echo "Main SQS Queue created: ${QUEUE_NAME}"

# 3. EventBridge: bus sự kiện giữa các service, hàng đợi của catalog, rule chuyển sự kiện
echo "3. Creating EventBridge bus and rules..."
BUS_NAME="streamforge-local"
awslocal events create-event-bus --name ${BUS_NAME} --region ${AWS_REGION} >/dev/null 2>&1 || true

CATALOG_DLQ_URL=$(awslocal sqs create-queue --queue-name streamforge-catalog-events-dlq --region ${AWS_REGION} --query 'QueueUrl' --output text)
CATALOG_DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url ${CATALOG_DLQ_URL} --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
CATALOG_ATTRIBUTES=$(printf '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"10\\"}","VisibilityTimeout":"60"}' "${CATALOG_DLQ_ARN}")
CATALOG_URL=$(awslocal sqs create-queue --queue-name streamforge-catalog-events --attributes "${CATALOG_ATTRIBUTES}" --region ${AWS_REGION} --query 'QueueUrl' --output text)
CATALOG_ARN=$(awslocal sqs get-queue-attributes --queue-url ${CATALOG_URL} --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
TRANSCODE_URL=$(awslocal sqs get-queue-url --queue-name ${QUEUE_NAME} --region ${AWS_REGION} --query 'QueueUrl' --output text)
TRANSCODE_ARN=$(awslocal sqs get-queue-attributes --queue-url ${TRANSCODE_URL} --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# VideoUploaded -> hàng đợi transcode, chỉ phần detail (đó chính là job của worker)
awslocal events put-rule --name to-transcode --event-bus-name ${BUS_NAME} --region ${AWS_REGION} \
  --event-pattern '{"source":["streamforge.upload"],"detail-type":["VideoUploaded"]}' >/dev/null
awslocal events put-targets --rule to-transcode --event-bus-name ${BUS_NAME} --region ${AWS_REGION} \
  --targets "Id=transcode,Arn=${TRANSCODE_ARN},InputPath=\$.detail" >/dev/null
# Mọi sự kiện của StreamForge -> catalog
awslocal events put-rule --name to-catalog --event-bus-name ${BUS_NAME} --region ${AWS_REGION} \
  --event-pattern '{"source":[{"prefix":"streamforge."}]}' >/dev/null
awslocal events put-targets --rule to-catalog --event-bus-name ${BUS_NAME} --region ${AWS_REGION} \
  --targets "Id=catalog,Arn=${CATALOG_ARN}" >/dev/null
echo "Event bus ${BUS_NAME}: VideoUploaded -> ${QUEUE_NAME}, all events -> streamforge-catalog-events"

echo "[StreamForge] Local AWS resources are ready."
