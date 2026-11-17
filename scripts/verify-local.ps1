Write-Host "[StreamForge] Checking LocalStack services..." -ForegroundColor Cyan

$endpoint = "http://localhost:4566"

# 1. Check Health
try {
    $health = Invoke-RestMethod -Uri "$endpoint/_localstack/health" -Method Get -TimeoutSec 5
    Write-Host "LocalStack is up. Services: $($health.services | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Host "LocalStack is NOT running on $endpoint. Please run: docker compose up -d" -ForegroundColor Red
    exit 1
}

# 2. Check S3 Buckets
Write-Host "`nChecking S3 Buckets..." -ForegroundColor Yellow
try {
    $s3Response = aws --endpoint-url=$endpoint s3 ls 2>&1
    Write-Host $s3Response
} catch {
    Write-Host "S3 check via AWS CLI skipped or failed." -ForegroundColor DarkYellow
}

# 3. Check SQS Queues
Write-Host "`nChecking SQS Queues..." -ForegroundColor Yellow
try {
    $sqsResponse = aws --endpoint-url=$endpoint sqs list-queues --region us-east-1 2>&1
    Write-Host $sqsResponse
} catch {
    Write-Host "SQS check via AWS CLI skipped or failed." -ForegroundColor DarkYellow
}

Write-Host "`nVerification completed." -ForegroundColor Cyan
