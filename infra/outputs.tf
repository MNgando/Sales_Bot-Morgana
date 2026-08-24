output "instance_id" {
  value = aws_instance.knowledge_bot.id
}

output "instance_private_ip" {
  value = aws_instance.knowledge_bot.private_ip
}

output "secret_arn" {
  value = aws_secretsmanager_secret.knowledge_bot.arn
}

output "log_group" {
  value = aws_cloudwatch_log_group.knowledge_bot.name
}

output "log_file" {
  value = "/var/log/knowledge-bot.log"
}

output "ssm_session_command" {
  description = "Shell into the box via SSM (no SSH needed)"
  value       = "aws ssm start-session --target ${aws_instance.knowledge_bot.id} --region ${var.aws_region}"
}

output "tail_logs_command" {
  description = "Follow the bot's logs from CloudWatch"
  value       = "aws logs tail ${aws_cloudwatch_log_group.knowledge_bot.name} --follow --region ${var.aws_region}"
}
