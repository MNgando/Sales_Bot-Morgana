# Design: Google Drive Source (read-only, scoped)

**Status:** Planned (not built) · **Author:** Michel + Claude · **Date:** 2026-08-28

## Goal
Give Morgana a read-only **Google Drive** source so she can **search** and **read**
Drive files (Google Docs, Sheets, Slides, plain text/markdown) — but only files that
have been **explicitly shared** with her, using the least-privilege model.

This is a new data source, same shape as `sources/{jira,confluence,github,slack,hubspot}.js`
— it plugs into the existing tool-use loop and the read-only invariant.

## Access model (locked): scoped service account
- Create a Google Cloud **service account** with its own identity + JSON key.
- **Share specific Drive folders/files with the service account's email** (Viewer),
  exactly like sharing with a person. Morgana can see **only** what's shared with it.
- **No Workspace admin, no domain-wide delegation** — least-privilege by construction.
- Scope: `https://www.googleapis.com/auth/drive.readonly`.

To widen or narrow what Morgana sees, you just share/unshare folders in Drive — no code
or redeploy.

## Auth mechanics
- The service-account **JSON key** (`client_email` + `private_key`) is used to mint a
  signed JWT → short-lived OAuth2 access token (Google's JWT-bearer grant).
- Use **`google-auth-library`** (official, lightweight) to handle the JWT signing +
  token refresh; call the **Drive v3 REST API** with `node-fetch` — consistent with the
  codebase's existing "auth helper + fetch" style. (Alternative: the full `googleapis`
  client; heavier, not needed.)
- Token is cached in-process and refreshed on expiry.

## Credentials delivery
The SA key is a secret → stored in AWS Secrets Manager (and `.env` locally), **base64**
so it's a single-line value:
| Key | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | base64 of the service-account JSON key |
| `GDRIVE_ROOT_FOLDER_ID` *(optional)* | restrict searches to one folder subtree |

`isEnabled()` returns true only when `GOOGLE_SERVICE_ACCOUNT_KEY` is present (via the
`real()` helper) — so the source is simply not offered to Claude until configured.

## Tools
Two read-only tools (`sources/google-drive.js`), advertised only when enabled:

**1. `gdrive_search`** — find shared Drive files.
- Drive `files.list` with a `q` filter (`name contains` / `fullText contains`,
  `trashed = false`, optional `mimeType`, optional parent folder).
- `supportsAllDrives=true` + `includeItemsFromAllDrives=true` so Shared Drives work too.
- Returns: `id, name, mimeType, modifiedTime, webViewLink, owners`.
- Input: `query` (text), optional `mime_type`, `limit`.

**2. `gdrive_read_file`** — read a file's text.
- Accepts a **file id** (from search) or a **Drive URL** (parse the id out).
- **Google Docs** → `files.export?mimeType=text/plain`; **Sheets** → export `text/csv`;
  **Slides** → export `text/plain`; **plain text / markdown** → `files.get?alt=media`.
- Caps content (~8,000 chars, like `github_get_readme`) to protect model context.

> **PDF/binary caveat:** Drive can't export PDFs/images to text. v1 supports
> Docs/Sheets/Slides + text/markdown. PDF text extraction (a parser) is a future add;
> until then a PDF result links to Drive ("open to view") rather than reading contents.

## Read-only invariant
All Drive calls are **GET** (`files.list`, `files.get`, `files.export`) — so this source
stays pure-GET and needs **no** change to the read-only invariant (unlike HubSpot's
search POST). The existing `test-sources.js` invariant will cover it automatically.

## Registration
- Add `google-drive` to `ALL_SOURCES` in `sources/index.js`.
- Add label mappings in `format.js`: `gdrive_search` / `gdrive_read_file` → `Google Drive`.
- Add `google-auth-library` to `package.json` deps (installed on next EC2 `npm ci`).

## Setup steps (one-time, for the operator)
1. Google Cloud Console → create/select a project → **enable the Drive API**.
2. Create a **service account** → **create a JSON key** → download it.
3. Copy the service account **email** (e.g. `morgana-drive@<project>.iam.gserviceaccount.com`).
4. In Google Drive, **share** the target folders/files with that email (Viewer).
5. `base64` the JSON key → set `GOOGLE_SERVICE_ACCOUNT_KEY` in `.env` (local) and in the
   secret (`put-secret-value`) for prod.
6. Deploy.

## Testing
- **Unit** (`test-google-drive.js`, mocked `node-fetch`): search builds the right `q`
  and parses results; read exports Docs as text and downloads plain text; a Drive URL is
  parsed to a file id; content is capped. Token minting is stubbed.
- **Read-only invariant** — new source is picked up by `test-sources.js` (all GET).
- **Live** via `ask.js`: "search my Drive for the Q3 plan", "summarize the shared
  Drive doc <url>".

## Guardrails
- **Least-privilege** — Morgana sees only explicitly shared files; no domain-wide access.
- **Secret hygiene** — SA key only in Secrets Manager / `.env` (git-ignored), never
  committed; base64 single-line.
- **Content cap** — bounded read size.
- **Graceful failure** — a Drive API error returns a structured `{ok:false,error}` the
  model can read (matches the other sources), never throws into the loop.

## Rollout
1. Build the source behind `isEnabled()` (off until the key is set).
2. Add `google-auth-library`, source module, tests; run the suite.
3. Add `GOOGLE_SERVICE_ACCOUNT_KEY` to the secret; re-run bootstrap.
4. Deploy via the dev→deploy loop (push → SSM `git pull` + `npm ci` + restart).
5. Validate with `ask.js` against a shared test folder, then in Slack.

## Future / upgrades
- **PDF/image OCR** text extraction.
- **Search scoping** presets (per-folder tools, per-team folders).
- **Drive-link resolution from Slack** — when a Slack message links a Drive file Morgana
  can see, fetch and read that specific file (ties into `slack_search`).

## Open questions
- v1 file types: Docs/Sheets/Slides + text now, PDF later — OK?
- Scope searches to a single `GDRIVE_ROOT_FOLDER_ID`, or all shared content?
