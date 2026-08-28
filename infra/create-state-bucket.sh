#!/usr/bin/env bash
#
# Create (once) the S3 bucket that holds this project's Terraform state, in
# WHATEVER account your AWS creds point at, and write backend.hcl for init.
# Safe to re-run — each step is idempotent. Needs only S3 permissions.
#   bash create-state-bucket.sh
set -euo pipefail

# On Windows Git Bash the AWS CLI is often not on PATH even when it works in
# PowerShell. Find aws.exe in its standard install locations.
if ! command -v aws >/dev/null 2>&1; then
  for d in "/c/Program Files/Amazon/AWSCLIV2" "/c/Program Files (x86)/Amazon/AWSCLIV2"; do
    if [ -x "$d/aws.exe" ]; then PATH="$PATH:$d"; break; fi
  done
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "✖ aws CLI not found. Run from a shell where 'aws --version' works, or use create-state-bucket.ps1 in PowerShell." >&2
  exit 1
fi

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

# Account id -> bucket name (nothing hardcoded to one account); doubles as the
# credentials check.
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="istari-sales-bot-morgana-tfstate-${ACCOUNT}"
echo "▶ Account ${ACCOUNT} — ensuring S3 state bucket: ${BUCKET} (${REGION})"

# 1. Create the bucket if it doesn't exist. us-east-1 must NOT get a
#    LocationConstraint; every other region requires it.
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "  • bucket already exists — leaving it as-is"
elif [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  echo "  • created bucket"
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=${REGION}"
  echo "  • created bucket"
fi

aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
echo "  • versioning enabled"

aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
echo "  • default encryption enabled"

aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
echo "  • public access blocked"

# Write backend.hcl (git-ignored) for `terraform init -backend-config=backend.hcl`.
printf 'bucket = "%s"\nregion = "%s"\n' "$BUCKET" "$REGION" > "$(dirname "$0")/backend.hcl"
echo "  • wrote backend.hcl"

echo "✓ State bucket ready. Next: terraform init -backend-config=backend.hcl"
