# Design: HubSpot Deal-Win Announcer

**Status:** Planned (not built) · **Author:** Michel + Claude · **Date:** 2026-08-28

## Goal
When a HubSpot deal progresses to **Closed/Won**, Morgana proactively posts a
celebratory announcement in the Slack channel `C0BH2CE7LBB`.

This is a shift from Morgana's current model: everything today is **pull/reactive**
(a user asks, she answers). This feature is **push/proactive** — she watches HubSpot
and posts unprompted.

## Decisions (locked)
1. **Detection:** polling (not webhooks).
2. **Interval:** every **1 hour**.
3. **Filter:** **all** wins (no amount/pipeline filter).
4. **Channel:** the same channel, `C0BH2CE7LBB`.
5. **State:** start **file-based**, with a clean upgrade path to **S3/DynamoDB**.

Why polling over webhooks: the EC2 host is private + **egress-only** (no inbound), so
webhooks would require new public ingress (API Gateway + Lambda) and a bigger attack
surface. Polling is all-outbound, reuses the existing HubSpot token, and needs no new
infra. Hourly latency is fine for win announcements. Webhooks remain the future upgrade
if real-time is ever needed.

## Architecture
A background poller runs **inside the existing bot process** on EC2, alongside the
Socket Mode listener — mirroring signal-bot's "nudge sweeper" precedent. No new infra.

```
bot.js startup
  ├─ Socket Mode app (existing: answers questions)
  └─ startWinAnnouncer(slackClient)      ← NEW
        every 1h:  poll HubSpot → detect new wins → post to C0BH2CE7LBB → persist state
```

New module: **`announcer.js`** (poller + detection + dedup + formatting). It reuses
HubSpot auth/search from `sources/hubspot.js` and the Slack client from Bolt to post.

## Detection logic
Each cycle, query HubSpot deals search:
- **Filters (AND):** `hs_is_closed_won = "true"` AND `hs_lastmodifieddate >= <watermark>`.
  - `hs_is_closed_won` is the robust signal — true for **any** won stage across **all**
    pipelines (including the custom ones), so we don't hardcode stage ids.
- **Sort:** `hs_lastmodifieddate` ASC. **Properties:** `dealname, amount, dealstage,
  closedate, hubspot_owner_id, hs_lastmodifieddate`.
- Paginate to cover the whole window (reuse hubspot's paginated search).

For each returned deal, **announce only if its deal id hasn't been announced before**
(dedup set). `hs_lastmodifieddate` also bumps on unrelated edits, so a deal already won
can re-surface in the window — the per-deal-id dedup makes announcements exactly-once.

> Future refinement: `hs_date_entered_closedwon` (per-stage) is a more precise "entered
> won" signal, but it varies per pipeline. `hs_is_closed_won` + dedup is simpler and
> correct across pipelines; we can tighten later.

## State & dedup
Abstract state behind a tiny **`StateStore`** interface (`get()` / `set(state)`), so
swapping backends later is a one-module change:

- **v1 (file):** `data/announced-wins.json` (same idea as `dedup.js`). Shape:
  ```json
  { "watermark": 1730000000000, "announced": { "<dealId>": <announcedAtMs> } }
  ```
- **v2 (durable):** S3 object or DynamoDB item, identical shape — survives instance
  replacement. Only the StateStore implementation changes.

Rules:
- **Cold start (no state):** set `watermark = now`, `announced = {}` — so first run does
  **not** announce a backlog of historical wins.
- **Advance `watermark` only on a successful poll** — a failed poll retries the same
  window next cycle (no missed wins from a transient error).
- **TTL the `announced` set** (e.g. 60 days) so the file stays bounded.

⚠️ **Durability caveat (v1 file):** if the instance is replaced (`terraform apply
-replace` / fresh deploy), the file is lost → cold start resets `watermark = now`,
so wins during the replacement gap are **missed** (not duplicated). Acceptable POC
risk; the S3/DynamoDB upgrade removes it.

## Announcement format
One proactive `chat.postMessage` to `C0BH2CE7LBB` per win (Morgana already has
`chat:write`), rendered via the existing `mdToMrkdwn` + blocks:

```
🎉 *Closed/Won:* <deal link|Deal name> — $900,000
• Owner: <name>   • Closed: 2026-08-28
```

- **Amount** via the deal's `amount` (formatted).
- **Owner/company** are best-effort enrichment (owner id → name via `search_owners`;
  company via associations). v1 can ship with deal name + amount + close date + link and
  add owner/company as a fast follow.

## Configuration (env, delivered via the secret)
| Key | Default | Purpose |
|---|---|---|
| `ANNOUNCE_WINS_ENABLED` | `true` | Master on/off |
| `ANNOUNCE_WINS_INTERVAL_MS` | `3600000` (1h) | Poll cadence |
| `ANNOUNCE_WINS_CHANNEL` | `C0BH2CE7LBB` | Where to post |
| `ANNOUNCE_WINS_DRY_RUN` | `false` | Log intended posts without posting |
| `ANNOUNCE_WINS_STATE` | `file` | `file` \| `s3` \| `dynamodb` (v2) |

## Guardrails
- **Read-only invariant intact.** The announcer *reads* HubSpot (GET/search) and *posts*
  to Slack — posting is the bot's own output (same as its question replies), not a write
  to a data source. The `sources/*` read-only guarantee is unchanged. (Worth a line in
  the README so the invariant's scope stays clear.)
- **Failure isolation** — a poll wrapped in try/catch; errors log and retry next cycle;
  never crash the Socket Mode listener.
- **Volume** — post sequentially with a small delay to respect Slack rate limits; cap at
  N per cycle (e.g. 25) and log if exceeded.
- **Dry-run** — validate detection against real HubSpot without posting.

## Testing
- **Unit** (`test-announcer.js`, mocked HubSpot — no network):
  - detection returns only `hs_is_closed_won` deals newer than the watermark
  - **dedup**: same deal across two cycles → announced once
  - **cold start**: empty state → `watermark = now`, nothing announced
  - watermark advances on success, holds on failure
- **Dry-run** one live cycle (logs what it *would* post).
- **Manual trigger** — a small `run-announcer-once.js` harness (like `ask.js`) to run a
  single cycle on demand instead of waiting an hour.

## Rollout
1. Build behind `ANNOUNCE_WINS_ENABLED`, default `DRY_RUN=true` for the first deploy.
2. Add the new env keys to the secret (`put-secret-value`) + re-run bootstrap.
3. Deploy via the dev→deploy loop (push → SSM `git pull` + `npm ci` + restart).
4. Watch a dry-run cycle in CloudWatch; confirm it identifies real recent wins.
5. Flip `DRY_RUN=false`; confirm a live announcement (or wait for the next real win).

## Future / upgrades
- **State durability:** move StateStore to S3 or DynamoDB (survives instance replacement).
- **Real-time:** HubSpot webhooks via API Gateway + Lambda, if hourly isn't enough.
- **Enrichment:** owner + company names, deal age, pipeline label.
- **More events:** big-deal stage moves, losses, quota milestones — same poller shape.

## Open questions
- Owner/company enrichment in v1, or fast-follow?
- Message style — minimal line, or a richer "win card" with more context?
