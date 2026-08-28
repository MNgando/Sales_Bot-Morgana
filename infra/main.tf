terraform {
  # >= 1.10: S3 backend native locking (use_lockfile) was added in 1.10.
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # SHARED STATE in S3 — so anyone with account creds (e.g. an admin with IAM
  # permissions) can run plan/apply against the same state, from their own machine.
  #
  # ONE-TIME SETUP before `terraform init`:
  #   1. Create the bucket: `bash create-state-bucket.sh`  (needs S3 perms only,
  #      which PowerUserAccess has). It enables versioning + encryption + blocks
  #      public access.
  #   2. If you already have LOCAL state here from an earlier apply, migrate it up:
  #        terraform init -migrate-state     (answer "yes" to copy it to S3)
  #      Otherwise a plain `terraform init` configures the backend.
  #
  # use_lockfile = S3-native state locking (Terraform 1.10+) — no DynamoDB table.
  backend "s3" {
    bucket       = "istari-sales-bot-morgana-tfstate-572693800901"
    key          = "sales-bot-morgana/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
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
