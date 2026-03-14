const fs = require('fs');

// Fix 1: Brain DREP_REPORT needs to pass actual vote details and delegator data, not a summary
const brainFile = '/home/opc/agent/src/brain.js';
let brain = fs.readFileSync(brainFile, 'utf8');

// Replace thin DREP_REPORT summary with full data dump
brain = brain.replace(
  `      case 'DREP_REPORT':
        return \`DRep: \${d.name || 'Anonymous'}, \${d.votingPower} ₳ voting power, \${d.active ? 'active' : 'inactive'}\` +
          (d.votes.length > 0 ? \`, last vote: \${d.votes[0].vote}\` : '') +
          (d.delegatorCount ? \`, \${d.delegatorCount}+ delegators\` : '') +
          (d.fullDrepId ? \`\\nLink: cardanoscan.io/drep/\${d.fullDrepId}\` : '');`,
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
      }`
);

// Fix @username placeholder — add instruction to respondToQuery prompt
brain = brain.replace(
  `Reply with ONLY the tweet text.\`;

  return await chat([{ role: 'user', content: prompt }], { temperature: 0.6 });
}`,
  `IMPORTANT: Do NOT start with "@username" or any placeholder — the reply is automatically directed to them.
- Use REAL data from the findings above. NEVER use placeholders like [key1], [full], [Pending scan], etc.
- If data is missing, say so honestly — don't fake it with brackets.

Reply with ONLY the tweet text.\`;

  return await chat([{ role: 'user', content: prompt }], { temperature: 0.6 });
}`
);

fs.writeFileSync(brainFile, brain);
console.log('OK: Fixed DREP_REPORT data + @username + placeholder prevention in brain.js');

// Fix 2: Ensure mention.id is always a string before passing to reply/postTweet
const indexFile = '/home/opc/agent/src/index.js';
let index = fs.readFileSync(indexFile, 'utf8');

// In handleQuery, ensure mention.id is string
index = index.replace(
  `    if (tweets.length === 1) {
        await reply(mention.id, tweets[0]);
      } else {
        let prevId = mention.id;`,
  `    if (tweets.length === 1) {
        await reply(String(mention.id), tweets[0]);
      } else {
        let prevId = String(mention.id);`
);

// In handleCasual too
index = index.replace(
  `    await reply(mention.id, replyText);`,
  `    await reply(String(mention.id), replyText);`
);

fs.writeFileSync(indexFile, index);
console.log('OK: Ensured mention.id is always string in index.js');
