variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "vpc_id" {
  description = "VPC where the bot runs (same account/VPC as signal-bot). No default — supply in terraform.tfvars."
  type        = string
}

variable "subnet_cidr" {
  description = "CIDR for sales-bot-morgana's own private subnet. Must be a free range inside the VPC CIDR and must NOT collide with signal-bot's subnet (that one uses 10.10.200.0/24). Verify with `aws ec2 describe-subnets`."
  type        = string
  default     = "10.10.201.0/24"
}

variable "nat_gateway_id" {
  description = "Existing NAT Gateway in the VPC, reused for egress (read-only reference; this module does not manage it). `aws ec2 describe-nat-gateways`."
  type        = string
}

variable "availability_zone" {
  description = "AZ for the subnet. Set to the NAT Gateway's AZ — a NAT is AZ-scoped and cross-AZ routing incurs data charges."
  type        = string
  default     = "us-east-1a"
}

variable "instance_type" {
  description = "EC2 instance type. t4g.micro arm64 is plenty for a Socket Mode bot."
  type        = string
  default     = "t4g.micro"
}

variable "root_volume_gb" {
  type    = number
  default = 50
}

variable "repo_path" {
  description = "GitHub owner/repo holding this bot's code. Cloned over HTTPS at first boot using GITHUB_PAT from Secrets Manager. The GITHUB_PAT must have read access to it."
  type        = string
  default     = "MNgando/Sales_Bot-Morgana"
}

variable "monthly_budget_usd" {
  description = "Monthly USD cap on Project=istari-sales-bot-morgana tagged resources. t4g.micro is ~$3/mo; $25 gives generous buffer."
  type        = number
  default     = 25
}
