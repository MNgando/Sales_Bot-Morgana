terraform {
  # >= 1.10: S3 backend native locking (use_lockfile) was added in 1.10.
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # LOCAL STATE (default backend): terraform.tfstate lives in this infra/ dir.
  # We deploy into account 572693800901, which does NOT have signal-bot's S3
  # state bucket (that's in a different account), so a remote S3 backend isn't
  # available here. Local state is fine for a single-operator deploy. To make it
  # team-shareable later, create an S3 bucket in THIS account and add a
  # `backend "s3" { bucket = "...", key = "sales-bot-morgana/terraform.tfstate",
  # region = "us-east-1", encrypt = true, use_lockfile = true }` block, then
  # `terraform init -migrate-state`.
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
