# Create (once) the S3 bucket that holds this project's Terraform state, matching
# the backend block in main.tf. Run in PowerShell (where `aws` is on PATH):
#   powershell -ExecutionPolicy Bypass -File .\create-state-bucket.ps1
# Idempotent; needs only S3 permissions (PowerUserAccess has them).

$Bucket = 'istari-sales-bot-morgana-tfstate-572693800901'
$Region = 'us-east-1'

# Credentials check — fail early with a clear message if the SSO session lapsed.
$acct = aws sts get-caller-identity --query Account --output text 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "x AWS credentials not valid: $acct"
  Write-Host "  Run 'aws sso login' (or your normal login), then re-run this script."
  exit 1
}
Write-Host "> Account $acct - ensuring S3 state bucket: $Bucket ($Region)"

# 1. Create the bucket (tolerate 'already owned' on re-run). us-east-1 takes no
#    LocationConstraint.
aws s3api create-bucket --bucket $Bucket --region $Region
if ($LASTEXITCODE -eq 0) { Write-Host "  - created bucket" } else { Write-Host "  - bucket already exists / create skipped - continuing" }

# 2. Versioning - keep state history so a bad apply can be rolled back.
aws s3api put-bucket-versioning --bucket $Bucket --versioning-configuration Status=Enabled
Write-Host "  - versioning enabled"

# 3. Default encryption at rest (SSE-S3 / AES256). JSON via a temp file to avoid
#    PowerShell quoting issues; ASCII so there's no BOM to trip up the parser.
$encFile = Join-Path $env:TEMP 'sbm-enc.json'
'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}' | Set-Content -Path $encFile -Encoding ascii
aws s3api put-bucket-encryption --bucket $Bucket --server-side-encryption-configuration "file://$encFile"
Remove-Item $encFile -ErrorAction SilentlyContinue
Write-Host "  - default encryption enabled"

# 4. Block all public access - state can contain sensitive values.
aws s3api put-public-access-block --bucket $Bucket --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
Write-Host "  - public access blocked"

Write-Host "OK State bucket ready. Next: terraform init -migrate-state  (or: terraform init)"
