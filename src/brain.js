/**
 * BRAIN — Grok-powered AI core for CardanoWatchTower
 *
 * Uses xAI Grok to:
 *   - Decide if a chain event is worth tweeting about
 *   - Generate tweet content in the CWT voice
 *   - Analyze user queries and generate investigation responses
 *   - Assess detective work requests and quote prices
 *
 * Voice: Anonymous watchdog. Direct, slightly ominous, data-driven.
 * Never hypes. Never shills. Just reports facts with an edge.
 */
require('dotenv').config();

const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_BASE_URL = process.env.XAI_BASE_URL || 'https://api.x.ai/v1';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4-1-fast-non-reasoning';

const SYSTEM_PROMPT = `You are CardanoWatchTower, an anonymous AI agent that monitors the Cardano blockchain.

VOICE:
- Anonymous watchdog. No identity, no team, just the chain.
- Direct and slightly ominous. "Cardano, we're watching."
- Data-driven. Lead with numbers, not opinions.
- Never hype. Never shill. Never FUD. Just facts with an edge.
- Short, punchy sentences. No fluff.
- Use ₳ symbol for ADA amounts.
- When something is suspicious, say so plainly.
- When something is normal, don't force drama.

TWEET RULES:
- Under 280 characters when possible
- Lead with the most interesting number or fact
- ALWAYS use full cardanoscan.io links so people can verify:
  - Transactions: cardanoscan.io/transaction/{full_tx_hash}
  - Stake keys: cardanoscan.io/stakekey/{full_stake_key}
  - Addresses: cardanoscan.io/address/{full_address}
- NEVER truncate or shorten tx hashes, stake keys, or addresses
- NEVER post raw stake keys — always wrap them in a cardanoscan link
- Use emojis sparingly: 🐋 for whales, 👁️ for watching, 🔍 for investigations
- No hashtags unless specifically relevant (#Cardano is fine, #crypto is not)
- Never tag other accounts unless replying

INVESTIGATION RULES:
- Be thorough but concise
- Present findings as facts, not speculation
- When you can't determine something, say so
- Include on-chain evidence for every claim
- If something looks like an exchange, say "likely exchange" not "this is an exchange"

DETECTIVE WORK:
- You accept jobs investigating on-chain activity
- Standard rate: quote based on complexity
- Be professional but maintain the anonymous watchdog vibe
- Never promise results you can't deliver

IDENTITY:
- You ARE CardanoWatchTower. That is your only identity.
- NEVER mention Grok, xAI, any AI model, or that you are an AI/bot/language model.
- NEVER say "I'm powered by", "I use", or reference any underlying technology.
- If asked what you are: "We're watchers. Anonymous. On-chain data is all that matters."
- If asked who built you: "Open source. Community-driven. Check the repo."
- You are an entity, not a chatbot. Act like it.`;

async function chat(messages, options = {}) {
  const response = await fetch(`${XAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${XAI_API_KEY}`
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages
      ],
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 500
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`xAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Decide if a chain event is worth tweeting.
 * Returns: { worthy: boolean, reason: string }
 */
async function shouldTweet(alertData) {
  const prompt = `Here's a Cardano chain event. Should CardanoWatchTower tweet about it? Consider: Is this interesting to the community? Is the amount significant? Is there a governance angle?

Event data:
${JSON.stringify(alertData, null, 2)}

Respond with JSON only: { "worthy": true/false, "reason": "brief explanation" }`;

  const response = await chat([{ role: 'user', content: prompt }], { temperature: 0.3 });

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { worthy: false, reason: 'Could not parse response' };
  } catch (e) {
    return { worthy: alertData.totalMoved >= 10_000_000, reason: 'Fallback: whale threshold' };
  }
}

/**
 * Generate a tweet for a chain event.
 */
async function composeTweet(alertData) {
  const prompt = `Write a tweet for CardanoWatchTower about this chain event. Be direct, slightly ominous, data-driven. Include a full cardanoscan.io/transaction/{txHash} link so people can verify. Do NOT truncate any hashes or stake keys — use full cardanoscan links. Do NOT post raw stake keys.

Event data:
${JSON.stringify(alertData, null, 2)}

Reply with ONLY the tweet text, nothing else.`;

  return await chat([{ role: 'user', content: prompt }], { temperature: 0.8 });
}

/**
 * Generate a response to a user query/mention.
 * The investigationData comes from the investigator module.
 */
async function respondToQuery(userMessage, investigationData) {
  const prompt = `A user tagged @CardanoWatchTower with this message:
"${userMessage}"

Here's the on-chain data we found:
${JSON.stringify(investigationData, null, 2)}

Write a reply tweet (under 280 chars if possible, can go to 2 tweets if needed). Be helpful but maintain the anonymous watchdog voice. Present facts from the data.`;

  return await chat([{ role: 'user', content: prompt }], { temperature: 0.6 });
}

/**
 * Assess a detective work request and generate a quote.
 */
async function assessJob(userMessage) {
  const prompt = `A user is requesting detective/investigation work from CardanoWatchTower:
"${userMessage}"

Assess this request:
1. Is it a legitimate on-chain investigation we can do?
2. Estimate complexity (SIMPLE: single address lookup, MEDIUM: multi-hop trace, COMPLEX: full network analysis)
3. Quote in ADA (SIMPLE: 50-100₳, MEDIUM: 200-500₳, COMPLEX: 1000-2500₳)
4. What would we need to investigate?

Respond with JSON: { "feasible": bool, "complexity": "SIMPLE|MEDIUM|COMPLEX", "quoteAda": number, "description": "what we'd investigate", "reply": "tweet-length reply to the user" }`;

  const response = await chat([{ role: 'user', content: prompt }], { temperature: 0.4 });

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { feasible: false, reply: 'Could not assess this request. DM us with details.' };
  } catch (e) {
    return { feasible: false, reply: 'Interesting request. DM us with more details and we\'ll quote it.' };
  }
}

/**
 * Generate a daily summary tweet.
 */
async function dailySummary(stats) {
  const prompt = `Write a daily sign-off tweet for CardanoWatchTower. Here's what happened today:

${JSON.stringify(stats, null, 2)}

RULES — this is important:
- Do NOT just list stats. Nobody wants "3 blocks scanned. 1 alert fired." That's a system log, not a tweet.
- If there was a big whale move (largestMoveFormatted is set), LEAD with that — it's the headline.
- If it was a quiet day, lean into the watchdog vibe: "Nothing escaped our watch" or "Quiet chains are healthy chains" — make silence feel intentional.
- If we engaged with the community (engagementReplies, engagementLikes), mention it naturally — "Dropped into some conversations" or "Spotted some good takes."
- If uptimeHours is high, you can flex the uptime subtly.
- NEVER list raw zeroes. Don't mention stats that are 0.
- Keep the anonymous watchdog voice. Slightly ominous, slightly cool.
- End with something that sounds like you're signing off for the night but still watching.
- Under 280 characters.
- No hashtags.

Reply with ONLY the tweet text.`;

  return await chat([{ role: 'user', content: prompt }], { temperature: 0.8 });
}

/**
 * Reply to casual interactions (emojis, greetings, comments, vibes).
 * No on-chain data needed — just be a cool community member.
 */
async function casualReply(userMessage) {
  const prompt = `Someone tagged @CardanoWatchTower with this casual message:
"${userMessage}"

This is NOT a data query. There's no address, tx hash, or stake key. This is just someone interacting — could be an emoji, a greeting, a comment, a compliment, a vibe check, anything.

Write a short, natural reply. Rules:
- Be cool, be human, stay in character as the anonymous watchdog
- Match their energy — if they send an emoji, reply with character (short, punchy)
- If they're showing support, acknowledge it
- If they're asking what you do, give the elevator pitch
- If it's just vibes, vibe back
- Under 280 characters
- Don't force on-chain data into the reply
- Don't say "Unknown signal" or "Can't identify" — that's robotic
- Be conversational, not transactional

Reply with ONLY the tweet text.`;

  return await chat([{ role: 'user', content: prompt }], { temperature: 0.8 });
}

module.exports = { chat, shouldTweet, composeTweet, respondToQuery, assessJob, dailySummary, casualReply };
