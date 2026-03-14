/**
 * CW ANALYST — Error pattern detection + X safety circuit breaker
 *
 * Two jobs:
 * 1. X CIRCUIT BREAKER: 2 X-interaction errors = freeze ALL X-touching loops for 5 min.
 *    No exceptions. No "try one more time." This is law.
 * 2. PATTERN DETECTION: Track all errors, bucket by normalized pattern, email when
 *    the same error repeats N times in M hours.
 */

const messenger = require('./messenger');

// ─── X SAFETY CIRCUIT BREAKER ──────────────────────────────────
// THE LAW: 2 strikes on any X interaction = full agent freeze.

const FREEZE_DURATION = 5 * 60 * 1000; // 5 minutes, no negotiation

// Loops that touch X/Twitter — any error here counts as a strike
const X_LOOPS = new Set(['mention', 'engagement', 'followup', 'poster', 'digest-post']);

let xStrikes = 0;
let frozen = false;
let frozenUntil = null;
let freezeCount = 0; // lifetime freeze count (for reporting)

function recordXError(loop, error) {
  xStrikes++;
  console.error('\u{1F6A8} X STRIKE ' + xStrikes + '/2 [' + loop + ']: ' + error.message);

  if (xStrikes >= 2) {
    freezeAgent(loop, error);
  }
}

function freezeAgent(loop, error) {
  frozen = true;
  frozenUntil = Date.now() + FREEZE_DURATION;
  freezeCount++;
  console.error('\u{1F9CA} AGENT FROZEN \u2014 2 X interaction errors. All X loops paused 5 min.');
  console.error('\u{1F9CA} Trigger: [' + loop + '] ' + error.message);

  // Email Ian immediately
  messenger.escalate(
    'X Safety: Agent frozen after 2 errors in ' + loop,
    'warning',
    'Error: ' + error.message +
    '\nLoop: ' + loop +
    '\nFrozen until: ' + new Date(frozenUntil).toISOString() +
    '\nTotal freezes this session: ' + freezeCount
  );
}

function isFrozen() {
  if (!frozen) return false;

  if (Date.now() >= frozenUntil) {
    // Thaw — reset strikes, resume
    frozen = false;
    frozenUntil = null;
    xStrikes = 0;
    console.log('\u{1F504} Agent thawed. X strikes reset to 0. Resuming loops.');
    return false;
  }

  return true; // still frozen
}

// ─── ERROR PATTERN DETECTION ───────────────────────────────────
// Simple: same error N times in M hours? Email.

const THRESHOLDS = {
  window: 6,       // hours — how far back to look
  minCount: 5,     // how many times same pattern must appear
  cooldown: 2,     // hours — don't re-alert same pattern within this
};

const errorLog = [];       // [{loop, pattern, raw, timestamp}]
const alertHistory = {};   // {pattern: lastAlertedTimestamp}

/**
 * Normalize error message to a pattern bucket.
 * "Block 13137620 fetch failed" → "block {n} fetch failed"
 */
function normalize(msg) {
  if (!msg) return 'unknown';
  return msg
    .replace(/[a-f0-9]{64}/gi, '{hash}')       // tx hashes, block hashes
    .replace(/[a-f0-9]{56}/gi, '{addr}')        // Cardano addresses (bech32 payload)
    .replace(/\b\d{4,}\b/g, '{N}')              // numbers > 999
    .replace(/https?:\/\/\S+/g, '{url}')        // URLs
    .toLowerCase()
    .trim();
}

/**
 * Prune entries older than 24 hours.
 */
function prune() {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  while (errorLog.length > 0 && errorLog[0].timestamp < cutoff) {
    errorLog.shift();
  }
}

/**
 * Record an error from any loop. Routes X-interaction errors to circuit breaker.
 */
function recordError(loop, error) {
  const msg = error && error.message ? error.message : String(error);
  const pattern = normalize(msg);

  // Always log to pattern tracker
  errorLog.push({ loop, pattern, raw: msg, timestamp: Date.now() });

  // X interaction? Circuit breaker.
  if (X_LOOPS.has(loop)) {
    recordXError(loop, error);
  }
}

/**
 * Analyze error patterns. Called every 5 minutes by analystLoop.
 * Checks if any pattern crossed the threshold and sends alert email.
 */
async function analyze() {
  prune();

  if (errorLog.length === 0) return;

  const windowMs = THRESHOLDS.window * 60 * 60 * 1000;
  const cooldownMs = THRESHOLDS.cooldown * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;

  // Count occurrences of each pattern within the window
  const counts = {};
  for (const entry of errorLog) {
    if (entry.timestamp < cutoff) continue;
    if (!counts[entry.pattern]) {
      counts[entry.pattern] = { count: 0, loop: entry.loop, first: entry.timestamp, last: entry.timestamp, sample: entry.raw };
    }
    counts[entry.pattern].count++;
    counts[entry.pattern].last = entry.timestamp;
  }

  // Check thresholds
  for (const [pattern, data] of Object.entries(counts)) {
    if (data.count < THRESHOLDS.minCount) continue;

    // Cooldown — don't re-alert too soon
    if (alertHistory[pattern] && (Date.now() - alertHistory[pattern]) < cooldownMs) continue;

    // Alert!
    alertHistory[pattern] = Date.now();

    const firstTime = new Date(data.first).toISOString().substring(11, 16);
    const lastTime = new Date(data.last).toISOString().substring(11, 16);

    const body =
      'Pattern: "' + pattern + '"\n' +
      'Loop: ' + data.loop + '\n' +
      'Occurrences: ' + data.count + ' in last ' + THRESHOLDS.window + ' hours\n' +
      'First seen: ' + firstTime + ' UTC\n' +
      'Last seen: ' + lastTime + ' UTC\n' +
      'Sample: "' + data.sample + '"\n\n' +
      'This pattern has repeated ' + data.count + ' times. May need investigation.';

    console.log('\u{1F4CA} Pattern alert: "' + pattern + '" x' + data.count);

    try {
      await messenger.sendEmailToOwner(
        'Pattern Alert: ' + pattern.substring(0, 60),
        body
      );
    } catch (e) {
      console.error('Analyst email error: ' + e.message);
      // Still write to outbox via escalate as fallback
      messenger.escalate('Pattern: ' + pattern + ' x' + data.count, 'info', body);
    }
  }
}

/**
 * Get current pattern counts (for hourly report enrichment).
 */
function getPatterns() {
  prune();
  const windowMs = THRESHOLDS.window * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const counts = {};

  for (const entry of errorLog) {
    if (entry.timestamp < cutoff) continue;
    if (!counts[entry.pattern]) counts[entry.pattern] = 0;
    counts[entry.pattern]++;
  }

  return counts;
}

/**
 * Get analyst status summary.
 */
function getStatus() {
  prune();
  const patterns = getPatterns();
  return {
    frozen,
    xStrikes,
    frozenUntil: frozenUntil ? new Date(frozenUntil).toISOString() : null,
    freezeCount,
    totalErrors24h: errorLog.length,
    uniquePatterns: Object.keys(patterns).length,
    topPatterns: Object.entries(patterns)
      .sort(function(a, b) { return b[1] - a[1]; })
      .slice(0, 5)
      .map(function(e) { return { pattern: e[0], count: e[1] }; }),
    lastAlert: Object.keys(alertHistory).length > 0
      ? new Date(Math.max.apply(null, Object.values(alertHistory))).toISOString()
      : null,
  };
}

/**
 * Adjust thresholds at runtime.
 */
function setThresholds(opts) {
  if (opts.window !== undefined) THRESHOLDS.window = opts.window;
  if (opts.minCount !== undefined) THRESHOLDS.minCount = opts.minCount;
  if (opts.cooldown !== undefined) THRESHOLDS.cooldown = opts.cooldown;
}

module.exports = {
  recordError,
  recordXError,
  isFrozen,
  analyze,
  getPatterns,
  getStatus,
  setThresholds,
  X_LOOPS,
};
