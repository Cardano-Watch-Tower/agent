/**
 * FOLLOW-UP ACCOUNTABILITY — tracks promises the bot makes and delivers on them.
 *
 * When the bot says "I'll look into it" or "let me check that," it queues
 * a follow-up job. A background loop picks these up, does the actual
 * investigation, and replies back to the original user with real results.
 *
 * No empty promises. If we said we'd look into it, we look into it.
 */
const fs = require('fs');
const path = require('path');

const FOLLOWUPS_FILE = path.join(__dirname, '..', 'followups.json');

// Patterns that indicate the bot promised to do something
const PROMISE_PATTERNS = [
  /i'?ll\s+(look|dig|check|trace|investigate|pull|grab|find|get)/i,
  /let\s+me\s+(look|dig|check|trace|investigate|pull|grab|find|get)/i,
  /looking\s+into\s+(it|this|that)/i,
  /on\s+it/i,
  /give\s+me\s+a\s+(sec|moment|minute)/i,
  /stand\s+by/i,
  /checking\s+(now|this|that|on)/i,
  /will\s+(report|update|get)\s+back/i,
  /brb\s+with/i
];

/**
 * Check if a bot reply contains a promise to follow up.
 * Returns the matched promise text or null.
 */
function detectPromise(replyText) {
  for (const pattern of PROMISE_PATTERNS) {
    const match = replyText.match(pattern);
    if (match) return match[0];
  }
  return null;
}

/**
 * Load follow-ups from disk.
 */
function loadFollowUps() {
  try {
    if (fs.existsSync(FOLLOWUPS_FILE)) {
      return JSON.parse(fs.readFileSync(FOLLOWUPS_FILE, 'utf8'));
    }
  } catch (e) { /* corrupt file — start fresh */ }
  return [];
}

/**
 * Save follow-ups to disk.
 */
function saveFollowUps(followups) {
  try {
    fs.writeFileSync(FOLLOWUPS_FILE, JSON.stringify(followups, null, 2));
  } catch (e) {
    console.error('Failed to save followups:', e.message);
  }
}

/**
 * Queue a follow-up.
 *
 * @param {object} opts
 * @param {string} opts.tweetId        — tweet to reply to when delivering
 * @param {string} opts.username       — who we promised
 * @param {string} opts.originalText   — what the user originally said
 * @param {string} opts.promiseText    — what we promised (matched pattern)
 * @param {string} opts.queryType      — 'address' | 'tx' | 'stake' | null
 * @param {string} opts.queryValue     — the hash/address/key to investigate
 */
function addFollowUp({ tweetId, username, originalText, promiseText, queryType, queryValue }) {
  const followups = loadFollowUps();

  // Don't duplicate — if we already have a pending follow-up for this tweet, skip
  if (followups.some(f => f.tweetId === tweetId && f.status === 'pending')) {
    return null;
  }

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    tweetId,
    username,
    originalText: originalText.substring(0, 280),
    promiseText,
    queryType,
    queryValue,
    status: 'pending',      // pending → processing → delivered | failed
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    attempts: 0,
    maxAttempts: 3,
    error: null
  };

  followups.push(entry);
  saveFollowUps(followups);
  console.log(`📌 Follow-up queued: "${promiseText}" for @${username} (${queryType || 'general'})`);
  return entry;
}

/**
 * Get all pending follow-ups that are ready to process.
 * Returns oldest first. Skips entries that have been retried too many times.
 */
function getPendingFollowUps() {
  const followups = loadFollowUps();
  return followups.filter(f =>
    f.status === 'pending' &&
    f.attempts < f.maxAttempts
  );
}

/**
 * Mark a follow-up as processing (prevents double-processing).
 */
function markProcessing(id) {
  const followups = loadFollowUps();
  const entry = followups.find(f => f.id === id);
  if (entry) {
    entry.status = 'processing';
    entry.attempts++;
    saveFollowUps(followups);
  }
}

/**
 * Mark a follow-up as delivered.
 */
function markDelivered(id) {
  const followups = loadFollowUps();
  const entry = followups.find(f => f.id === id);
  if (entry) {
    entry.status = 'delivered';
    entry.deliveredAt = new Date().toISOString();
    saveFollowUps(followups);
    console.log(`✅ Follow-up delivered: ${id} for @${entry.username}`);
  }
}

/**
 * Mark a follow-up as failed. If under maxAttempts, reset to pending for retry.
 */
function markFailed(id, error) {
  const followups = loadFollowUps();
  const entry = followups.find(f => f.id === id);
  if (entry) {
    if (entry.attempts >= entry.maxAttempts) {
      entry.status = 'failed';
      entry.error = error;
      console.log(`❌ Follow-up permanently failed: ${id} — ${error}`);
    } else {
      entry.status = 'pending'; // retry
      entry.error = error;
      console.log(`⚠️  Follow-up failed (attempt ${entry.attempts}/${entry.maxAttempts}): ${id} — ${error}`);
    }
    saveFollowUps(followups);
  }
}

/**
 * Clean up old follow-ups (delivered/failed older than 7 days).
 */
function cleanup() {
  const followups = loadFollowUps();
  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const cleaned = followups.filter(f => {
    if (f.status === 'delivered' || f.status === 'failed') {
      return new Date(f.createdAt).getTime() > cutoff;
    }
    return true; // keep all pending/processing
  });
  if (cleaned.length < followups.length) {
    saveFollowUps(cleaned);
    console.log(`🧹 Cleaned ${followups.length - cleaned.length} old follow-ups`);
  }
}

module.exports = {
  detectPromise,
  addFollowUp,
  getPendingFollowUps,
  markProcessing,
  markDelivered,
  markFailed,
  cleanup
};
