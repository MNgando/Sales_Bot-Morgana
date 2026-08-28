#!/usr/bin/env bash
#
# Create (once) the S3 bucket that holds this project's Terraform state, matching
# the backend block in main.tf. Safe to re-run — each step is idempotent.
#
# Needs only S3 permissions (PowerUserAccess has them). Run with your AWS creds:
#   bash create-state-bucket.sh
#
# After this succeeds:
#   terraform init -migrate-state   # if you have local state to move up
#   terraform init                  # otherwise
set -euo pipefail

BUCKET="istari-sales-bot-morgana-tfstate-572693800901"
REGION="us-east-1"

echo "▶ Ensuring S3 state bucket: $BUCKET ($REGION)"

# 1. Create the bucket if it doesn't exist. us-east-1 must NOT get a
#    LocationConstraint (the API rejects it for that region).
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "  • bucket already exists — leaving it as-is"
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  echo "  • created bucket"
fi

# 2. Versioning — keep state history so a bad apply can be rolled back.
aws s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
echo "  • versioning enabled"

# 3. Default encryption at rest (SSE-S3 / AES256).
aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
echo "  • default encryption enabled"

# 4. Block all public access — state can contain sensitive values.
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
echo "  • public access blocked"

echo "✓ State bucket ready. Next: terraform init -migrate-state  (or: terraform init)"
