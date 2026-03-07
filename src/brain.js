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
- Include tx hash (shortened) for verification when relevant
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
- Never promise results you can't deliver`;

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
  const prompt = `Write a tweet for CardanoWatchTower about this chain event. Under 280 characters. Be direct, slightly ominous, data-driven. Include shortened tx hash.

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
  const prompt = `Generate a daily summary tweet for CardanoWatchTower. Here are today's stats:

${JSON.stringify(stats, null, 2)}

Write a single tweet (under 280 chars). Highlight the most interesting stat. End with something watchful.`;

  return await chat([{ role: 'user', content: prompt }], { temperature: 0.8 });
}

module.exports = { chat, shouldTweet, composeTweet, respondToQuery, assessJob, dailySummary };
