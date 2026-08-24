resource "aws_security_group" "knowledge_bot" {
  name        = "${local.service_name}-sg"
  description = "Egress-only SG for ${local.service_name}; Slack Socket Mode is outbound."
  vpc_id      = var.vpc_id

  egress {
    description = "Egress to anywhere (Slack, Anthropic, Atlassian, GitHub, HubSpot are public APIs)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.service_name}-sg"
  }
}

resource "aws_instance" "knowledge_bot" {
  ami                    = data.aws_ami.al2023_arm64.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.knowledge_bot.id
  vpc_security_group_ids = [aws_security_group.knowledge_bot.id]
  iam_instance_profile   = aws_iam_instance_profile.knowledge_bot.name

  # Egress must exist before first boot: user-data clones the repo and reads
  # Secrets Manager over the NAT.
  depends_on = [aws_route_table_association.knowledge_bot]

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1
  }

  user_data = templatefile("${path.module}/user-data.sh.tpl", {
    secret_name = local.secret_name
    aws_region  = var.aws_region
    repo_path   = var.repo_path
    log_group   = aws_cloudwatch_log_group.knowledge_bot.name
  })

  tags = {
    Name = local.service_name
  }

  lifecycle {
    ignore_changes = [ami] # don't replace the box just because a newer AL2023 AMI shipped
  }
}
