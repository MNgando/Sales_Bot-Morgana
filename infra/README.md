# infra/ — production deploy (Terraform → EC2 + systemd)

Runs Morgana (the Sales Bot) as a long-lived service on a single EC2 instance,
ported from the internal **signal-bot** infra. Socket Mode is outbound-only, so the
box has **no public IP and no inbound rules** — just egress via a shared NAT gateway.

What Terraform creates (all tagged `Project=istari-sales-bot-morgana`):

- **EC2** — Amazon Linux 2023 **arm64** (`t4g.micro`), gp3 encrypted root, IMDSv2-only,
  in a **dedicated private subnet** with a default route to the VPC's existing NAT.
- **Egress-only security group** (no inbound).
- **Secrets Manager** secret `istari-sales-bot-morgana` (all the bot's env vars) + an
  instance IAM role scoped to `GetSecretValue` on *just that secret* and CloudWatch
  Logs put. **SSM Session Manager** for shell access (no SSH/bastion).
- **CloudWatch** log group `/sales-bot-morgana` (90-day retention) + a monthly **Budget**.
- **First-boot user-data** — installs Node 20, clones the repo, `npm ci --omit=dev`,
  writes `/etc/istari/sales-bot-morgana.env` from Secrets Manager, enables the **systemd**
  unit (`Restart=on-failure`).

Est. cost: ~**$3/mo** (t4g.micro) — NAT is already paid for by the shared VPC.

---

## Prerequisites (do these first)

1. **Push this code to the repo the instance will clone.** It's currently only a
   local folder. Create a private repo (default `istari-digital-internal/sales-bot-morgana`)
   and push — including `package-lock.json` (user-data runs `npm ci`). `.env` is
   git-ignored and must NOT be committed; runtime config comes from Secrets Manager.
2. **Tools + AWS creds** on the machine doing the deploy:
   - `terraform` >= 1.10, `aws` CLI v2
   - AWS credentials for the target account (`aws sts get-caller-identity` works),
     with permissions for EC2/VPC-subnet, IAM role, Secrets Manager, CloudWatch Logs,
     Budgets, and read/write to the S3 state bucket in `main.tf`.
   > Note: this must be run from an environment that has those — it can't be done
   > from the Claude Code session (no terraform/aws/creds there).
3. **Discover the environment values** for `terraform.tfvars`:
   ```bash
   aws ec2 describe-vpcs        --query 'Vpcs[].{id:VpcId,cidr:CidrBlock}'
   aws ec2 describe-nat-gateways --query 'NatGateways[].{id:NatGatewayId,subnet:SubnetId,state:State}'
   aws ec2 describe-subnets      --query 'Subnets[].{id:SubnetId,cidr:CidrBlock,az:AvailabilityZone}'
   ```
   Pick the VPC + a NAT gateway, note its AZ, and choose a free `/24` that does **not**
   overlap signal-bot's `10.10.200.0/24`.

---

## Deploy

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars   # then fill in vpc_id, nat_gateway_id, az, subnet_cidr

terraform init      # local state (terraform.tfstate in this dir) — see main.tf
terraform plan      # review — should create ~11 resources, destroy 0
terraform apply
```

The secret is seeded with `REPLACE_ME` placeholders so `apply` succeeds. Load the real
values (out of band — never commit them):

```bash
cp sales-bot-morgana.secrets.json.example sales-bot-morgana.secrets.json   # fill in real tokens
aws secretsmanager put-secret-value \
  --secret-id istari-sales-bot-morgana \
  --secret-string file://sales-bot-morgana.secrets.json
rm sales-bot-morgana.secrets.json     # don't leave secrets on disk / never commit
```

Then reboot the instance (or re-run bootstrap over SSM) so it picks up the real env:

```bash
aws ssm start-session --target "$(terraform output -raw instance_id)"
#   on the box:  sudo /opt/istari/agent/sales-bot-morgana/scripts/bootstrap-env.sh istari-sales-bot-morgana \
#                && sudo systemctl restart sales-bot-morgana
```

## Verify

```bash
aws logs tail /sales-bot-morgana --follow          # expect "Morgana is running (Socket Mode)"
```
Then `@Morgana` a question in `C0BH2CE7LBB`. Note: only **one** instance may run at a
time (Socket Mode splits events across duplicates) — stop the local `npm start` before
the EC2 box goes live.

## Update the bot later

Push to the repo, then on the box (via SSM):
```bash
cd /opt/istari/agent/sales-bot-morgana && sudo -u ec2-user git pull --ff-only \
  && sudo -u ec2-user npm ci --omit=dev && sudo systemctl restart sales-bot-morgana
```

## Teardown

```bash
terraform destroy    # removes the EC2/subnet/SG/role/log group/budget
# the Secrets Manager secret has a 7-day recovery window before it's fully deleted
```

## What differs from signal-bot

- **Read-only** — no Jira-write IAM/secrets. The secret holds Slack tokens,
  `CLAUDE_API_KEY`, and read-only source creds (Atlassian/GitHub/HubSpot).
- `GITHUB_TOKEN` is a **runtime** secret here (the GitHub *source* uses it), in
  addition to the boot-time `GITHUB_PAT` clone token — they may be the same value.
- Everything renamed `signal-bot` → `sales-bot-morgana`; subnet default moved to
  `10.10.201.0/24` to avoid colliding with signal-bot.
