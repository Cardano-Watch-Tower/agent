/**
 * POSTER — X (Twitter) integration for CardanoWatchTower
 *
 * Handles:
 *   - Posting tweets (alerts, investigation results, daily summaries)
 *   - Posting tweet threads (long investigation reports)
 *   - Reading mentions (user queries and detective requests)
 *   - Replying to mentions
 *
 * Uses OAuth 1.0a for user-context authentication.
 * X API v2 endpoints.
 */
require('dotenv').config();
const crypto = require('crypto');

const config = {
  apiKey: process.env.X_API_KEY,
  apiSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET
};

const API_BASE = 'https://api.x.com/2';

// === OAuth 1.0a Signature ===

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function generateSignature(method, url, params, consumerSecret, tokenSecret) {
  const sortedParams = Object.keys(params).sort().map(k =>
    `${percentEncode(k)}=${percentEncode(params[k])}`
  ).join('&');

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sortedParams)
  ].join('&');

  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function buildAuthHeader(method, fullUrl, extraParams = {}) {
  // Split URL and query params — OAuth requires query params in signature
  const [baseUrl, queryString] = fullUrl.split('?');
  const queryParams = {};
  if (queryString) {
    for (const pair of queryString.split('&')) {
      const [k, v] = pair.split('=');
      queryParams[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }

  const oauthParams = {
    oauth_consumer_key: config.apiKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.accessToken,
    oauth_version: '1.0'
  };

  const allParams = { ...oauthParams, ...queryParams, ...extraParams };
  const signature = generateSignature(method, baseUrl, allParams, config.apiSecret, config.accessTokenSecret);
  oauthParams.oauth_signature = signature;

  const header = 'OAuth ' + Object.keys(oauthParams).sort().map(k =>
    `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`
  ).join(', ');

  return header;
}

// === API Methods ===

/**
 * Post a single tweet.
 * Returns the tweet ID on success.
 */
async function postTweet(text, replyToId = null) {
  const url = `${API_BASE}/tweets`;
  const body = { text };
  if (replyToId) {
    body.reply = { in_reply_to_tweet_id: replyToId };
  }

  const authHeader = buildAuthHeader('POST', url);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`X API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.data.id;
}

/**
 * Post a thread (array of tweet texts).
 * Each tweet replies to the previous one.
 * Returns array of tweet IDs.
 */
async function postThread(tweets) {
  const ids = [];
  let previousId = null;

  for (const text of tweets) {
    const id = await postTweet(text, previousId);
    ids.push(id);
    previousId = id;
    // Small delay between tweets to avoid rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  return ids;
}

/**
 * Get recent mentions of @CardanoWatchTower.
 * Returns array of { id, text, authorId, createdAt }.
 */
async function getMentions(sinceId = null) {
  // Need the bot's user ID first
  const meUrl = `${API_BASE}/users/me`;
  const meAuth = buildAuthHeader('GET', meUrl);

  const meResponse = await fetch(meUrl, {
    headers: { 'Authorization': meAuth }
  });

  if (!meResponse.ok) {
    throw new Error(`Failed to get user ID: ${meResponse.status}`);
  }

  const meData = await meResponse.json();
  const userId = meData.data.id;

  // Get mentions
  let mentionsUrl = `${API_BASE}/users/${userId}/mentions?tweet.fields=created_at,author_id&max_results=10`;
  if (sinceId) mentionsUrl += `&since_id=${sinceId}`;

  const mentionsAuth = buildAuthHeader('GET', mentionsUrl);

  const response = await fetch(mentionsUrl, {
    headers: { 'Authorization': mentionsAuth }
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Mentions error ${response.status}: ${err}`);
  }

  const data = await response.json();
  if (!data.data) return [];

  return data.data.map(t => ({
    id: t.id,
    text: t.text,
    authorId: t.author_id,
    createdAt: t.created_at
  }));
}

/**
 * Reply to a tweet.
 */
async function reply(tweetId, text) {
  return postTweet(text, tweetId);
}

/**
 * Split long text into tweet-sized chunks for threading.
 * Tries to break at sentence boundaries.
 */
function splitForThread(text, maxLen = 275) {
  if (text.length <= maxLen) return [text];

  const tweets = [];
  let remaining = text;
  let index = 1;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      tweets.push(remaining);
      break;
    }

    // Try to break at a period or newline
    let breakPoint = maxLen;
    const periodIdx = remaining.lastIndexOf('. ', maxLen);
    const newlineIdx = remaining.lastIndexOf('\n', maxLen);

    if (periodIdx > maxLen * 0.5) breakPoint = periodIdx + 1;
    else if (newlineIdx > maxLen * 0.5) breakPoint = newlineIdx;

    const chunk = remaining.substring(0, breakPoint).trim();
    tweets.push(chunk);
    remaining = remaining.substring(breakPoint).trim();
    index++;
  }

  // Add thread numbering if > 2 tweets
  if (tweets.length > 2) {
    return tweets.map((t, i) => `${i + 1}/${tweets.length} ${t}`);
  }

  return tweets;
}

/**
 * Check if X API credentials are configured.
 */
function isConfigured() {
  return !!(config.apiKey && config.apiSecret && config.accessToken && config.accessTokenSecret);
}

module.exports = {
  postTweet,
  postThread,
  getMentions,
  reply,
  splitForThread,
  isConfigured
};
