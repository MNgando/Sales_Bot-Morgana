# CloudWatch log group for knowledge-bot. The CloudWatch agent on the instance
# ships /var/log/knowledge-bot.log (+ the install log) here, so logs are readable
# remotely (`aws logs tail /knowledge-bot --follow`). 90-day retention.
resource "aws_cloudwatch_log_group" "knowledge_bot" {
  name              = "/${local.service_name}"
  retention_in_days = 90

  tags = {
    Name = "${local.service_name}-logs"
  }
}
