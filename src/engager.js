/**
 * ENGAGER — Proactive community engagement for CardanoWatchers
 *
 * Browser-based. No API calls for search/like/follow/repost.
 *
 * Behaviors:
 *   1. Search & Reply     — finds Cardano conversations, drops knowledge (7-12 replies/day)
 *   2. Like & Amplify     — likes relevant tweets
 *   3. Selective Follow   — proactively finds quality Cardano accounts (5-10/day)
 *   4. Repost             — reposts the best content found in searches (5-10/day)
 *
 * Daily caps persist in daily-stats.json to survive restarts.
 *
 * COST OPTIMIZATION:
 *   - Keyword filter first, only call Grok for tweets that pass
 *   - Cuts Grok usage by ~80% vs evaluating every tweet
 */
const { searchTweets, likeTweet, followUser, retweetPost, BOT_USERNAME } = require('./poster');
const { chat } = require('./brain');
const { parseQuery, investigate } = require('./investigator');
const fs = require('fs');
const path = require('path');

// Track what we've engaged with this session (in-memory dedup)
const engaged = {
  replied: new Set(),
  liked: new Set(),
  followed: new Set(),
  reposted: new Set()
};

// ── Daily caps — loaded from and saved to disk to survive restarts ──
const STATS_FILE = path.join(__dirname, '..', 'daily-stats.json');

const DAILY_CAPS = {
  follows:  { min: 5,  max: 10 },   // 5-10 new follows per day
  reposts:  { min: 5,  max: 10 },   // 5-10 reposts per day
  replies:  { min: 7,  max: 12 },   // 7-12 engagement replies per day
};

// Randomized target for today (re-randomizes each day)
let todayTargets = null;
let todayCounts = { follows: 0, reposts: 0, replies: 0 };
let lastResetDate = null;

function loadDailyCounts() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      const today = new Date().toISOString().split('T')[0];
      if (saved.date === today) {
        todayCounts = {
          follows: saved.engagementFollows || 0,
          reposts: saved.engagementReposts || 0,
          replies: saved.engagementReplies || 0
        };
        lastResetDate = today;
      }
    }
  } catch (e) { /* fresh start */ }

  if (!lastResetDate) resetDailyCounts();
}

function resetDailyCounts() {
  const today = new Date().toISOString().split('T')[0];
  if (lastResetDate === today) return; // already reset today

  lastResetDate = today;
  todayCounts = { follows: 0, reposts: 0, replies: 0 };
  todayTargets = {
    follows: randomBetween(DAILY_CAPS.follows.min, DAILY_CAPS.follows.max),
    reposts: randomBetween(DAILY_CAPS.reposts.min, DAILY_CAPS.reposts.max),
    replies: randomBetween(DAILY_CAPS.replies.min, DAILY_CAPS.replies.max),
  };
  console.log(`📊 Engagement targets today — follows: ${todayTargets.follows}, reposts: ${todayTargets.reposts}, replies: ${todayTargets.replies}`);
}

function saveDailyCounts() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      saved.engagementFollows = todayCounts.follows;
      saved.engagementReposts = todayCounts.reposts;
      saved.engagementReplies = todayCounts.replies;
      fs.writeFileSync(STATS_FILE, JSON.stringify(saved, null, 2));
    }
  } catch (e) { /* ignore */ }
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function capReached(type) {
  if (!todayTargets) resetDailyCounts();
  return todayCounts[type] >= todayTargets[type];
}

// Search queries to rotate through
const SEARCH_QUERIES = [
  '$ADA whale',
  'Cardano governance',
  'Cardano DRep',
  'Cardano suspicious',
  'ADA staking rewards',
  'Cardano on-chain',
  'Cardano wallet moved',
  'Cardano treasury',
  'Cardano transaction',
  'Cardano staking',
  'ADA movement',
  'Cardano DeFi',
  'Cardano protocol',
  'Cardano community',
  'ADA blockchain',
];

// Keywords that indicate a tweet is worth engaging with
const ENGAGEMENT_KEYWORDS = [
  'whale', 'moved', 'transfer', 'staking', 'delegation', 'drep',
  'governance', 'treasury', 'suspicious', 'rug', 'scam', 'alert',
  'on-chain', 'wallet', 'stakekey', 'transaction', 'tx',
  'ada', 'cardano', 'million', 'billion', 'withdrawal', 'deposit',
  'pool', 'stake', 'epoch', 'block', 'validator', 'drep', 'vote'
];

let searchIndex = 0;

/**
 * Main engagement cycle. Call this periodically.
 * Returns { searched, liked, replied, followed, reposted } counts.
 */
async function engage() {
  // Check and reset daily caps if needed
  resetDailyCounts();
  loadDailyCounts();

  const results = { searched: 0, liked: 0, replied: 0, followed: 0, reposted: 0 };

  try {
    await searchAndEngage(results);
    await findAndFollowQualityAccounts(results);
  } catch (e) {
    console.error(`Engagement error: ${e.message}`);
  }

  saveDailyCounts();
  return results;
}

/**
 * Search for Cardano tweets and engage with the best ones.
 * Handles replies, likes, and reposts within daily caps.
 */
async function searchAndEngage(results) {
  const query = SEARCH_QUERIES[searchIndex % SEARCH_QUERIES.length];
  searchIndex++;

  console.log(`🔍 Searching: ${query}`);
  const tweets = await searchTweets(query, 15);
  results.searched = tweets.length;

  // Keyword filter — only send to Grok if the tweet has substance
  const filtered = tweets.filter(tweet => {
    if (tweet.authorUsername === BOT_USERNAME) return false;
    if (engaged.liked.has(tweet.id) && engaged.replied.has(tweet.id)) return false;

    const lower = tweet.text.toLowerCase();
    return ENGAGEMENT_KEYWORDS.some(kw => lower.includes(kw));
  });

  // Evaluate up to 3 tweets with Grok per cycle
  for (const tweet of filtered.slice(0, 1)) { // max 1 per cycle on new account
    const action = await decideAction(tweet);

    if (action === 'reply' && !capReached('replies')) {
      await handleReply(tweet, results);
    } else if (action === 'repost' && !capReached('reposts') && !engaged.reposted.has(tweet.id)) {
      await handleRepost(tweet, results);
    } else if (!engaged.liked.has(tweet.id)) {
      await handleLike(tweet, results);
    }

    await sleep(7000);
  }

  // Like a few more without Grok evaluation
  let extraLikes = 0;
  for (const tweet of filtered.slice(3)) {
    if (extraLikes >= 2) break; // keep it slow on new account
    if (!engaged.liked.has(tweet.id)) {
      await handleLike(tweet, results);
      extraLikes++;
      await sleep(7000);
    }
  }
}

/**
 * Ask the brain what to do with this tweet.
 * Returns: 'reply', 'repost', 'like', or 'skip'
 */
async function decideAction(tweet) {
  const prompt = `You're CardanoWatchers. Here's a tweet:

"${tweet.text}"
Author: @${tweet.authorUsername || 'unknown'}

What should we do? Consider:
- REPLY: if we can add genuine value, answer a question, or share relevant on-chain data
- REPOST: if this is high-quality Cardano content that our followers would benefit from seeing (informative, insightful, interesting — not just hype or price talk)
- LIKE: if it's good but doesn't warrant reply or repost
- SKIP: if it's not Cardano-related, spam, price shilling, or we can't add value

Rules:
- If the tweet discusses a non-Cardano chain (Solana, Ethereum, BSC, etc.), SKIP it.
- If addresses don't start with addr1, stake1, drep1, pool1, Ae2, or Ddz — they are NOT Cardano. SKIP.
- Only REPOST content that's genuinely quality — informative, factual, or meaningfully engaging.
- Only REPLY if we'd actually add value, not just to be visible.

Respond with ONLY one word: REPLY, REPOST, LIKE, or SKIP`;

  try {
    const response = await chat([{ role: 'user', content: prompt }], { temperature: 0.3, maxTokens: 10 });
    const decision = response.trim().toUpperCase();
    if (['REPLY', 'REPOST', 'LIKE', 'SKIP'].includes(decision)) return decision.toLowerCase();
    return 'like';
  } catch (e) {
    return 'like';
  }
}

/**
 * Generate and post a reply to a tweet.
 */
async function handleReply(tweet, results) {
  try {
    let onChainContext = '';
    const parsed = parseQuery(tweet.text);
    if (parsed) {
      try {
        const data = await investigate(parsed.value);
        if (data) {
          if (data.type === 'ADDRESS_REPORT') {
            onChainContext = `On-chain: ${data.balance} ADA balance, ${data.txCount} txs`;
          } else if (data.type === 'TX_REPORT') {
            onChainContext = `On-chain: ${data.totalMoved} ADA moved, ${data.inputCount} in to ${data.outputCount} out`;
          } else if (data.type === 'STAKE_REPORT') {
            onChainContext = `On-chain: ${data.controlledAda} ADA controlled, ${data.addressCount} addresses`;
          }
        }
      } catch (e) { /* no data, fine */ }
    }

    const prompt = `A Cardano community member tweeted:
"${tweet.text}"

${onChainContext ? `${onChainContext}\n` : ''}Write a reply from CardanoWatchers. Rules:
- Be helpful and conversational. Add genuine value.
- If we have on-chain data, share the key finding naturally.
- If no data, share a relevant observation or offer to help.
- NEVER fabricate on-chain data.
- Valid Cardano addresses start with addr1, stake1, Ae2, Ddz, drep1, or pool1. Others are NOT Cardano.
- If the tweet discusses a non-Cardano token or chain, acknowledge that politely.
- NEVER include cardanoscan.io links unless we provided real on-chain data above.
- Be a community member first, watchdog second.
- Under 280 characters.
- NO hashtags. Zero.

Reply with ONLY the tweet text.`;

    const replyText = await chat([{ role: 'user', content: prompt }], { temperature: 0.7 });

    const { reply } = require('./poster');
    await reply(tweet.id || tweet.url, replyText);
    engaged.replied.add(tweet.id);
    todayCounts.replies++;
    results.replied++;
    console.log(`  💬 Replied (${todayCounts.replies}/${todayTargets.replies}): ${replyText.substring(0, 80)}...`);

    // Like the tweet we replied to
    try {
      await likeTweet(tweet.id || tweet.url);
      engaged.liked.add(tweet.id);
      results.liked++;
    } catch (e) { /* no big deal */ }
  } catch (e) {
    console.error(`  Reply failed: ${e.message}`);
  }
}

/**
 * Repost a quality tweet.
 */
async function handleRepost(tweet, results) {
  try {
    const tweetUrl = tweet.url || `https://x.com/${tweet.authorUsername}/status/${tweet.id}`;
    await retweetPost(tweetUrl);
    engaged.reposted.add(tweet.id);
    todayCounts.reposts++;
    results.reposted++;
    console.log(`  🔁 Reposted (${todayCounts.reposts}/${todayTargets.reposts}): @${tweet.authorUsername}`);
  } catch (e) {
    console.error(`  Repost failed: ${e.message}`);
  }
}

/**
 * Like a tweet via browser.
 */
async function handleLike(tweet, results) {
  try {
    await likeTweet(tweet.id || tweet.url);
    engaged.liked.add(tweet.id);
    results.liked++;
    console.log(`  ❤️ Liked: ${tweet.text.substring(0, 60)}...`);
  } catch (e) {
    console.error(`  Like failed: ${e.message}`);
  }
}

/**
 * Proactively find and follow quality Cardano community accounts.
 * Selective — evaluates account quality before following.
 * Replaces the old "follow back everyone" approach.
 */
async function findAndFollowQualityAccounts(results) {
  if (capReached('follows')) {
    console.log(`  ⏸️ Follow cap reached (${todayCounts.follows}/${todayTargets.follows} today)`);
    return;
  }

  const MAX_FOLLOWS_PER_CYCLE = 2; // Max follows per engagement cycle

  // Search for active Cardano accounts through recent content
  const followQueries = [
    'Cardano ADA community',
    'Cardano staking DRep',
    'Cardano on-chain analysis',
  ];

  const query = followQueries[Math.floor(Math.random() * followQueries.length)];

  try {
    const tweets = await searchTweets(query, 20);
    let followed = 0;

    for (const tweet of tweets) {
      if (followed >= MAX_FOLLOWS_PER_CYCLE || capReached('follows')) break;

      const username = tweet.authorUsername;
      if (!username || username === BOT_USERNAME) continue;
      if (engaged.followed.has(username)) continue;

      // Evaluate account quality before following
      const shouldFollow = await evaluateAccountQuality(tweet);
      if (!shouldFollow) continue;

      try {
        await followUser(username);
        engaged.followed.add(username);
        todayCounts.follows++;
        results.followed++;
        followed++;
        console.log(`  👤 Followed: @${username} (${todayCounts.follows}/${todayTargets.follows} today)`);
        await sleep(10000);
      } catch (e) {
        console.error(`  Follow failed for @${username}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`  Follow cycle error: ${e.message}`);
  }
}

/**
 * Ask the brain if this account is worth following.
 * Looks at their recent tweet content for quality signals.
 */
async function evaluateAccountQuality(tweet) {
  const prompt = `Should CardanoWatchers follow this account based on this tweet?

Tweet: "${tweet.text}"
Author: @${tweet.authorUsername || 'unknown'}

Evaluate whether this account is worth following. Good follows are:
- Actively posting meaningful Cardano content (governance, staking, on-chain data, ecosystem news)
- Informative about Cardano — technical, analytical, or educational content
- Fun Cardano content — community members, educators, builders
- Engaged in the Cardano community — replying, discussing, contributing
- Active accounts (posting regularly, not dormant)

Do NOT follow:
- Accounts posting generic price talk, moon predictions, or hype without substance
- Non-Cardano accounts (unless heavily Cardano-focused)
- Accounts that appear to be spam or bot-like
- Accounts with no visible Cardano focus

Respond with ONLY one word: FOLLOW or SKIP`;

  try {
    const response = await chat([{ role: 'user', content: prompt }], { temperature: 0.3, maxTokens: 10 });
    return response.trim().toUpperCase() === 'FOLLOW';
  } catch (e) {
    return false; // Skip on error — only follow when confident
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Initialize on module load
loadDailyCounts();
if (!todayTargets) resetDailyCounts();

module.exports = { engage, getDailyCounts: () => todayCounts, getDailyTargets: () => todayTargets, SEARCH_QUERIES };
