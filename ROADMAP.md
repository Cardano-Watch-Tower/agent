# CardanoWatchTower — v2 Roadmap

## Bugs — Fix Next Session

### Stake key links still broken
- `formatter.js` has `stakeLink()` but bot is still posting raw stake keys in some tweets
- Need to audit all code paths that output stake keys — brain.js composeTweet, respondToQuery
- Grok might be ignoring the "use cardanoscan links" instruction in some prompts
- Check: is the link format `cardanoscan.io/stakekey/` correct? Might need `/stakeKey/` (camelCase)

### Multi-hash mention parsing fails
- User sent 3 tx hashes in one message (IOG hop-1, CF hop-1, Emurgo hop-1)
- `parseQuery()` only extracts the FIRST hash, passes it to `respondToQuery`
- Grok sees the rest of the message as noise → outputs "Type: UNKNOWN. Can't identify."
- Fix: `parseQuery` should return ALL hashes found in a message
- Then `investigate()` each one, build a combined response
- Or: detect multi-hash messages and handle as a batch query
- Example bad output: "1/3 IOG hop-1: [hash] Type: UNKNOWN. Can't identify. CF hop-1: [hash]..."
- Should be: investigate each hash separately, respond with findings per hash

---

## Tweet Layout — Structured Posts
Current tweets are freeform Grok output. v2 should have consistent visual structure:
- Alert tweets: emoji header → what happened → amount → cardanoscan link → watchdog sign-off
- Reply tweets: direct answer first, then source link, then one-liner sign-off
- Digest tweets: headline stat or vibe, NOT raw numbers
- Template system in formatter.js — Grok fills slots, not freeform

## Knowledge Memory — Blockchain Facts Only
The bot should accumulate verified knowledge over time:
- Save every interaction: who asked, what about, what we found, timestamp
- Store verified facts in a local knowledge base (JSON or SQLite)
- ONLY blockchain-verified data counts as knowledge. No rumors, no "someone said"
- When a topic comes up again, reference what we already know
- Knowledge categories: wallet clusters, entity identifications, transaction patterns, governance votes
- File: `src/memory.js` — read/write knowledge store
- Schema: `{ topic, facts[], sources[], firstSeen, lastUpdated, confidence }`

## Truth Engine — See It On X, Verify On-Chain
When the bot sees claims on X (via engagement loop), it should:
1. Detect claims about Cardano (whale moves, governance drama, project rugs, etc.)
2. Dig into the blockchain to find the TRUTH about the claim
3. Post findings — either confirming or debunking, with on-chain proof links
4. The bot only ever deals in blockchain facts. Never speculation. Never opinion.
5. This is the FREE community service — not detective work (that's hired/paid)

### Trigger Categories
- "whale moved X ADA" → check the tx, verify amount, show the real numbers
- "project X rugged" → check stake key activity, withdrawals, delegation changes
- "governance vote rigged" → check DRep delegations, voting records
- Community gets riled up about something → take research action → share findings

### Important Distinction
- **Community watchdog** (free): When the COMMUNITY is buzzing about something, the bot investigates and shares. Public service. Builds trust and followers.
- **Detective service** (hired): When an INDIVIDUAL wants a specific investigation done. Quote → payment → delivery. Private.
- The bot should be smart enough to tell the difference.

## Engagement Intelligence
- Track which topics get the most engagement (likes, replies, follows)
- Double down on content types that resonate
- Time-of-day optimization — when does Cardano Twitter peak?
- Track community sentiment shifts over time

## Future: Thread Builder
- For big findings, compose multi-tweet threads with narrative arc
- "Here's what we found" → evidence chain → conclusion → cardanoscan links
- Thread structure stored as array, posted with proper reply chaining
