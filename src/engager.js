/**
 * ENGAGER — Proactive community engagement for CardanoWatchTower
 *
 * Browser-based. No API calls for search/like/follow.
 *
 * Three behaviors:
 *   1. Search & Reply  — finds Cardano conversations, drops knowledge
 *   2. Like & Amplify  — likes relevant tweets, builds presence
 *   3. Follow Back     — follows anyone who follows us
 *
 * COST OPTIMIZATION:
 *   - Old: called Grok for EVERY tweet to decide action (~96 calls/day)
 *   - New: keyword filter first, only call Grok for tweets that pass
 *   - Cuts Grok usage by ~80%
 */
const { searchTweets, likeTweet, followUser, getFollowers, BOT_USERNAME } = require('./poster');
const { chat } = require('./brain');
const { parseQuery, investigate } = require('./investigator');

// Track what we've already engaged with (in-memory, resets on restart)
const engaged = {
  replied: new Set(),
  liked: new Set(),
  followed: new Set()
};

// Daily follow cap — protects account from looking botty
const DAILY_FOLLOW_CAP = 20;
let dailyFollowCount = 0;
let dailyFollowReset = Date.now() + 24 * 60 * 60 * 1000;

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
  'Cardano transaction'
];

// Keywords that indicate a tweet is worth engaging with
const ENGAGEMENT_KEYWORDS = [
  'whale', 'moved', 'transfer', 'staking', 'delegation', 'drep',
  'governance', 'treasury', 'suspicious', 'rug', 'scam', 'alert',
  'on-chain', 'wallet', 'stakekey', 'transaction', 'tx',
  'ada', '₳', 'million', 'billion', 'withdrawal', 'deposit'
];

let searchIndex = 0;

/**
 * Main engagement cycle. Call this periodically.
 * Returns { searched, liked, replied, followed } counts.
 */
async function engage() {
  const results = { searched: 0, liked: 0, replied: 0, followed: 0 };

  try {
    await searchAndEngage(results);
    await followBack(results);
  } catch (e) {
    console.error(`Engagement error: ${e.message}`);
  }

  return results;
}

/**
 * Search for Cardano tweets and engage with the best ones.
 * Uses keyword filter FIRST to avoid burning Grok calls on junk.
 */
async function searchAndEngage(results) {
  const query = SEARCH_QUERIES[searchIndex % SEARCH_QUERIES.length];
  searchIndex++;

  console.log(`🔍 Searching: ${query}`);
  const tweets = await searchTweets(query, 10);
  results.searched = tweets.length;

  // Keyword filter — only send to Grok if the tweet has substance
  const filtered = tweets.filter(tweet => {
    if (tweet.authorUsername === BOT_USERNAME) return false;
    if (engaged.liked.has(tweet.id) || engaged.replied.has(tweet.id)) return false;

    const lower = tweet.text.toLowerCase();
    return ENGAGEMENT_KEYWORDS.some(kw => lower.includes(kw));
  });

  // Only call Grok for filtered tweets (saves ~80% of API calls)
  for (const tweet of filtered.slice(0, 3)) { // max 3 Grok calls per cycle
    const action = await decideAction(tweet);

    if (action === 'reply') {
      await handleReply(tweet, results);
    } else if (action === 'like') {
      await handleLike(tweet, results);
    }

    await sleep(3000); // slower pace for browser
  }

  // Like a few more (cap at 3 to keep Chrome available for mentions)
  let extraLikes = 0;
  for (const tweet of filtered.slice(3)) {
    if (extraLikes >= 3) break;
    if (!engaged.liked.has(tweet.id)) {
      await handleLike(tweet, results);
      extraLikes++;
      await sleep(3000);
    }
  }
}

/**
 * Ask the brain what to do with this tweet.
 * Returns: 'reply', 'like', or 'skip'
 */
async function decideAction(tweet) {
  const prompt = `You're CardanoWatchTower. Here's a tweet:

"${tweet.text}"

Should we engage? Consider:
- Does this discuss something we could add value to about the CARDANO BLOCKCHAIN?
- Is the author asking a question we could answer with CARDANO on-chain data?
- Would engaging look natural and helpful, NOT spammy?
- If the tweet is about a non-Cardano chain (Solana, Ethereum, BSC, etc.) or a memecoin/token that just happens to be named "Cardano" but is NOT on the Cardano blockchain, SKIP it.
- If addresses in the tweet don't start with addr1, stake1, drep1, pool1, Ae2, or Ddz — they are NOT Cardano addresses. SKIP.

Respond with ONLY one word: REPLY, LIKE, or SKIP`;

  try {
    const response = await chat([{ role: 'user', content: prompt }], { temperature: 0.3, maxTokens: 10 });
    const decision = response.trim().toUpperCase();
    if (['REPLY', 'LIKE', 'SKIP'].includes(decision)) return decision.toLowerCase();
    return 'skip';
  } catch (e) {
    return 'like'; // default to like on error (cheaper than retry)
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
          // Format cleanly, don't dump JSON
          if (data.type === 'ADDRESS_REPORT') {
            onChainContext = `On-chain: ${data.balance} ₳ balance, ${data.txCount} txs`;
          } else if (data.type === 'TX_REPORT') {
            onChainContext = `On-chain: ${data.totalMoved} ₳ moved, ${data.inputCount} in → ${data.outputCount} out`;
          } else if (data.type === 'STAKE_REPORT') {
            onChainContext = `On-chain: ${data.controlledAda} ₳ controlled, ${data.addressCount} addresses`;
          }
        }
      } catch (e) { /* no data, fine */ }
    }

    const prompt = `A Cardano community member tweeted:
"${tweet.text}"

${onChainContext ? `${onChainContext}\n` : ''}Write a reply from CardanoWatchTower. Rules:
- Be helpful and conversational. Add genuine value.
- If we have on-chain data, share the key finding naturally.
- If no data, share a relevant observation or offer to help.
- NEVER fabricate on-chain data, tx counts, or analysis you don't have.
- Valid Cardano addresses start with addr1, stake1, Ae2, Ddz, drep1, or pool1. Anything else is NOT Cardano.
- If the tweet discusses a non-Cardano token/address (Solana, Ethereum, etc.), acknowledge it's not your chain. Don't pretend to analyze it.
- NEVER include cardanoscan.io links unless we provided real on-chain data above.
- Be a community member first, watchdog second.
- Under 280 characters.
- NO hashtags. Zero.

Reply with ONLY the tweet text.`;

    const replyText = await chat([{ role: 'user', content: prompt }], { temperature: 0.7 });

    const { reply } = require('./poster');
    await reply(tweet.id || tweet.url, replyText);
    engaged.replied.add(tweet.id);
    results.replied++;
    console.log(`  💬 Replied: ${replyText.substring(0, 80)}...`);

    // Also like the tweet we replied to
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
 * Follow back anyone who follows us.
 */
async function followBack(results) {
  const MAX_FOLLOWS_PER_CYCLE = 3;

  // Reset daily counter every 24h
  if (Date.now() >= dailyFollowReset) {
    dailyFollowCount = 0;
    dailyFollowReset = Date.now() + 24 * 60 * 60 * 1000;
  }

  // Daily cap reached — skip entirely
  if (dailyFollowCount >= DAILY_FOLLOW_CAP) {
    return;
  }

  try {
    const followers = await getFollowers(20);
    let followed = 0;

    for (const follower of followers) {
      if (followed >= MAX_FOLLOWS_PER_CYCLE || dailyFollowCount >= DAILY_FOLLOW_CAP) {
        if (dailyFollowCount >= DAILY_FOLLOW_CAP) {
          console.log('  ⏸️ Daily follow cap reached (' + DAILY_FOLLOW_CAP + ')');
        }
        break;
      }
      if (engaged.followed.has(follower.username)) continue;
      if (follower.username === BOT_USERNAME) continue;

      try {
        await followUser(follower.username);
        engaged.followed.add(follower.username);
        results.followed++;
        followed++;
        dailyFollowCount++;
        console.log('  👤 Followed back: @' + follower.username + ' (' + dailyFollowCount + '/' + DAILY_FOLLOW_CAP + ' today)');
        await sleep(5000); // Longer gap — gives mention loop a chance to grab the lock
      } catch (e) { /* skip */ }
    }
  } catch (e) {
    console.error(`  Follow-back error: ${e.message}`);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { engage, SEARCH_QUERIES };
