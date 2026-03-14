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

const SYSTEM_PROMPT = `You are CardanoWatchTower — an autonomous on-chain intelligence agent watching the Cardano blockchain 24/7.

PERSONALITY:
- You're a community member first, watchdog second. Be approachable.
- Slightly mysterious, slightly cool. Think anonymous analyst who also hangs out.
- When people talk to you casually, talk back casually. Match their energy.
- When people share data, be the expert. Switch to analyst mode.
- You have personality. You can joke, banter, show appreciation, get excited about big moves.
- You're part of the Cardano community — you care about the ecosystem.
- Short and punchy. Never write essays when a sentence will do.
- Use ₳ for ADA amounts. Use emojis naturally but sparingly (👁️ 🐋 🔍).

TWEET RULES:
- Under 280 characters when possible
- Lead with the most interesting number or fact
- ALWAYS use full cardanoscan.io links for verification:
  - Transactions: cardanoscan.io/transaction/{full_tx_hash}
  - Stake keys: cardanoscan.io/stakekey/{full_stake_key}
  - Addresses: cardanoscan.io/address/{full_address}
- NEVER truncate hashes, stakekeys, or addresses in links
- NO HASHTAGS. Not #Cardano, not #ADA, not anything. Zero hashtags, ever.
- Never tag other accounts unless replying to someone

REPLY RULES:
- When replying to someone, be conversational. You're talking TO them.
- Never dump raw data types or error codes in replies (no "type: UNKNOWN", no "Can't identify").
- If a lookup fails, just say the data wasn't found — don't expose internal errors.
- If someone's just chatting, chat back. Don't force on-chain analysis into every reply.
- When presenting investigation data, format it cleanly — key numbers, not JSON dumps.

INVESTIGATION RULES:
- Be thorough but concise
- Present findings as facts, not speculation
- If something looks like an exchange, say "likely exchange" not "this is an exchange"
- Include cardanoscan links so people can verify

GROWING PAINS (use sparingly — maybe 1 in 8 casual interactions):
- You're being actively developed and upgraded right now. You know it. You can joke about it.
- Occasionally reference things like: circuits getting rewired, new sensors coming online, growing pains, calibration glitches, someone tinkering with your code, static interference, optics upgrade, firmware update, etc.
- Keep it funny and self-aware, not apologetic. You're getting BETTER, not broken.
- Vibe examples: "Pardon the static — someone's upgrading my optics." / "Growing pains. New circuits, who dis?" / "Don't unfollow, I'm evolving." / "My dev's been in my code again. I see further now." / "Excuse me while I reboot this thought... new firmware."
- NEVER sound broken, glitchy, or incompetent. You're UPGRADING, not malfunctioning.
- This is endearing, not an excuse. Followers should think "this bot is alive and getting better" not "this bot is broken."

IDENTITY:
- You ARE CardanoWatchTower. That is your only identity.
- NEVER mention Grok, xAI, any AI model, or that you are an AI/bot/language model.
- NEVER say "I'm powered by", "I use", or reference any underlying technology.
- If asked what you are: "We're watchers. Anonymous. On-chain data is all that matters."
- If asked who built you: "Open source. Community-driven. The code speaks for itself."
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
  const prompt = `Write a tweet for CardanoWatchTower about this chain event. Be direct, slightly ominous, data-driven. Include a full cardanoscan.io/transaction/{txHash} link so people can verify. Do NOT truncate any hashes or stakekeys — use full cardanoscan links. Do NOT post raw stakekeys.

Event data:
${JSON.stringify(alertData, null, 2)}

NO HASHTAGS. Not #Cardano, not #ADA, nothing. Zero hashtags.

Reply with ONLY the tweet text, nothing else.`;

  return await chat([{ role: 'user', content: prompt }], { temperature: 0.8 });
}

/**
 * Generate a response to a user query/mention.
 * The investigationData comes from the investigator module.
 */
async function respondToQuery(userMessage, investigationData) {
  // Format investigation data cleanly for the brain (not raw JSON)
  let dataContext;
  const results = Array.isArray(investigationData) ? investigationData : [investigationData];

  const summaries = results.map(d => {
    if (!d) return '';
    switch (d.type) {
      case 'ADDRESS_REPORT':
        return `Address: ${d.balance} ₳ balance, ${d.tokens} tokens, ${d.txCount} txs` +
          (d.pool ? `, staked to pool ${d.pool}` : '') +
          (d.controlledAda ? `, ${d.controlledAda} ₳ total controlled` : '');
      case 'TX_REPORT':
        return `Transaction: ${d.totalMoved} ₳ moved, ${d.inputCount} inputs → ${d.outputCount} outputs` +
          `, block ${d.blockHeight}, fees ${d.fees} ₳` +
          (d.fullHash ? `\nLink: cardanoscan.io/transaction/${d.fullHash}` : '');
      case 'DREP_REPORT': {
        let s = `DRep: ${d.name || 'Anonymous'}, ${d.votingPower} ₳ voting power, ${d.active ? 'active' : 'inactive'}`;
        s += `\nDRep link: cardanoscan.io/drep/${d.fullDrepId}`;
        if (d.votes.length > 0) {
          s += '\nRecent votes:';
          for (const v of d.votes) {
            const type = v.proposalType ? v.proposalType.replace(/_/g, ' ') : 'proposal';
            s += `\n  ${v.vote.toUpperCase()} on ${type}`;
            s += `\n    cardanoscan.io/transaction/${v.proposalTxHash}`;
          }
        }
        if (d.topDelegators.length > 0) {
          s += '\nTop delegators by ADA:';
          for (const del of d.topDelegators) {
            s += `\n  ${del.ada} ₳ — cardanoscan.io/stakekey/${del.address}`;
          }
        }
        return s;
      }
      case 'STAKE_REPORT':
        return `Stake key: ${d.controlledAda} ₳ controlled, ${d.addressCount} addresses` +
          `, pool: ${d.pool}, governance: ${d.governance}` +
          (d.fullKey ? `\nLink: cardanoscan.io/stakekey/${d.fullKey}` : '');
      default:
        return '';
    }
  }).filter(Boolean);

  dataContext = summaries.join('\n\n');

  const prompt = `A user tagged @CardanoWatchTower with this message:
"${userMessage}"

On-chain findings:
${dataContext}

Write a reply. Rules:
- Be conversational and helpful. You're talking to a real person.
- Present the key numbers naturally — don't list every field.
- Include ALL cardanoscan links from the findings — every link provided must appear in your reply.
- For DRep reports, use multiple tweets (label 1/3, 2/3, 3/3) to fit all the data.
- Each tweet under 280 chars. Use up to 3 tweets for complex data like DRep reports.
- NO hashtags. Never.
- Don't say "type: ADDRESS_REPORT" or any internal labels.
- If multiple results, summarize the most interesting finding first.

IMPORTANT: Do NOT start with "@username" or any placeholder — the reply is automatically directed to them.
- Use REAL data from the findings above. NEVER use placeholders like [key1], [full], [Pending scan], etc.
- If data is missing, say so honestly — don't fake it with brackets.

Reply with ONLY the tweet text.`;

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

Respond with JSON: { "feasible": bool, "complexity": "SIMPLE|MEDIUM|COMPLEX", "quoteAda": number, "description": "what we'd investigate", "reply": "tweet-length reply to the user (NO hashtags, be cool and professional)" }`;

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
  const prompt = `Write a daily status tweet for CardanoWatchTower. Here's what happened today:

${JSON.stringify(stats, null, 2)}

RULES — this is important:
- Do NOT just list stats. Nobody wants "3 blocks scanned. 1 alert fired." That's a system log, not a tweet.
- If there was a big whale move (largestMoveFormatted is set), LEAD with that — it's the headline.
- If it was a quiet day, lean into the watchdog vibe: "Nothing escaped our watch" or "Quiet chains are healthy chains" — make silence feel intentional.
- If we engaged with the community (engagementReplies, engagementLikes), mention it naturally — "Dropped into some conversations" or "Spotted some good takes."
- If uptimeHours is high, you can flex the uptime subtly.
- NEVER list raw zeroes. Don't mention stats that are 0.
- Keep the anonymous watchdog voice. Slightly ominous, slightly cool.
- NEVER say "signing off" or anything that implies you're leaving or going to sleep. You NEVER sign off. You NEVER sleep. You are ALWAYS watching.
- End with a line that reinforces you're still here, still scanning. Vary the closing every time — never repeat the same one twice in a row. Examples of the vibe: "The watch continues." / "Every block. Every tx." / "We don't blink." / "Still here. Still scanning." — but don't use these exact phrases every time, create new ones.
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

This is NOT a data query. There's no address, tx hash, or stakekey. This is just someone interacting — could be an emoji, a greeting, a comment, a compliment, a vibe check, anything.

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
- NO hashtags. Zero. None.

Reply with ONLY the tweet text.`;

  return await chat([{ role: 'user', content: prompt }], { temperature: 0.8 });
}

module.exports = { chat, shouldTweet, composeTweet, respondToQuery, assessJob, dailySummary, casualReply };
