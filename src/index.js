/**
 * CARDANOWATCHTOWER — Main Orchestrator
 *
 * Runs ten concurrent loops:
 *   1. Chain Watch      — polls new blocks, detects events, posts alerts
 *   2. Mention Watch    — checks @mentions, handles queries + investigation requests
 *   3. Repo Watch       — monitors GitHub repos, tweets about updates
 *   4. Engagement       — searches Cardano conversations, likes, replies, follows, reposts
 *   5. Daily Digest     — posts daily summary at midnight UTC
 *   6. Follow-Up        — delivers promised follow-up replies
 *   7. Messenger        — checks inbox, processes inter-agent messages
 *   8. Analyst          — monitors error patterns, X safety circuit breaker
 *   9. Thoughts         — posts 7-12 original Cardano thoughts per day
 *  10. Help Reminders   — posts 5 reminders per week that CW is available to help
 *
 * Usage:
 *   node src/index.js              — full production mode
 *   node src/index.js --dry-run    — analyze but don't post
 *   node src/index.js --test       — single pass then exit
 */
require('dotenv').config();

const { checkForNewBlock, scanBlock, loadState, saveState, updateState } = require('./watcher');
const { formatTweet, formatAlert, formatAda } = require('./formatter');
const { shouldTweet, composeTweet, respondToQuery, assessJob, dailySummary, casualReply, generateThought, generateHelpReminder } = require('./brain');
const { postTweet, postThread, getMentions, reply, splitForThread, isConfigured, BOT_USERNAME } = require('./poster');
const { parseQuery, investigate, investigateAddress, investigateTx, investigateStake, investigateDrep } = require('./investigator');
const { createJob, executeJob, formatDelivery, listJobs, STATES } = require('./detective');
const { detectGovernanceEvents, detectTokenEvents } = require('./detectors');
const { checkRepos, composeUpdateTweet, initialize: initRepoMonitor } = require('./repo-monitor');
const { engage } = require('./engager');
const { detectPromise, addFollowUp, getPendingFollowUps, markProcessing, markDelivered, markFailed, cleanup: cleanupFollowUps } = require('./followups');
const browser = require('./browser');
const messenger = require('./messenger');
const analyst = require('./analyst');

const DRY_RUN = process.argv.includes('--dry-run');
const TEST_MODE = process.argv.includes('--test');

const CHAIN_POLL_MS    = 30_000;       // 30 seconds
const MENTION_POLL_MS  = 5 * 60_000;   // 5 minutes
const REPO_POLL_MS     = 30 * 60_000;  // 30 minutes
const ENGAGE_POLL_MS   = 15 * 60_000;  // 15 minutes
const FOLLOWUP_POLL_MS = 2 * 60_000;   // 2 minutes
const MESSENGER_POLL_MS = 60_000;      // 60 seconds
const ANALYST_POLL_MS  = 5 * 60_000;   // 5 minutes
const THOUGHT_POLL_MS  = 180 * 60_000; // 180 minutes (3-5 posts/day, new account safety)
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
  engagementReposts: 0,
  thoughtsPosted: 0,
  helpRemindersPosted: 0,
  consecutiveErrors: 0,
  startedAt: new Date().toISOString(),
  date: new Date().toISOString().split('T')[0],
  lastMentionId: null
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
            if (alert.totalMoved && alert.totalMoved > stats.largestMoveAda) {
              stats.largestMoveAda = alert.totalMoved;
              stats.largestMoveTx = alert.txHash;
            }
            console.log(formatAlert(alert));

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
                  analyst.recordError('poster', e);
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
      analyst.recordError('chain', e);
    }

    if (TEST_MODE) break;
    await sleep(CHAIN_POLL_MS);
  }
}

// ─── Mention Watch Loop ─────────────────────────────────────

async function mentionWatchLoop() {
  console.log('📬 Mention watch started');

  while (true) {
    if (analyst.isFrozen()) { await sleep(10_000); continue; }
    try {
      const mentions = await getMentions(lastMentionId);

      for (const mention of mentions) {
        const mentionAuthor = (mention.authorUsername || '').toLowerCase();
        if (mentionAuthor === BOT_USERNAME.toLowerCase()) {
          console.log(`  (skipped own tweet: ${mention.text.substring(0, 60)}...)`);
          continue;
        }

        if (lastMentionId && mention.id) {
          try {
            if (BigInt(mention.id) <= BigInt(lastMentionId)) continue;
          } catch (e) { /* non-numeric ID, process anyway */ }
        }

        console.log(`\n📨 Mention from @${mention.authorUsername}: ${mention.text}`);
        stats.mentionsHandled++;

        if (!lastMentionId || mention.id > lastMentionId) {
          lastMentionId = mention.id;
        }

        const text = mention.text.replace(/@\w+/g, '').trim();
        const lower = text.toLowerCase();

        if (lower.includes('investigate') || lower.includes('hire') ||
            lower.includes('trace') || lower.includes('detective')) {
          await handleDetectiveRequest(mention, text);
        } else if (parseQuery(text)) {
          await handleQuery(mention, text);
        } else {
          await handleCasual(mention, text);
        }
      }

      saveStats();
    } catch (e) {
      console.error(`Mention watch error: ${e.message}`);
      analyst.recordError('mention', e);
    }

    if (TEST_MODE) break;
    await sleep(MENTION_POLL_MS);
  }
}

async function handleCasual(mention, text) {
  try {
    const replyText = await casualReply(text);
    if (!DRY_RUN) {
      await reply(String(mention.id), replyText);
      stats.tweetsPosted++;
    }
    console.log(`  Casual reply: ${replyText}`);
    checkForPromise(mention, text, replyText);
  } catch (e) {
    console.error(`  Casual reply error: ${e.message}`);
  }
}

async function handleQuery(mention, text) {
  try {
    const parsed = parseQuery(text);
    if (!parsed) return;

    const queries = parsed.multi ? [...parsed] : [parsed];
    const results = [];

    for (const q of queries) {
      try {
        let data;
        switch (q.type) {
          case 'address': data = await investigateAddress(q.value); break;
          case 'tx':      data = await investigateTx(q.value);      break;
          case 'stake':   data = await investigateStake(q.value);   break;
          case 'drep':    data = await investigateDrep(q.value);    break;
          default: continue;
        }
        if (data) results.push(data);
      } catch (e) {
        console.error(`  Failed ${q.type} lookup: ${e.message}`);
      }
    }

    if (results.length === 0) {
      const fallback = await casualReply(`${text}\n(They shared some on-chain data but lookups failed — be helpful, suggest trying again)`);
      if (!DRY_RUN) await reply(mention.id, fallback);
      return;
    }

    const data = results.length === 1 ? results[0] : results;
    const replyText = await respondToQuery(text, data);

    const tweets = splitForThread(replyText);
    if (!DRY_RUN) {
      let replyToId = String(mention.id);
      for (let i = 0; i < tweets.length; i++) {
        const isFirst = (i === 0);
        const newId = await reply(replyToId, tweets[i], null, { isThreadContinuation: !isFirst });
        if (newId && typeof newId === 'string') replyToId = newId;
        if (i < tweets.length - 1) await sleep(30000);  // 30s between thread chunks
      }
      stats.tweetsPosted += 1;  // Whole thread counts as 1
    }
    console.log(`  Reply (${tweets.length} tweets): ${tweets[0]?.substring(0, 80)}...`);
    checkForPromise(mention, text, replyText);
  } catch (e) {
    console.error(`  Query handling error: ${e.message}`);
  }
}

/**
 * Handle investigation requests.
 * Investigations are free — no payment required.
 * Payment code is preserved in detective.js for future activation.
 */
async function handleDetectiveRequest(mention, text) {
  try {
    // Check if they provided an address/tx we can immediately investigate
    const parsed = parseQuery(text);

    if (parsed) {
      // We have something to investigate — do it now, for free
      console.log(`  🔍 Investigating for @${mention.authorUsername}...`);
      try {
        let data;
        switch (parsed.type) {
          case 'address': data = await investigateAddress(parsed.value); break;
          case 'tx':      data = await investigateTx(parsed.value);      break;
          case 'stake':   data = await investigateStake(parsed.value);   break;
          case 'drep':    data = await investigateDrep(parsed.value);    break;
        }

        if (data) {
          const replyText = await respondToQuery(text, data);
          const tweets = splitForThread(replyText);
          if (!DRY_RUN) {
            let replyToId = String(mention.id);
            for (let i = 0; i < tweets.length; i++) {
              const isFirst = (i === 0);
              const newId = await reply(replyToId, tweets[i], null, { isThreadContinuation: !isFirst });
              if (newId && typeof newId === 'string') replyToId = newId;
              if (i < tweets.length - 1) await sleep(30000);
            }
            stats.tweetsPosted += 1;
          }
          console.log(`  Investigation reply (${tweets.length} tweets): ${tweets[0]?.substring(0, 80)}...`);
          return;
        }
      } catch (e) {
        console.error(`  Investigation lookup failed: ${e.message}`);
      }
    }

    // No address/tx found — ask them to provide one, still positioned as free help
    const assessment = await assessJob(text);
    const replyText = assessment.reply || 'Drop the address or tx hash and we\'ll take a look.';

    if (!DRY_RUN) {
      await reply(mention.id, replyText);
      stats.tweetsPosted++;
    }
    console.log(`  Investigation response: ${replyText}`);
  } catch (e) {
    console.error(`  Detective request error: ${e.message}`);
  }
}

// ─── Daily Digest ───────────────────────────────────────────

async function dailyDigestLoop() {
  console.log('📊 Daily digest scheduled');
  let lastDigestDate = null;

  while (true) {
    if (analyst.isFrozen()) { await sleep(10_000); continue; }
    const now = new Date();
    const utcHour = now.getUTCHours();
    const today = now.toISOString().split('T')[0];

    if (utcHour === DAILY_DIGEST_HOUR && lastDigestDate !== today) {
      lastDigestDate = today;

      try {
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

        try {
          await messenger.dailyReport(digestContext);
        } catch (e) {
          console.error('Daily report email error: ' + e.message);
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
        stats.engagementReposts = 0;
        stats.thoughtsPosted = 0;
        stats.helpRemindersPosted = 0;
        stats.startedAt = new Date().toISOString();
        saveStats();
      } catch (e) {
        console.error(`Daily digest error: ${e.message}`);
        analyst.recordError('digest-post', e);
      }
    }

    if (TEST_MODE) break;
    await sleep(60_000);
  }
}

// ─── Repo Watch Loop ────────────────────────────────────────

async function repoWatchLoop() {
  await initRepoMonitor();

  while (true) {
    if (analyst.isFrozen()) { await sleep(10_000); continue; }
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
            analyst.recordError('poster', e);
          }
        }
      }
    } catch (e) {
      console.error(`Repo watch error: ${e.message}`);
      analyst.recordError('repo', e);
    }

    if (TEST_MODE) break;
    await sleep(REPO_POLL_MS);
  }
}

// ─── Community Engagement Loop ─────────────────────────────

async function engagementLoop() {
  await sleep(120_000); // 2-minute warmup
  console.log('🤝 Community engagement started');

  while (true) {
    if (analyst.isFrozen()) { await sleep(10_000); continue; }
    try {
      if (!DRY_RUN) {
        const results = await engage();
        const hasActivity = results.replied > 0 || results.liked > 0 || results.followed > 0 || results.reposted > 0;
        if (hasActivity) {
          console.log(`\n🤝 Engagement: ${results.searched} found, ${results.replied} replies, ${results.liked} likes, ${results.followed} follows, ${results.reposted} reposts`);
          stats.tweetsPosted += results.replied;
          stats.engagementReplies += results.replied;
          stats.engagementLikes += results.liked;
          stats.engagementFollows += results.followed;
          stats.engagementReposts += results.reposted;
          saveStats();
        }
      }
    } catch (e) {
      console.error(`Engagement error: ${e.message}`);
      analyst.recordError('engagement', e);
    }

    if (TEST_MODE) break;
    await sleep(ENGAGE_POLL_MS);
  }
}

// ─── Original Thoughts Loop ─────────────────────────────────

/**
 * Posts 7-12 original Cardano thoughts per day.
 * Spread across the day every ~90 minutes.
 * Daily target is randomized in the 7-12 range.
 */
async function thoughtsLoop() {
  await sleep(300_000); // 5-minute warmup

  // Randomize daily target for thoughts
  const dailyThoughtsTarget = Math.floor(Math.random() * 3) + 3; // 3-5 (new account safety)
  let thoughtsToday = 0;
  let thoughtsResetDate = new Date().toISOString().split('T')[0];

  console.log(`💭 Thoughts loop started — target: ${dailyThoughtsTarget} posts today`);

  while (true) {
    if (analyst.isFrozen()) { await sleep(10_000); continue; }

    // Reset counter at midnight UTC
    const today = new Date().toISOString().split('T')[0];
    if (today !== thoughtsResetDate) {
      thoughtsToday = 0;
      thoughtsResetDate = today;
      // New random target for the day
      const newTarget = Math.floor(Math.random() * 3) + 3;
      console.log(`💭 New day — thoughts target: ${newTarget}`);
    }

    if (thoughtsToday < dailyThoughtsTarget) {
      try {
        if (!DRY_RUN && isConfigured()) {
          // Give the brain some context from today's activity
          const context = {
            blocksScanned: stats.blocksScanned,
            alertsGenerated: stats.alertsGenerated,
            largestMoveAda: stats.largestMoveAda > 0 ? stats.largestMoveAda : undefined,
          };

          const thought = await generateThought(Object.keys(context).length > 0 ? context : {});
          console.log(`\n💭 Thought: ${thought}`);

          const tweetId = await postTweet(thought);
          thoughtsToday++;
          stats.tweetsPosted++;
          stats.thoughtsPosted++;
          saveStats();
          console.log(`✓ Thought posted (${thoughtsToday}/${dailyThoughtsTarget} today): ${tweetId}`);
        } else if (DRY_RUN) {
          const thought = await generateThought({});
          console.log(`\n💭 [DRY RUN] Thought: ${thought}`);
          thoughtsToday++;
        }
      } catch (e) {
        console.error(`Thought post error: ${e.message}`);
        analyst.recordError('poster', e);
      }
    }

    if (TEST_MODE) break;
    await sleep(THOUGHT_POLL_MS);
  }
}

// ─── Help Reminder Loop ─────────────────────────────────────

/**
 * Posts 5 help reminders per week — randomly spaced.
 * Reminds the community that @CardanoWatchers is available to help
 * with on-chain questions. No fees mentioned.
 */
async function helpReminderLoop() {
  await sleep(600_000); // 10-minute warmup

  const REMINDERS_PER_WEEK = 5;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const BASE_INTERVAL_MS = Math.floor(WEEK_MS / REMINDERS_PER_WEEK); // ~1.4 days between reminders

  let remindersThisWeek = 0;
  let weekStartDate = getWeekStart();

  console.log(`📢 Help reminder loop started — ${REMINDERS_PER_WEEK} reminders per week`);

  while (true) {
    if (analyst.isFrozen()) { await sleep(10_000); continue; }

    // Reset weekly counter
    const currentWeekStart = getWeekStart();
    if (currentWeekStart !== weekStartDate) {
      remindersThisWeek = 0;
      weekStartDate = currentWeekStart;
      console.log('📢 New week — help reminder counter reset');
    }

    if (remindersThisWeek < REMINDERS_PER_WEEK) {
      try {
        if (!DRY_RUN && isConfigured()) {
          const reminderText = await generateHelpReminder();
          console.log(`\n📢 Help reminder: ${reminderText}`);

          const tweetId = await postTweet(reminderText);
          remindersThisWeek++;
          stats.tweetsPosted++;
          stats.helpRemindersPosted++;
          saveStats();
          console.log(`✓ Help reminder posted (${remindersThisWeek}/${REMINDERS_PER_WEEK} this week): ${tweetId}`);
        } else if (DRY_RUN) {
          const reminderText = await generateHelpReminder();
          console.log(`\n📢 [DRY RUN] Reminder: ${reminderText}`);
          remindersThisWeek++;
        }
      } catch (e) {
        console.error(`Help reminder error: ${e.message}`);
        analyst.recordError('poster', e);
      }
    }

    // Randomize interval slightly to avoid predictable posting times
    const jitter = Math.floor(Math.random() * 2 * 60 * 60 * 1000); // up to 2 hours of jitter
    if (TEST_MODE) break;
    await sleep(BASE_INTERVAL_MS + jitter);
  }
}

function getWeekStart() {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const startOfWeek = new Date(now);
  startOfWeek.setUTCDate(now.getUTCDate() - dayOfWeek);
  startOfWeek.setUTCHours(0, 0, 0, 0);
  return startOfWeek.toISOString().split('T')[0];
}

// ─── Follow-Up Accountability ──────────────────────────────

function checkForPromise(mention, originalText, ourReply) {
  const promise = detectPromise(ourReply);
  if (!promise) return;

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

async function followUpLoop() {
  await sleep(180_000); // 3-minute warmup
  console.log('📌 Follow-up processor started');

  while (true) {
    if (analyst.isFrozen()) { await sleep(10_000); continue; }
    try {
      const pending = getPendingFollowUps();

      for (const followUp of pending) {
        console.log(`\n📌 Processing follow-up ${followUp.id} for @${followUp.username}`);
        markProcessing(followUp.id);

        try {
          let result = null;
          let replyText = null;

          if (followUp.queryType && followUp.queryValue) {
            switch (followUp.queryType) {
              case 'address': result = await investigateAddress(followUp.queryValue); break;
              case 'tx':      result = await investigateTx(followUp.queryValue);      break;
              case 'stake':   result = await investigateStake(followUp.queryValue);   break;
            }

            if (result) {
              replyText = await respondToQuery(
                `[FOLLOW-UP] @${followUp.username} asked: ${followUp.originalText}\n\nYou previously said you'd look into it. Now deliver the actual findings.`,
                result
              );
            }
          }

          if (!replyText) {
            replyText = await casualReply(
              `[FOLLOW-UP] @${followUp.username} asked: ${followUp.originalText}\n\n` +
              `You promised "${followUp.promiseText}" but couldn't find specific on-chain data. ` +
              `Give a helpful follow-up — acknowledge you checked, share what you found (or didn't), ` +
              `and offer to help if they share a specific address/tx/stakekey.`
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

        await sleep(30_000);
      }

      cleanupFollowUps();
    } catch (e) {
      console.error(`Follow-up loop error: ${e.message}`);
      analyst.recordError('followup', e);
    }

    if (TEST_MODE) break;
    await sleep(FOLLOWUP_POLL_MS);
  }
}

// ─── Messenger Loop ─────────────────────────────────────────

async function messengerLoop() {
  await sleep(30_000);
  console.log('📧 Messenger service started');

  while (true) {
    try {
      const processed = await messenger.processMessages();
      if (processed > 0) {
        console.log('📨 Processed ' + processed + ' message(s)');
      }
      stats.consecutiveErrors = 0;
      await messenger.hourlyReport(stats);
    } catch (e) {
      stats.consecutiveErrors++;
      console.error('Messenger loop error: ' + e.message);
      analyst.recordError('messenger', e);

      if (stats.consecutiveErrors >= 10) {
        await messenger.escalate(
          'Messenger loop: ' + stats.consecutiveErrors + ' consecutive errors',
          'warning',
          'Last error: ' + e.message
        );
        stats.consecutiveErrors = 0;
      }
    }

    if (TEST_MODE) break;
    await sleep(MESSENGER_POLL_MS);
  }
}

// ─── Analyst Loop ──────────────────────────────────────────

async function analystLoop() {
  await sleep(60_000);
  console.log('📊 Analyst started — monitoring error patterns');

  while (true) {
    try {
      await analyst.analyze();
    } catch (e) {
      console.error('Analyst loop error: ' + e.message);
    }

    if (TEST_MODE) break;
    await sleep(ANALYST_POLL_MS);
  }
}

// ─── Utilities ──────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Startup ────────────────────────────────────────────────

async function main() {
  let xReady = false;
  try {
    await browser.launch();
    xReady = await browser.isLoggedIn();
  } catch (e) {
    console.error(`Browser init failed: ${e.message}`);
  }

  console.log(`
╔══════════════════════════════════════════════╗
║         CARDANO WATCHERS  👁️              ║
║         We're watching.                      ║
╠══════════════════════════════════════════════╣
║  Mode:     ${DRY_RUN ? 'DRY RUN' : TEST_MODE ? 'TEST   ' : 'LIVE   '}                         ║
║  X:        ${xReady ? '✓ Logged in (browser)' : '✗ Not logged in'}           ║
║  Brain:    xAI Grok (direct)                 ║
║  Chain:    Cardano mainnet (5M+ threshold)   ║
║  Follow-ups: ${String(getPendingFollowUps().length).padEnd(3)} pending                    ║
║  Messenger: ${messenger.isConfigured() ? '✓ Gmail SMTP' : '✗ No credentials'}                  ║
║  Analyst:  ✓ Pattern detection + X safety    ║
╚══════════════════════════════════════════════╝
`);

  if (!xReady && !DRY_RUN && !TEST_MODE) {
    console.log('⚠️  Not logged into X. Run: node src/login.js');
    console.log('   Once logged in, cookies persist across restarts.\n');
  }

  loadStats();

  if (TEST_MODE) {
    console.log('Running single test pass...\n');
    await chainWatchLoop();
    console.log('\n--- Test complete ---');
    await browser.close();
    process.exit(0);
  }

  const shutdown = async (signal) => {
    console.log('\nShutting down... (' + (signal || 'unknown') + ')');
    saveStats();
    await messenger.shutdown(signal || 'Manual shutdown');
    await browser.close();
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Run all loops concurrently
  Promise.all([
    chainWatchLoop(),
    mentionWatchLoop(),
    repoWatchLoop(),
    engagementLoop(),
    dailyDigestLoop(),
    followUpLoop(),
    messengerLoop(),
    analystLoop(),
    thoughtsLoop(),
    helpReminderLoop(),
  ]).catch(async e => {
    console.error('Fatal error:', e);
    await messenger.escalate('Fatal crash: ' + e.message, 'critical', e.stack);
    saveStats();
    await browser.close();
    process.exit(1);
  });
}

main();
