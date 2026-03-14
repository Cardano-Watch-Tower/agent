const fs = require('fs');

// === FIX 1: Thread logic — reply all tweets to original mention instead of chaining ===
const indexFile = '/home/opc/agent/src/index.js';
let index = fs.readFileSync(indexFile, 'utf8');

// Replace the broken thread chaining with simple multi-reply
index = index.replace(
  `    if (tweets.length === 1) {
        await reply(String(mention.id), tweets[0]);
      } else {
        let prevId = String(mention.id);
        for (const t of tweets) {
          prevId = await postTweet(t, prevId);
          await sleep(1000);
        }
      }`,
  `    // Reply all tweets to the original mention (no chaining needed — they appear as replies)
      for (const t of tweets) {
        await reply(String(mention.id), t);
        await sleep(2000);
      }`
);

fs.writeFileSync(indexFile, index);
console.log('OK: Fixed thread logic in index.js');

// === FIX 2: Investigator — keep full proposal IDs, include full addresses ===
const invFile = '/home/opc/agent/src/investigator.js';
let inv = fs.readFileSync(invFile, 'utf8');

// Don't truncate proposal IDs — brain needs them for URLs
inv = inv.replace(
  `      result.votes.push({
        vote: v.vote,
        proposalId: v.proposal_id ? v.proposal_id.substring(0, 30) + '...' : shortenHash(v.proposal_tx_hash),
        proposalType: proposalType,
        txHash: v.tx_hash
      });`,
  `      result.votes.push({
        vote: v.vote,
        proposalId: v.proposal_id || null,
        proposalTxHash: v.proposal_tx_hash,
        proposalCertIndex: v.proposal_cert_index,
        proposalType: proposalType,
        txHash: v.tx_hash
      });`
);

fs.writeFileSync(invFile, inv);
console.log('OK: Fixed full proposal IDs in investigator.js');

// === FIX 3: Brain — include full data + URL instructions ===
const brainFile = '/home/opc/agent/src/brain.js';
let brain = fs.readFileSync(brainFile, 'utf8');

// Update DREP_REPORT formatting to include full data for URLs
brain = brain.replace(
  `      case 'DREP_REPORT': {
        let s = \`DRep: \${d.name || 'Anonymous'}, \${d.votingPower} ₳ voting power, \${d.active ? 'active' : 'inactive'}\`;
        if (d.votes.length > 0) {
          s += '\\nRecent votes:';
          for (const v of d.votes) {
            s += \`\\n  \${v.vote.toUpperCase()} on \${v.proposalType ? v.proposalType.replace(/_/g, ' ') : 'proposal'} (\${v.proposalId})\`;
          }
        }
        if (d.topDelegators.length > 0) {
          s += '\\nTop delegators by ADA:';
          for (const del of d.topDelegators) {
            s += \`\\n  \${del.ada} ₳ — \${del.address}\`;
          }
        }
        if (d.fullDrepId) s += \`\\nLink: cardanoscan.io/drep/\${d.fullDrepId}\`;
        return s;
      }`,
  `      case 'DREP_REPORT': {
        let s = \`DRep: \${d.name || 'Anonymous'}, \${d.votingPower} ₳ voting power, \${d.active ? 'active' : 'inactive'}\`;
        s += \`\\nDRep link: cardanoscan.io/drep/\${d.fullDrepId}\`;
        if (d.votes.length > 0) {
          s += '\\nRecent votes:';
          for (const v of d.votes) {
            const type = v.proposalType ? v.proposalType.replace(/_/g, ' ') : 'proposal';
            s += \`\\n  \${v.vote.toUpperCase()} on \${type}\`;
            s += \`\\n    cardanoscan.io/transaction/\${v.proposalTxHash}\`;
          }
        }
        if (d.topDelegators.length > 0) {
          s += '\\nTop delegators by ADA:';
          for (const del of d.topDelegators) {
            s += \`\\n  \${del.ada} ₳ — cardanoscan.io/stakekey/\${del.address}\`;
          }
        }
        return s;
      }`
);

// Update respondToQuery prompt to be explicit about URLs
brain = brain.replace(
  `- Include cardanoscan links when you have full hashes/keys.
- Under 280 chars if the data is simple. Use 2 tweets max for complex data.`,
  `- Include ALL cardanoscan links from the findings — every link provided must appear in your reply.
- For DRep reports, use multiple tweets (label 1/3, 2/3, 3/3) to fit all the data.
- Each tweet under 280 chars. Use up to 3 tweets for complex data like DRep reports.`
);

fs.writeFileSync(brainFile, brain);
console.log('OK: Fixed DREP_REPORT URLs and thread instructions in brain.js');
