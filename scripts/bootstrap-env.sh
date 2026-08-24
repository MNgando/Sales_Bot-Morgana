#!/usr/bin/env bash
# Pull the knowledge-bot secret from AWS Secrets Manager and write it as a systemd
# EnvironmentFile at /etc/istari/knowledge-bot.env. Re-runnable.
#
# Usage: sudo ./bootstrap-env.sh [secret-name]
#   AWS_REGION defaults to us-east-1.
set -euo pipefail

SECRET_NAME="${1:-istari-knowledge-bot}"
REGION="${AWS_REGION:-us-east-1}"
OUT="/etc/istari/knowledge-bot.env"

mkdir -p "$(dirname "$OUT")"
umask 077

# GITHUB_PAT is boot-time only (used by user-data to clone the repo); strip it
# from the runtime env the service reads.
aws secretsmanager get-secret-value \
  --secret-id "$SECRET_NAME" \
  --region "$REGION" \
  --query SecretString \
  --output text \
  | jq -r 'del(.GITHUB_PAT) | to_entries | .[] | "\(.key)=\(.value)"' \
  > "$OUT"

chmod 600 "$OUT"
chown root:root "$OUT"
echo "wrote $(wc -l <"$OUT" | tr -d ' ') env vars to $OUT"
