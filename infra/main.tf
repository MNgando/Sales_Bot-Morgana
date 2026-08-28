terraform {
  # >= 1.10: S3 backend native locking (use_lockfile) was added in 1.10.
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # SHARED STATE in S3 — PARTIAL backend config. The bucket name is account-specific
  # (Terraform backends can't use variables), so it is NOT hardcoded here; it's
  # supplied at init time. This keeps the repo account-agnostic.
  #
  # ONE-TIME SETUP (works in whatever account your creds point at):
  #   1. Create the bucket + generate backend.hcl:
  #        pwsh: powershell -ExecutionPolicy Bypass -File .\create-state-bucket.ps1
  #        bash: bash create-state-bucket.sh
  #      The script derives the bucket name from your account id and writes it to
  #      backend.hcl (git-ignored).
  #   2. terraform init -backend-config=backend.hcl
  #      (add -reconfigure when switching to a different account/bucket, or
  #       -migrate-state to copy existing state up).
  #
  # use_lockfile = S3-native state locking (Terraform 1.10+) — no DynamoDB table.
  backend "s3" {
    key          = "sales-bot-morgana/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
    # bucket + region come from backend.hcl at init time.
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "istari-sales-bot-morgana" # cost-allocation tag the AWS Budget filters on
      Service     = local.service_name
      Owner       = "customer-success"
      Environment = "internal"
      ManagedBy   = "terraform"
    }
  }
}

locals {
  service_name = "sales-bot-morgana" # Slack display name is "Morgana"
  secret_name  = "istari-sales-bot-morgana"
}
