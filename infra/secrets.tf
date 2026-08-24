resource "aws_secretsmanager_secret" "sales_bot_morgana" {
  name                    = local.secret_name
  description             = "Env vars for ${local.service_name} (Morgana): Slack/Anthropic/Atlassian/GitHub/HubSpot tokens + GitHub PAT for first-boot clone."
  recovery_window_in_days = 7
  # Uses the account-default aws/secretsmanager key. Swap in a CMK ARN here if
  # your fleet standard requires one.
}

# Seeds the secret with placeholders so `terraform apply` succeeds before the
# real tokens are loaded. Set real values out of band (never commit them):
#   aws secretsmanager put-secret-value --secret-id istari-sales-bot-morgana \
#     --secret-string file://sales-bot-morgana.secrets.json
#
# Non-secret values (channel id, org, portal id, Jira URL) are pre-filled with the
# known-good values; the REPLACE_ME entries are the actual secrets.
resource "aws_secretsmanager_secret_version" "sales_bot_morgana_placeholder" {
  secret_id = aws_secretsmanager_secret.sales_bot_morgana.id

  secret_string = jsonencode({
    # Slack
    SLACK_BOT_TOKEN      = "REPLACE_ME" # xoxb-
    SLACK_APP_TOKEN      = "REPLACE_ME" # xapp- (Socket Mode, connections:write)
    SLACK_SIGNING_SECRET = "REPLACE_ME"
    SLACK_USER_TOKEN     = "REPLACE_ME" # xoxp- (enables cross-channel search; optional)
    BOT_CHANNEL_ID       = "C0BH2CE7LBB"
    # Claude
    CLAUDE_API_KEY = "REPLACE_ME" # sk-ant-
    # Atlassian (Jira + Confluence)
    JIRA_URL       = "https://istari.atlassian.net"
    JIRA_EMAIL     = "REPLACE_ME"
    JIRA_API_TOKEN = "REPLACE_ME"
    # GitHub — runtime source auth (read-only)
    GITHUB_TOKEN = "REPLACE_ME" # repo + read:org
    GITHUB_ORG   = "istari-digital-internal"
    # HubSpot (read-only Private App token, pat-na1-)
    HUBSPOT_TOKEN     = "REPLACE_ME"
    HUBSPOT_PORTAL_ID = "22570379"
    # Boot-time only: PAT used by user-data to clone the private repo. May be the
    # same value as GITHUB_TOKEN. bootstrap-env.sh strips this from the runtime env.
    GITHUB_PAT = "REPLACE_ME"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
