Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "🔍 [StreamForge] Checking LocalStack Services..." -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

$endpoint = "http://localhost:4566"

# 1. Check Health
try {
    $health = Invoke-RestMethod -Uri "$endpoint/_localstack/health" -Method Get -TimeoutSec 5
    Write-Host "✅ LocalStack is UP! Status: $($health.services | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Host "❌ LocalStack is NOT running on $endpoint. Please run: docker compose up -d" -ForegroundColor Red
    exit 1
}

# 2. Check S3 Buckets
Write-Host "`n📦 Checking S3 Buckets..." -ForegroundColor Yellow
try {
    $s3Response = aws --endpoint-url=$endpoint s3 ls 2>&1
    Write-Host $s3Response
} catch {
    Write-Host "⚠️ S3 check via AWS CLI skipped or failed." -ForegroundColor DarkYellow
}

# 3. Check DynamoDB Tables
Write-Host "`n🗄️ Checking DynamoDB Tables..." -ForegroundColor Yellow
try {
    $dynamoResponse = aws --endpoint-url=$endpoint dynamodb list-tables --region us-east-1 2>&1
    Write-Host $dynamoResponse
} catch {
    Write-Host "⚠️ DynamoDB check via AWS CLI skipped or failed." -ForegroundColor DarkYellow
}

# 4. Check SQS Queues
Write-Host "`n📬 Checking SQS Queues..." -ForegroundColor Yellow
try {
    $sqsResponse = aws --endpoint-url=$endpoint sqs list-queues --region us-east-1 2>&1
    Write-Host $sqsResponse
} catch {
    Write-Host "⚠️ SQS check via AWS CLI skipped or failed." -ForegroundColor DarkYellow
}

Write-Host "`n==================================================" -ForegroundColor Cyan
Write-Host "🎉 Local verification check completed!" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
