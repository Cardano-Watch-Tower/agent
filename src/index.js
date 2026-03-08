/**
 * CARDANOWATCHTOWER — Main Orchestrator
 *
 * Runs five concurrent loops:
 *   1. Chain Watch   — polls new blocks, detects events, posts alerts
 *   2. Mention Watch — checks @mentions, handles queries + detective requests
 *   3. Repo Watch    — monitors GitHub repos, tweets about updates
 *   4. Engagement    — searches Cardano conversations, likes, replies, follows back
 *   5. Daily Digest  — posts daily summary at midnight UTC
 *
 * Usage:
 *   node src/index.js              — full production mode
 *   node src/index.js --dry-run    — analyze but don't post
 *   node src/index.js --test       — single pass then exit
 */
require('dotenv').config();

const { checkForNewBlock, scanBlock, loadState, saveState, updateState } = require('./watcher');
const { formatTweet, formatAlert, formatAda } = require('./formatter');
const { shouldTweet, composeTweet, respondToQuery, assessJob, dailySummary, casualReply } = require('./brain');
const { postTweet, postThread, getMentions, reply, splitForThread, isConfigured } = require('./poster');
const { parseQuery, investigate } = require('./investigator');
const { createJob, executeJob, formatDelivery, listJobs, STATES } = require('./detective');
const { detectGovernanceEvents, detectTokenEvents } = require('./detectors');
const { checkRepos, composeUpdateTweet, initialize: initRepoMonitor } = require('./repo-monitor');
const { engage } = require('./engager');

const DRY_RUN = process.argv.includes('--dry-run');
const TEST_MODE = process.argv.includes('--test');

const CHAIN_POLL_MS = 30_000;          // 30 seconds
const MENTION_POLL_MS = 5 * 60_000;    // 5 minutes
const REPO_POLL_MS = 30 * 60_000;      // 30 minutes
const ENGAGE_POLL_MS = 15 * 60_000;    // 15 minutes
const DAILY_DIGEST_HOUR = 0;           // midnight UTC

// Runtime stats for daily digest — persisted to disk so restarts don't wipe them
const fs = require('fs');
const path = require('path');
const STATS_FILE = path.join(__dirname, '..', 'daily-stats.json');

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      // Always restore lastMentionId (prevents re-replying on restart)
      if (saved.lastMentionId) {
        lastMentionId = saved.lastMentionId;
      }
      // Only restore counters if same calendar day (UTC)
      const savedDate = saved.date;
      const today = new Date().toISOString().split('T')[0];
      if (savedDate === today) {
        Object.assign(stats, saved);
        console.log(`📊 Restored daily stats: ${stats.blocksScanned} blocks, ${stats.alertsGenerated} alerts`);
      }
      if (lastMentionId) {
        console.log(`📬 Restored last mention ID: ${lastMentionId}`);
      }
    }
  } catch (e) { /* fresh start */ }
}

function saveStats() {
  try {
    stats.date = new Date().toISOString().split('T')[0];
    stats.lastMentionId = lastMentionId;
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) { /* ignore */ }
}

const stats = {
  blocksScanned: 0,
  alertsGenerated: 0,
  tweetsPosted: 0,
  mentionsHandled: 0,
  jobsCreated: 0,
  largestMoveAda: 0,
  largestMoveTx: null,
  engagementReplies: 0,
  engagementLikes: 0,
  engagementFollows: 0,
  startedAt: new Date().toISOString(),
  date: new Date().toISOString().split('T')[0],
  lastMentionId: null
};

// lastMentionId lives in stats so it persists across restarts
let lastMentionId = null;

// ─── Chain Watch Loop ───────────────────────────────────────

async function chainWatchLoop() {
  console.log('👁️  Chain watch started');
  loadState();

  while (true) {
    try {
      const block = await checkForNewBlock();

      if (block) {
        console.log(`\n📦 Block ${block.height} | ${block.tx_count} txs`);
        stats.blocksScanned++;

        if (block.tx_count > 0) {
          const alerts = await scanBlock(block);

          for (const alert of alerts) {
            stats.alertsGenerated++;
            // Track largest move of the day
            if (alert.totalMoved && alert.totalMoved > stats.largestMoveAda) {
              stats.largestMoveAda = alert.totalMoved;
              stats.largestMoveTx = alert.txHash;
            }
            console.log(formatAlert(alert));

            // Ask the brain if this is worth tweeting
            const verdict = await shouldTweet(alert);

            if (verdict.worthy) {
              const tweetText = await composeTweet(alert);
              console.log(`\n🐦 Tweet draft: ${tweetText}`);

              if (!DRY_RUN && isConfigured()) {
                try {
                  const tweetId = await postTweet(tweetText);
                  stats.tweetsPosted++;
                  console.log(`✓ Posted tweet ${tweetId}`);
                } catch (e) {
                  console.error(`✗ Tweet failed: ${e.message}`);
                }
              } else {
                console.log('  (dry run — not posted)');
              }
            } else {
              console.log(`  Skipped: ${verdict.reason}`);
            }
          }
        }

        updateState(block);
        saveState();
        saveStats();
      }
    } catch (e) {
      console.error(`Chain watch error: ${e.message}`);
    }

    if (TEST_MODE) break;
    await sleep(CHAIN_POLL_MS);
  }
}

// ─── Mention Watch Loop ─────────────────────────────────────

async function mentionWatchLoop() {
  if (!isConfigured()) {
    console.log('⚠️  X API not configured — mention watching disabled');
    return;
  }

  console.log('📬 Mention watch started');

  while (true) {
    try {
      const mentions = await getMentions(lastMentionId);

      for (const mention of mentions) {
        // Skip our own tweets — don't reply to yourself
        if (mention.authorId === '2030350948594536449') {
          console.log(`  (skipped own tweet: ${mention.text.substring(0, 60)}...)`);
          continue;
        }

        console.log(`\n📨 Mention from ${mention.authorId}: ${mention.text}`);
        stats.mentionsHandled++;

        // Update last seen
        if (!lastMentionId || mention.id > lastMentionId) {
          lastMentionId = mention.id;
        }

        // Determine intent: detective request, on-chain query, or casual interaction
        const text = mention.text.replace(/@\w+/g, '').trim();
        const lower = text.toLowerCase();

        if (lower.includes('investigate') || lower.includes('hire') ||
            lower.includes('trace') || lower.includes('detective')) {
          await handleDetectiveRequest(mention, text);
        } else if (parseQuery(text)) {
          // Has an address, tx hash, or stake key — on-chain query
          await handleQuery(mention, text);
        } else {
          // Casual interaction — emoji, greeting, comment, etc.
          await handleCasual(mention, text);
        }
      }

      // Persist lastMentionId so restarts don't re-reply
      saveStats();
    } catch (e) {
      console.error(`Mention watch error: ${e.message}`);
    }

    if (TEST_MODE) break;
    await sleep(MENTION_POLL_MS);
  }
}

async function handleCasual(mention, text) {
  try {
    const replyText = await casualReply(text);
    if (!DRY_RUN) {
      await reply(mention.id, replyText);
      stats.tweetsPosted++;
    }
    console.log(`  Casual reply: ${replyText}`);
  } catch (e) {
    console.error(`  Casual reply error: ${e.message}`);
  }
}

async function handleQuery(mention, text) {
  try {
    const parsed = parseQuery(text);
    const data = await investigate(parsed.value);
    const replyText = await respondToQuery(text, data);

    // Split if too long
    const tweets = splitForThread(replyText);
    if (!DRY_RUN) {
      if (tweets.length === 1) {
        await reply(mention.id, tweets[0]);
      } else {
        // First tweet replies to mention, rest chain
        let prevId = mention.id;
        for (const t of tweets) {
          prevId = await postTweet(t, prevId);
          await sleep(1000);
        }
      }
      stats.tweetsPosted += tweets.length;
    }
    console.log(`  Reply (${tweets.length} tweets): ${tweets[0]?.substring(0, 80)}...`);
  } catch (e) {
    console.error(`  Query handling error: ${e.message}`);
  }
}

async function handleDetectiveRequest(mention, text) {
  try {
    const job = await createJob(text, mention.authorId);
    stats.jobsCreated++;

    const quoteReply = job.assessment?.reply ||
      `📋 Job #${job.id} — ${formatAda(job.quoteAda)} quote. DM to confirm.`;

    if (!DRY_RUN) {
      await reply(mention.id, quoteReply);
      stats.tweetsPosted++;
    }
    console.log(`  Detective quote: ${quoteReply}`);
  } catch (e) {
    console.error(`  Detective request error: ${e.message}`);
  }
}

// ─── Daily Digest ───────────────────────────────────────────

async function dailyDigestLoop() {
  console.log('📊 Daily digest scheduled');
  let lastDigestDate = null;

  while (true) {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const today = now.toISOString().split('T')[0];

    if (utcHour === DAILY_DIGEST_HOUR && lastDigestDate !== today) {
      lastDigestDate = today;

      try {
        // Compute uptime and enrich stats for the brain
        const uptimeMs = Date.now() - new Date(stats.startedAt).getTime();
        const uptimeHours = Math.round(uptimeMs / 3_600_000);
        const digestContext = {
          ...stats,
          uptimeHours,
          largestMoveFormatted: stats.largestMoveAda > 0 ? formatAda(stats.largestMoveAda) : null
        };

        const digestText = await dailySummary(digestContext);
        console.log(`\n📊 Daily digest: ${digestText}`);

        if (!DRY_RUN && isConfigured()) {
          const tweetId = await postTweet(digestText);
          console.log(`✓ Digest posted: ${tweetId}`);
        }

        // Reset daily stats
        stats.blocksScanned = 0;
        stats.alertsGenerated = 0;
        stats.tweetsPosted = 0;
        stats.mentionsHandled = 0;
        stats.jobsCreated = 0;
        stats.largestMoveAda = 0;
        stats.largestMoveTx = null;
        stats.engagementReplies = 0;
        stats.engagementLikes = 0;
        stats.engagementFollows = 0;
        stats.startedAt = new Date().toISOString();
        saveStats();
      } catch (e) {
        console.error(`Daily digest error: ${e.message}`);
      }
    }

    if (TEST_MODE) break;
    await sleep(60_000); // Check every minute
  }
}

// ─── Repo Watch Loop ────────────────────────────────────────

async function repoWatchLoop() {
  await initRepoMonitor();

  while (true) {
    try {
      const updates = await checkRepos();

      for (const update of updates) {
        console.log(`\n📂 Repo update: ${update.owner}/${update.repo} — ${update.commits.length} new commit(s)`);

        const tweetText = await composeUpdateTweet(update);
        console.log(`🐦 Repo tweet: ${tweetText}`);

        if (!DRY_RUN && isConfigured()) {
          try {
            const tweetId = await postTweet(tweetText);
            stats.tweetsPosted++;
            console.log(`✓ Posted repo update tweet ${tweetId}`);
          } catch (e) {
            console.error(`✗ Repo tweet failed: ${e.message}`);
          }
        } else {
          console.log('  (dry run — not posted)');
        }
      }
    } catch (e) {
      console.error(`Repo watch error: ${e.message}`);
    }

    if (TEST_MODE) break;
    await sleep(REPO_POLL_MS);
  }
}

// ─── Community Engagement Loop ─────────────────────────────

async function engagementLoop() {
  if (!isConfigured()) {
    console.log('⚠️  X API not configured — engagement disabled');
    return;
  }

  // Wait 2 minutes before first engagement cycle (let other loops initialize)
  await sleep(120_000);
  console.log('🤝 Community engagement started');

  while (true) {
    try {
      if (!DRY_RUN) {
        const results = await engage();
        if (results.replied > 0 || results.liked > 0 || results.followed > 0) {
          console.log(`\n🤝 Engagement: ${results.searched} found, ${results.replied} replies, ${results.liked} likes, ${results.followed} follows`);
          stats.tweetsPosted += results.replied;
          stats.engagementReplies += results.replied;
          stats.engagementLikes += results.liked;
          stats.engagementFollows += results.followed;
        }
      } else {
        console.log('  (dry run — engagement skipped)');
      }
    } catch (e) {
      console.error(`Engagement error: ${e.message}`);
    }

    if (TEST_MODE) break;
    await sleep(ENGAGE_POLL_MS);
  }
}

// ─── Utilities ──────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Startup ────────────────────────────────────────────────

async function main() {
  console.log(`
╔══════════════════════════════════════════════╗
║         CARDANO WATCH TOWER  👁️              ║
║         We're watching.                      ║
╠══════════════════════════════════════════════╣
║  Mode: ${DRY_RUN ? 'DRY RUN' : TEST_MODE ? 'TEST   ' : 'LIVE   '}                              ║
║  X API: ${isConfigured() ? '✓ Connected' : '✗ Not configured'}                       ║
║  Chain: Cardano mainnet                      ║
╚══════════════════════════════════════════════╝
`);

  // Restore stats from disk (survives restarts)
  loadStats();

  if (TEST_MODE) {
    console.log('Running single test pass...\n');
    await chainWatchLoop();
    console.log('\n--- Test complete ---');
    process.exit(0);
  }

  // Run all loops concurrently
  Promise.all([
    chainWatchLoop(),
    mentionWatchLoop(),
    repoWatchLoop(),
    engagementLoop(),
    dailyDigestLoop()
  ]).catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}

main();
