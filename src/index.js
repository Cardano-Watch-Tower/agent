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
const { postTweet, postThread, getMentions, reply, splitForThread, isConfigured, BOT_USERNAME } = require('./poster');
const { parseQuery, investigate, investigateAddress, investigateTx, investigateStake } = require('./investigator');
const { createJob, executeJob, formatDelivery, listJobs, STATES } = require('./detective');
const { detectGovernanceEvents, detectTokenEvents } = require('./detectors');
const { checkRepos, composeUpdateTweet, initialize: initRepoMonitor } = require('./repo-monitor');
const { engage } = require('./engager');
const { detectPromise, addFollowUp, getPendingFollowUps, markProcessing, markDelivered, markFailed, cleanup: cleanupFollowUps } = require('./followups');
const browser = require('./browser');

const DRY_RUN = process.argv.includes('--dry-run');
const TEST_MODE = process.argv.includes('--test');

const CHAIN_POLL_MS = 30_000;          // 30 seconds
const MENTION_POLL_MS = 5 * 60_000;    // 5 minutes
const REPO_POLL_MS = 30 * 60_000;      // 30 minutes
const ENGAGE_POLL_MS = 15 * 60_000;    // 15 minutes
const FOLLOWUP_POLL_MS = 2 * 60_000;   // 2 minutes — check for pending follow-ups
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
  console.log('📬 Mention watch started');

  while (true) {
    try {
      const mentions = await getMentions(lastMentionId);

      for (const mention of mentions) {
        // Skip our own tweets — don't reply to yourself
        const mentionAuthor = (mention.authorUsername || '').toLowerCase();
        if (mentionAuthor === BOT_USERNAME.toLowerCase()) {
          console.log(`  (skipped own tweet: ${mention.text.substring(0, 60)}...)`);
          continue;
        }

        console.log(`\n📨 Mention from @${mention.authorUsername}: ${mention.text}`);
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

    // Check if our reply made a promise we need to deliver on
    checkForPromise(mention, text, replyText);
  } catch (e) {
    console.error(`  Casual reply error: ${e.message}`);
  }
}

async function handleQuery(mention, text) {
  try {
    const parsed = parseQuery(text);
    if (!parsed) return; // safety — shouldn't happen since we check before calling

    // Build list of queries (single or multi)
    const queries = parsed.multi ? [...parsed] : [parsed];
    const results = [];

    for (const q of queries) {
      try {
        let data;
        switch (q.type) {
          case 'address': data = await investigateAddress(q.value); break;
          case 'tx': data = await investigateTx(q.value); break;
          case 'stake': data = await investigateStake(q.value); break;
          default: continue;
        }
        if (data) results.push(data);
      } catch (e) {
        console.error(`  Failed ${q.type} lookup: ${e.message}`);
      }
    }

    if (results.length === 0) {
      // All lookups failed — reply gracefully
      const fallback = await casualReply(`${text}\n(They shared some on-chain data but lookups failed — be helpful, suggest trying again)`);
      if (!DRY_RUN) await reply(mention.id, fallback);
      return;
    }

    // Pass single result or array to brain
    const data = results.length === 1 ? results[0] : results;
    const replyText = await respondToQuery(text, data);

    // Split if too long
    const tweets = splitForThread(replyText);
    if (!DRY_RUN) {
      if (tweets.length === 1) {
        await reply(mention.id, tweets[0]);
      } else {
        let prevId = mention.id;
        for (const t of tweets) {
          prevId = await postTweet(t, prevId);
          await sleep(1000);
        }
      }
      stats.tweetsPosted += tweets.length;
    }
    console.log(`  Reply (${tweets.length} tweets): ${tweets[0]?.substring(0, 80)}...`);

    // Check if our reply promised a deeper follow-up
    checkForPromise(mention, text, replyText);
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

// ─── Follow-Up Accountability ──────────────────────────────

/**
 * After we reply to someone, check if our reply promised to do something.
 * If it did, and we can figure out WHAT to investigate, queue a follow-up.
 */
function checkForPromise(mention, originalText, ourReply) {
  const promise = detectPromise(ourReply);
  if (!promise) return;

  // Try to extract something investigatable from the original message
  const parsed = parseQuery(originalText);
  const queryType = parsed ? parsed.type : null;
  const queryValue = parsed ? parsed.value : null;

  addFollowUp({
    tweetId: mention.id,
    username: mention.authorUsername || 'unknown',
    originalText,
    promiseText: promise,
    queryType,
    queryValue
  });
}

/**
 * Process pending follow-ups: investigate what we promised, reply with results.
 */
async function followUpLoop() {
  // Wait 3 minutes before starting (let other loops stabilize)
  await sleep(180_000);
  console.log('📌 Follow-up processor started');

  while (true) {
    try {
      const pending = getPendingFollowUps();

      for (const followUp of pending) {
        console.log(`\n📌 Processing follow-up ${followUp.id} for @${followUp.username}`);
        markProcessing(followUp.id);

        try {
          let result = null;
          let replyText = null;

          // If we know what to investigate, do it
          if (followUp.queryType && followUp.queryValue) {
            switch (followUp.queryType) {
              case 'address': result = await investigateAddress(followUp.queryValue); break;
              case 'tx': result = await investigateTx(followUp.queryValue); break;
              case 'stake': result = await investigateStake(followUp.queryValue); break;
            }

            if (result) {
              // Use the brain to format a follow-up reply
              replyText = await respondToQuery(
                `[FOLLOW-UP] @${followUp.username} asked: ${followUp.originalText}\n\nYou previously said you'd look into it. Now deliver the actual findings.`,
                result
              );
            }
          }

          // If no specific query or investigation failed, generate a generic follow-up
          if (!replyText) {
            replyText = await casualReply(
              `[FOLLOW-UP] @${followUp.username} asked: ${followUp.originalText}\n\n` +
              `You promised "${followUp.promiseText}" but couldn't find specific on-chain data. ` +
              `Give a helpful follow-up — acknowledge you checked, share what you found (or didn't), ` +
              `and offer to help if they share a specific address/tx/stake key.`
            );
          }

          if (replyText && !DRY_RUN) {
            const tweets = splitForThread(replyText);
            await reply(followUp.tweetId, tweets[0]);
            stats.tweetsPosted++;
            markDelivered(followUp.id);
          } else if (DRY_RUN) {
            console.log(`  [DRY RUN] Would reply: ${replyText?.substring(0, 100)}...`);
            markDelivered(followUp.id);
          }
        } catch (e) {
          markFailed(followUp.id, e.message);
        }

        // Don't hammer X — wait between follow-ups
        await sleep(30_000);
      }

      // Weekly cleanup of old entries
      cleanupFollowUps();
    } catch (e) {
      console.error(`Follow-up loop error: ${e.message}`);
    }

    if (TEST_MODE) break;
    await sleep(FOLLOWUP_POLL_MS);
  }
}

// ─── Utilities ──────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Startup ────────────────────────────────────────────────

async function main() {
  // Initialize browser and check X login status
  let xReady = false;
  try {
    await browser.launch();
    xReady = await browser.isLoggedIn();
  } catch (e) {
    console.error(`Browser init failed: ${e.message}`);
  }

  console.log(`
╔══════════════════════════════════════════════╗
║         CARDANO WATCH TOWER  👁️              ║
║         We're watching.                      ║
╠══════════════════════════════════════════════╣
║  Mode: ${DRY_RUN ? 'DRY RUN' : TEST_MODE ? 'TEST   ' : 'LIVE   '}                              ║
║  X:    ${xReady ? '✓ Logged in (browser)' : '✗ Not logged in'}              ║
║  Brain: xAI Grok (direct)                   ║
║  Chain: Cardano mainnet                      ║
║  Follow-ups: ${String(getPendingFollowUps().length).padEnd(3)} pending                      ║
╚══════════════════════════════════════════════╝
`);

  if (!xReady && !DRY_RUN && !TEST_MODE) {
    console.log('⚠️  Not logged into X. Run: node src/login.js');
    console.log('   Once logged in, cookies persist across restarts.\n');
  }

  // Restore stats from disk (survives restarts)
  loadStats();

  if (TEST_MODE) {
    console.log('Running single test pass...\n');
    await chainWatchLoop();
    console.log('\n--- Test complete ---');
    await browser.close();
    process.exit(0);
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    saveStats();
    await browser.close();
    process.exit(0);
  });

  // Run all loops concurrently
  Promise.all([
    chainWatchLoop(),
    mentionWatchLoop(),
    repoWatchLoop(),
    engagementLoop(),
    dailyDigestLoop(),
    followUpLoop()
  ]).catch(async e => {
    console.error('Fatal error:', e);
    await browser.close();
    process.exit(1);
  });
}

main();
