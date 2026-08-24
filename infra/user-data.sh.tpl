#!/bin/bash
# First-boot bootstrap for sales-bot-morgana (Morgana) on Amazon Linux 2023 (arm64).
# Re-runnable: package installs are idempotent, repo is pulled if already cloned.
set -euxo pipefail
exec > /var/log/istari-sales-bot-morgana-install.log 2>&1
echo "=== Installing Sales Bot Morgana (Morgana) ==="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

REPO_PATH="${repo_path}"
SECRET_NAME="${secret_name}"
export AWS_REGION="${aws_region}"
SERVICE_NAME="sales-bot-morgana"
INSTALL_DIR="/opt/istari/agent/$SERVICE_NAME"

# nodejs20 is the AL2023 dnf package; @slack/bolt 3 needs node >=18, so 20 is safe.
dnf -y install git jq nodejs20

# Fetch the GitHub PAT to clone the private repo over HTTPS. x-access-token is the
# GitHub convention for PATs in HTTPS URLs. `set +x` around this block so the PAT
# never lands in the install log.
set +x
GITHUB_PAT=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_NAME" \
  --region "$AWS_REGION" \
  --query SecretString --output text \
  | jq -r '.GITHUB_PAT')

mkdir -p /opt/istari/agent
if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone --depth=1 "https://x-access-token:$${GITHUB_PAT}@github.com/$REPO_PATH.git" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" pull --ff-only
fi
unset GITHUB_PAT
set -x
chown -R ec2-user:ec2-user /opt/istari/agent

# Install runtime deps as ec2-user (production deps only; needs package-lock.json).
cd "$INSTALL_DIR" && sudo -u ec2-user npm ci --omit=dev

# Pull the rest of the secrets into /etc/istari/sales-bot-morgana.env.
# bootstrap-env.sh strips GITHUB_PAT (boot-time only, not a runtime concern).
"$INSTALL_DIR/scripts/bootstrap-env.sh" "$SECRET_NAME"

# Install + start systemd unit.
install -m 0644 "$INSTALL_DIR/systemd/$SERVICE_NAME.service" /etc/systemd/system/
touch /var/log/$SERVICE_NAME.log
chown ec2-user:ec2-user /var/log/$SERVICE_NAME.log
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.service"

# ── CloudWatch agent: ship /var/log logs to CloudWatch ──────────────────────
dnf -y install amazon-cloudwatch-agent
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<CWEOF
{
  "agent": { "run_as_user": "root" },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/$SERVICE_NAME.log",
            "log_group_name": "${log_group}",
            "log_stream_name": "{instance_id}/$SERVICE_NAME.log"
          },
          {
            "file_path": "/var/log/istari-$SERVICE_NAME-install.log",
            "log_group_name": "${log_group}",
            "log_stream_name": "{instance_id}/install.log"
          }
        ]
      }
    }
  }
}
CWEOF
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

echo "=== Sales Bot Morgana installation complete ==="
