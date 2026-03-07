/**
 * CARDANOWATCHTOWER — Main Orchestrator
 *
 * Runs three concurrent loops:
 *   1. Chain Watch   — polls new blocks, detects events, posts alerts
 *   2. Mention Watch — checks @mentions, handles queries + detective requests
 *   3. Daily Digest  — posts daily summary at midnight UTC
 *
 * Usage:
 *   node src/index.js              — full production mode
 *   node src/index.js --dry-run    — analyze but don't post
 *   node src/index.js --test       — single pass then exit
 */
require('dotenv').config();

const { checkForNewBlock, scanBlock, loadState, saveState, updateState } = require('./watcher');
const { formatTweet, formatAlert, formatAda } = require('./formatter');
const { shouldTweet, composeTweet, respondToQuery, assessJob, dailySummary } = require('./brain');
const { postTweet, postThread, getMentions, reply, splitForThread, isConfigured } = require('./poster');
const { parseQuery, investigate } = require('./investigator');
const { createJob, executeJob, formatDelivery, listJobs, STATES } = require('./detective');
const { detectGovernanceEvents, detectTokenEvents } = require('./detectors');

const DRY_RUN = process.argv.includes('--dry-run');
const TEST_MODE = process.argv.includes('--test');

const CHAIN_POLL_MS = 30_000;          // 30 seconds
const MENTION_POLL_MS = 5 * 60_000;    // 5 minutes
const DAILY_DIGEST_HOUR = 0;           // midnight UTC

// Runtime stats for daily digest
const stats = {
  blocksScanned: 0,
  alertsGenerated: 0,
  tweetsPosted: 0,
  mentionsHandled: 0,
  jobsCreated: 0,
  startedAt: new Date().toISOString()
};

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
        console.log(`\n📨 Mention from ${mention.authorId}: ${mention.text}`);
        stats.mentionsHandled++;

        // Update last seen
        if (!lastMentionId || mention.id > lastMentionId) {
          lastMentionId = mention.id;
        }

        // Determine intent: investigation query or detective hire?
        const text = mention.text.replace(/@\w+/g, '').trim();

        if (text.toLowerCase().includes('investigate') ||
            text.toLowerCase().includes('hire') ||
            text.toLowerCase().includes('trace') ||
            text.toLowerCase().includes('detective')) {
          // Detective request
          await handleDetectiveRequest(mention, text);
        } else {
          // Regular query
          await handleQuery(mention, text);
        }
      }
    } catch (e) {
      console.error(`Mention watch error: ${e.message}`);
    }

    if (TEST_MODE) break;
    await sleep(MENTION_POLL_MS);
  }
}

async function handleQuery(mention, text) {
  try {
    const parsed = parseQuery(text);
    if (!parsed) {
      // Can't parse — ask brain for a generic response
      const replyText = await respondToQuery(text, { note: 'No address or tx hash found in query' });
      if (!DRY_RUN) {
        await reply(mention.id, replyText);
        stats.tweetsPosted++;
      }
      console.log(`  Reply: ${replyText}`);
      return;
    }

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
        const digestText = await dailySummary(stats);
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
      } catch (e) {
        console.error(`Daily digest error: ${e.message}`);
      }
    }

    if (TEST_MODE) break;
    await sleep(60_000); // Check every minute
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
    dailyDigestLoop()
  ]).catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}

main();
