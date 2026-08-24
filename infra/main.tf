terraform {
  # >= 1.10: S3 backend native locking (use_lockfile) was added in 1.10.
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Reuses the same in-account state bucket signal-bot uses, under our own key.
  # use_lockfile = S3 native locking (Terraform 1.10+), no DynamoDB table needed.
  # If your account/bucket differ, change these before `terraform init`.
  backend "s3" {
    bucket       = "istari-deploy-agent-tfstate"
    key          = "knowledge-bot/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "istari-knowledge-bot" # cost-allocation tag the AWS Budget filters on
      Service     = local.service_name
      Owner       = "customer-success"
      Environment = "internal"
      ManagedBy   = "terraform"
    }
  }
}

locals {
  service_name = "knowledge-bot" # Slack display name is "Morgana"
  secret_name  = "istari-knowledge-bot"
}
