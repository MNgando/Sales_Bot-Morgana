# Create (once) the S3 bucket that holds this project's Terraform state, in
# WHATEVER account your AWS creds point at, and write backend.hcl for init.
# Run in PowerShell (where `aws` is on PATH):
#   powershell -ExecutionPolicy Bypass -File .\create-state-bucket.ps1
# Idempotent; needs only S3 permissions.

$Region = if ($env:AWS_REGION) { $env:AWS_REGION } elseif ($env:AWS_DEFAULT_REGION) { $env:AWS_DEFAULT_REGION } else { 'us-east-1' }

# Account id -> bucket name (so nothing is hardcoded to one account). Doubles as
# the credentials check.
$Account = aws sts get-caller-identity --query Account --output text 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "x AWS credentials not valid: $Account"
  Write-Host "  Configure your access key (aws configure) or paste portal creds, then re-run."
  exit 1
}
$Bucket = "istari-sales-bot-morgana-tfstate-$Account"
Write-Host "> Account $Account - ensuring S3 state bucket: $Bucket ($Region)"

# 1. Create the bucket (tolerate 'already owned' on re-run). us-east-1 takes no
#    LocationConstraint; every other region requires it.
if ($Region -eq 'us-east-1') {
  aws s3api create-bucket --bucket $Bucket --region $Region
} else {
  aws s3api create-bucket --bucket $Bucket --region $Region --create-bucket-configuration "LocationConstraint=$Region"
}
if ($LASTEXITCODE -eq 0) { Write-Host "  - created bucket" } else { Write-Host "  - bucket already exists / create skipped - continuing" }

# 2. Versioning - keep state history so a bad apply can be rolled back.
aws s3api put-bucket-versioning --bucket $Bucket --versioning-configuration Status=Enabled
Write-Host "  - versioning enabled"

# 3. Default encryption at rest (SSE-S3 / AES256). JSON via a temp file to avoid
#    PowerShell quoting; ASCII so there's no BOM to trip up the parser.
$encFile = Join-Path $env:TEMP 'sbm-enc.json'
'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}' | Set-Content -Path $encFile -Encoding ascii
aws s3api put-bucket-encryption --bucket $Bucket --server-side-encryption-configuration "file://$encFile"
Remove-Item $encFile -ErrorAction SilentlyContinue
Write-Host "  - default encryption enabled"

# 4. Block all public access - state can contain sensitive values.
aws s3api put-public-access-block --bucket $Bucket --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
Write-Host "  - public access blocked"

# 5. Write backend.hcl (git-ignored) so `terraform init -backend-config=backend.hcl`
#    picks up this account's bucket + region without anything hardcoded in main.tf.
$backendFile = Join-Path $PSScriptRoot 'backend.hcl'
@("bucket = ""$Bucket""", "region = ""$Region""") | Set-Content -Path $backendFile -Encoding ascii
Write-Host "  - wrote backend.hcl"

Write-Host "OK State bucket ready. Next: terraform init -backend-config=backend.hcl"
