# Istari Knowledge Bot

A **read-only** Slack Q&A bot. Mention it in its channel and it answers by pulling
live data from Istari's knowledge sources — **Jira, Confluence, GitHub, Slack, and
(optionally) the Istari platform** — via a Claude **tool-use loop**. It never
creates, edits, or deletes anything.

Modeled on the internal **signal-bot**'s engineering (Bolt Socket Mode, single-channel
@-mention gate, "Thinking…" ack + in-place update, dedup replay guard, resilient
startup), with all ticket-writing stripped out.

**POC channel:** `C0BH2CE7LBB`

---

## How it works

```
Slack (@mention in #channel)
   │  Socket Mode (outbound WebSocket — no public URL)
   ▼
bot.js  ──▶  claude.js  ── tool-use loop ─▶  Anthropic Messages API
                 │                               │  picks a read-only tool
                 │   ◀── tool_result ───────────┘
                 ▼
            sources/*  ── read-only REST ─▶  Jira · Confluence · GitHub · Slack · Istari
                 │
                 ▼
   in-thread reply (Block Kit answer + "Sources" line)
```

Claude decides which source tool(s) to call; `sources/index.js` executes the
read-only REST query and feeds the result back; Claude composes the answer. Only
sources whose credentials are present are offered to Claude — the rest are skipped.

## Layout

```
bot.js            entry — Bolt Socket Mode app, @-mention gate, ack + in-place update
claude.js         Claude caller (retry/backoff) + the tool-use loop
channel-guard.js  hard allow-list: only BOT_CHANNEL_ID
dedup.js          Socket Mode replay guard (ported from signal-bot)
format.js         Block Kit answer rendering + Sources line
sources/          one read-only module per source (jira, confluence, github, slack, istari) + index registry
infra/            deferred EC2/systemd deploy (see infra/README.md) — runs locally for now
test-*.js         node:assert/strict suites (offline)
slack-manifest.yaml  Slack app manifest (Socket Mode, read-only scopes)
.env.template     every config value, documented
```

---

## Setup

### 1. Install
```bash
npm install
```

### 2. Create the Slack app
1. Go to **api.slack.com/apps → Create New App → From an app manifest**, pick the
   Istari workspace, and paste `slack-manifest.yaml`.
2. **Socket Mode** is already enabled by the manifest. Under **Basic Information →
   App-Level Tokens**, generate a token with the **`connections:write`** scope →
   this is your `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install to Workspace**. From **OAuth & Permissions**, copy the **Bot User OAuth
   Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`. From **Basic Information**, copy the
   **Signing Secret** → `SLACK_SIGNING_SECRET`.
4. *(Optional, for cross-channel Slack search)* the manifest requests the
   **`search:read`** user scope; after install, copy the **User OAuth Token**
   (`xoxp-…`) → `SLACK_USER_TOKEN`. Without it, the Slack source only reads recent
   history of the bot channel.
5. **Invite the bot** to the channel: `/invite @knowledge-bot` in `C0BH2CE7LBB`.

### 3. Configure
```bash
cp .env.template .env
# then fill in the values
```
Minimum to be useful: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`,
`CLAUDE_API_KEY`, and at least one source (e.g. `JIRA_*` and/or `GITHUB_TOKEN`).
Never commit `.env` (it's git-ignored).

### 4. Run
```bash
npm test      # offline test suites (mocked — no credentials needed)
npm start     # ⚡ starts the bot (Socket Mode)
```
On start you'll see the channel and which sources are enabled.

### Test one question without Slack (Tier 2)
`ask.js` runs the same brain as the live bot (`answerQuestion` → real Claude
tool-use loop → real read-only sources), so you can validate Claude + your source
credentials before creating the Slack app. Needs `CLAUDE_API_KEY` plus the creds
for whichever sources you want reachable. Read-only.
```bash
node ask.js "What are the open SIGNAL tickets for Hermeus?"
# or: npm run ask -- "your question"
```
It prints the model, which sources were enabled, the answer, and which tools it used.

---

## Sources

| Source | Env | Notes |
|---|---|---|
| **Jira** | `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Read-only issue search (JQL). |
| **Confluence** | same Atlassian creds (`CONFLUENCE_URL` optional) | Read-only page search (CQL). |
| **GitHub** | `GITHUB_TOKEN`, `GITHUB_ORG` | Code/repo search + README read, scoped to the org. Use the token that already works over HTTPS. |
| **Slack** | `SLACK_BOT_TOKEN` (+ optional `SLACK_USER_TOKEN`) | With a user token → workspace search; else recent bot-channel history. |
| **HubSpot** | `HUBSPOT_TOKEN` (+ optional `HUBSPOT_PORTAL_ID`) | Read-only CRM search: deals, companies, contacts. Private App token, read scopes only. |
| **Istari** | `ISTARI_API_URL`, `ISTARI_API_TOKEN` | Optional; off until both are set. Read-only GET wrapper. |

## Guardrails

- **Read-only by construction** — there is no create/update/delete tool. Sources use
  GET, with one sanctioned exception: read-only search endpoints that require POST
  (HubSpot CRM search). A test (`test-sources.js`) enforces this — PUT/PATCH/DELETE
  are never allowed, and POST is permitted only to URLs ending in `/search`. The
  system prompt also refuses write requests.
- **Single channel** — `channel-guard.js` answers only in `BOT_CHANNEL_ID`
  (default `C0BH2CE7LBB`); every other channel/DM is ignored.
- **Dedup** — Socket Mode event replays are answered once.

## Notes

- **Model** defaults to `claude-sonnet-4-6` (matches signal-bot); override with
  `CLAUDE_MODEL` to move to a Claude 5 model.
- **Slack search** genuinely needs a **user** token — bot tokens can't call
  `search.messages`.
- **Jira** uses the enhanced `/rest/api/3/search/jql` endpoint (the older `/search`
  is deprecated); confirm your Cloud instance supports it.
- **Deploy**: local now; see `infra/README.md` for the planned EC2/systemd port.
