/**
 * Shared env helper for sources.
 *
 * `real(name)` returns a configured value only when it's genuinely set. An unset,
 * empty, or leftover `.env.template` placeholder value (one containing "your-" or
 * "-here", e.g. `your-atlassian-api-token-here`) counts as absent.
 *
 * Why: each source's `isEnabled()` gates whether its tool is advertised to Claude.
 * A raw `process.env.X` presence check treats a placeholder as configured, so the
 * bot would offer e.g. `jira_search`, then 401 at call time. Routing isEnabled()
 * through `real()` keeps the registry honest — only truly-configured sources are
 * offered.
 */

function real(name) {
  const v = process.env[name];
  if (!v) return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (/your-|-here/i.test(trimmed)) return undefined; // .env.template placeholder
  return trimmed;
}

module.exports = { real };
