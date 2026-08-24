# CloudWatch log group for sales-bot-morgana. The CloudWatch agent on the instance
# ships /var/log/sales-bot-morgana.log (+ the install log) here, so logs are readable
# remotely (`aws logs tail /sales-bot-morgana --follow`). 90-day retention.
resource "aws_cloudwatch_log_group" "sales_bot_morgana" {
  name              = "/${local.service_name}"
  retention_in_days = 90

  tags = {
    Name = "${local.service_name}-logs"
  }
}
