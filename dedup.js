/**
 * Persistent dedup of processed Slack `message.ts` values.
 *
 * Why: Slack Socket Mode can replay events after a reconnect or restart. Without
 * a record of what we've already handled, the bot would answer the same mention
 * twice. (Ported from the internal signal-bot, which used this to avoid
 * double-filing Jira tickets — same replay hazard applies to double-answering.)
 *
 * Shape: in-memory Set backed by an append-only file at data/processed.ndjson.
 * On boot we load entries newer than TTL_SECONDS into the Set and rewrite the
 * file with only those (cheap compaction). markProcessed appends to both.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'processed.ndjson');
const TTL_SECONDS = 24 * 60 * 60;

let processed = new Set();
let writeStream = null;

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(FILE)) {
    const now = Date.now() / 1000;
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    const keep = lines.filter(ts => {
      const tsNum = parseFloat(ts);
      return Number.isFinite(tsNum) && (now - tsNum) < TTL_SECONDS;
    });
    processed = new Set(keep);
    fs.writeFileSync(FILE, keep.length ? keep.join('\n') + '\n' : '');
  }

  writeStream = fs.createWriteStream(FILE, { flags: 'a' });
}

function isProcessed(ts) {
  return processed.has(ts);
}

function markProcessed(ts) {
  if (!ts || processed.has(ts)) return;
  processed.add(ts);
  writeStream?.write(ts + '\n');
}

function size() {
  return processed.size;
}

init();

module.exports = { isProcessed, markProcessed, size };
