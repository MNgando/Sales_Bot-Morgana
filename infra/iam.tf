data "aws_iam_policy_document" "sales_bot_morgana_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sales_bot_morgana" {
  name               = "${local.service_name}-role"
  assume_role_policy = data.aws_iam_policy_document.sales_bot_morgana_assume.json
}

data "aws_iam_policy_document" "sales_bot_morgana_inline" {
  statement {
    sid       = "ReadSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.sales_bot_morgana.arn]
  }

  # CloudWatch agent ships /var/log logs to our log group only. CreateLogGroup is
  # included so the agent self-heals if the group isn't present on first boot.
  statement {
    sid = "ShipLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = [
      aws_cloudwatch_log_group.sales_bot_morgana.arn,
      "${aws_cloudwatch_log_group.sales_bot_morgana.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "sales_bot_morgana" {
  name   = "${local.service_name}-inline"
  role   = aws_iam_role.sales_bot_morgana.id
  policy = data.aws_iam_policy_document.sales_bot_morgana_inline.json
}

# SSM Session Manager so we can shell into the instance without SSH/bastion.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.sales_bot_morgana.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "sales_bot_morgana" {
  name = "${local.service_name}-profile"
  role = aws_iam_role.sales_bot_morgana.name
}
