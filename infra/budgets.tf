# Monthly cost cap on resources tagged Project=istari-sales-bot-morgana.
# v1 has no notification subscribers — the budget shows in the AWS Budgets
# dashboard only. Add `notification { ... subscriber_email_addresses = [...] }`
# blocks (or an SNS topic) when you know who should be alerted.
resource "aws_budgets_budget" "sales_bot_morgana" {
  name         = "${local.service_name}-monthly"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$istari-sales-bot-morgana"]
  }
}
