output "instance_id" {
  value = aws_instance.sales_bot_morgana.id
}

output "instance_private_ip" {
  value = aws_instance.sales_bot_morgana.private_ip
}

output "secret_arn" {
  value = aws_secretsmanager_secret.sales_bot_morgana.arn
}

output "log_group" {
  value = aws_cloudwatch_log_group.sales_bot_morgana.name
}

output "log_file" {
  value = "/var/log/sales-bot-morgana.log"
}

output "ssm_session_command" {
  description = "Shell into the box via SSM (no SSH needed)"
  value       = "aws ssm start-session --target ${aws_instance.sales_bot_morgana.id} --region ${var.aws_region}"
}

output "tail_logs_command" {
  description = "Follow the bot's logs from CloudWatch"
  value       = "aws logs tail ${aws_cloudwatch_log_group.sales_bot_morgana.name} --follow --region ${var.aws_region}"
}
