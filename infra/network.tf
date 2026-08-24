# Dedicated private subnet for knowledge-bot inside the existing VPC (same VPC
# signal-bot runs in).
#
# Why a separate subnet instead of reusing another bot's:
#   - This module manages ONLY its own subnet + route table, so a bad
#     apply/destroy here can never touch signal-bot or anything else.
#   - We still share the VPC's already-paid-for NAT Gateway for egress, so
#     there's no new ~$32/mo NAT cost.
#   - Socket Mode is outbound-only: no inbound path, no public IP.
#
# The only reference to shared infrastructure is the NAT Gateway ID in the
# default route below — read-only (we point at it, we don't own it).

resource "aws_subnet" "knowledge_bot" {
  vpc_id                  = var.vpc_id
  cidr_block              = var.subnet_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false

  tags = {
    Name = "${local.service_name}-subnet"
  }
}

resource "aws_route_table" "knowledge_bot" {
  vpc_id = var.vpc_id

  tags = {
    Name = "${local.service_name}-rt"
  }
}

# Default route to the internet via the existing NAT Gateway.
resource "aws_route" "knowledge_bot_nat" {
  route_table_id         = aws_route_table.knowledge_bot.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = var.nat_gateway_id
}

resource "aws_route_table_association" "knowledge_bot" {
  subnet_id      = aws_subnet.knowledge_bot.id
  route_table_id = aws_route_table.knowledge_bot.id
}
