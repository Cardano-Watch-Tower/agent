/**
 * ENGAGER — Proactive community engagement for CardanoWatchTower
 *
 * Three behaviors:
 *   1. Search & Reply  — finds Cardano conversations, drops knowledge
 *   2. Like & Amplify  — likes relevant tweets, builds presence
 *   3. Follow Back     — follows anyone who follows us
 *
 * Rate-limited and filtered to avoid spam behavior.
 * Uses Grok brain for reply generation (same CWT voice).
 */
const { searchTweets, likeTweet, followUser, getFollowers, getFollowing, BOT_USER_ID } = require('./poster');
const { chat } = require('./brain');
const { investigate } = require('./investigator');
const { parseQuery } = require('./investigator');

// Track what we've already engaged with (in-memory, resets on restart)
const engaged = {
  replied: new Set(),      // tweet IDs we've replied to
  liked: new Set(),        // tweet IDs we've liked
  followed: new Set()      // user IDs we've followed
};

// Search queries to rotate through
const SEARCH_QUERIES = [
  '$ADA -is:retweet -is:reply',
  'Cardano whale -is:retweet -is:reply',
  'Cardano governance -is:retweet -is:reply',
  '#Cardano transaction -is:retweet -is:reply',
  'ADA staking -is:retweet -is:reply',
  'Cardano DRep -is:retweet -is:reply',
  'Cardano on-chain -is:retweet -is:reply',
  'Cardano suspicious -is:retweet -is:reply',
  'Cardano wallet -is:retweet -is:reply'
];

let searchIndex = 0;

/**
 * Main engagement cycle. Call this periodically.
 * Returns { searched, liked, replied, followed } counts.
 */
async function engage() {
  const results = { searched: 0, liked: 0, replied: 0, followed: 0 };

  try {
    // 1. Search & engage with Cardano tweets
    await searchAndEngage(results);

    // 2. Follow back
    await followBack(results);
  } catch (e) {
    console.error(`Engagement error: ${e.message}`);
  }

  return results;
}

/**
 * Search for Cardano tweets and engage with the best ones.
 */
async function searchAndEngage(results) {
  // Rotate through search queries
  const query = SEARCH_QUERIES[searchIndex % SEARCH_QUERIES.length];
  searchIndex++;

  console.log(`🔍 Searching: ${query}`);
  const tweets = await searchTweets(query, 10);
  results.searched = tweets.length;

  for (const tweet of tweets) {
    // Skip our own tweets
    if (tweet.authorId === BOT_USER_ID) continue;

    // Skip if we already engaged
    if (engaged.liked.has(tweet.id) || engaged.replied.has(tweet.id)) continue;

    // Skip very low engagement tweets (likely bots/spam)
    const likes = tweet.metrics?.like_count || 0;
    const retweets = tweet.metrics?.retweet_count || 0;
    const replies = tweet.metrics?.reply_count || 0;

    // Decide: like, reply, or skip
    const action = await decideAction(tweet);

    if (action === 'reply') {
      await handleReply(tweet, results);
    } else if (action === 'like') {
      await handleLike(tweet, results);
    }
    // else: skip

    // Don't hammer the API
    await sleep(2000);
  }
}

/**
 * Ask the brain what to do with this tweet.
 * Returns: 'reply', 'like', or 'skip'
 */
async function decideAction(tweet) {
  const prompt = `You're CardanoWatchTower monitoring Cardano community conversations. Here's a tweet:

"${tweet.text}"

Engagement: ${tweet.metrics?.like_count || 0} likes, ${tweet.metrics?.retweet_count || 0} RTs, ${tweet.metrics?.reply_count || 0} replies

Should CardanoWatchTower engage? Consider:
- Does this tweet discuss something we could add value to? (whale moves, governance, staking, suspicious activity, on-chain data)
- Is the author asking a question we could answer with on-chain data?
- Is this a conversation where our watchdog perspective adds something?
- Would engaging look natural and helpful, NOT spammy?

Rules:
- REPLY only if we genuinely have something useful to add (data, insight, or a relevant observation)
- LIKE if it's good Cardano content but we don't need to reply
- SKIP if it's generic, hype, shilling, or we'd add nothing

Respond with ONLY one word: REPLY, LIKE, or SKIP`;

  try {
    const response = await chat([{ role: 'user', content: prompt }], { temperature: 0.3, maxTokens: 10 });
    const decision = response.trim().toUpperCase();
    if (['REPLY', 'LIKE', 'SKIP'].includes(decision)) return decision.toLowerCase();
    return 'skip';
  } catch (e) {
    return 'skip';
  }
}

/**
 * Generate and post a reply to a tweet.
 */
async function handleReply(tweet, results) {
  try {
    // Check if there's an address or tx hash in the tweet we could look up
    let onChainData = null;
    const parsed = parseQuery(tweet.text);
    if (parsed) {
      try {
        onChainData = await investigate(parsed.value);
      } catch (e) {
        // No data, that's fine — reply without it
      }
    }

    const prompt = `A Cardano community member tweeted:
"${tweet.text}"

${onChainData ? `On-chain data we found:\n${JSON.stringify(onChainData, null, 2)}\n` : ''}
Write a reply from CardanoWatchTower. Rules:
- Be helpful, not pushy. Add genuine value.
- If we have on-chain data, share the key finding.
- If no data, share a relevant observation or offer to help ("Tag us with an address — we'll trace it 👁️")
- Maintain the anonymous watchdog voice. Direct, slightly ominous, data-first.
- Under 280 characters.
- Do NOT use hashtags.
- Do NOT tag anyone.
- Be conversational — this is community engagement, not a broadcast.

Reply with ONLY the tweet text.`;

    const replyText = await chat([{ role: 'user', content: prompt }], { temperature: 0.7 });

    // Post the reply
    const { postTweet } = require('./poster');
    const tweetId = await postTweet(replyText, tweet.id);
    engaged.replied.add(tweet.id);
    results.replied++;
    console.log(`  💬 Replied to ${tweet.id}: ${replyText.substring(0, 80)}...`);

    // Also like the tweet we replied to
    try {
      await likeTweet(tweet.id);
      engaged.liked.add(tweet.id);
      results.liked++;
    } catch (e) {
      // Like failed, no big deal
    }
  } catch (e) {
    console.error(`  Reply failed: ${e.message}`);
  }
}

/**
 * Like a tweet.
 */
async function handleLike(tweet, results) {
  try {
    await likeTweet(tweet.id);
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
  try {
    const followers = await getFollowers(50);
    const following = await getFollowing(100);
    const followingSet = new Set(following);

    for (const follower of followers) {
      if (followingSet.has(follower.id) || engaged.followed.has(follower.id)) continue;
      if (follower.id === BOT_USER_ID) continue;

      try {
        await followUser(follower.id);
        engaged.followed.add(follower.id);
        results.followed++;
        console.log(`  👤 Followed back: @${follower.username}`);
        await sleep(1000);
      } catch (e) {
        // Skip on error
      }
    }
  } catch (e) {
    console.error(`  Follow-back error: ${e.message}`);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { engage, SEARCH_QUERIES };
