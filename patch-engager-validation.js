const fs = require('fs');

// --- Patch engager.js: Add address validation to handleReply ---
let engager = fs.readFileSync('/home/opc/agent/src/engager.js', 'utf8');

// Replace the reply prompt to include anti-hallucination rules
const oldPrompt = `Write a reply from CardanoWatchTower. Rules:
- Be helpful and conversational. Add genuine value.
- If we have on-chain data, share the key finding naturally.
- If no data, share a relevant observation or offer to help.
- Be a community member first, watchdog second.
- Under 280 characters.
- NO hashtags. Zero.`;

const newPrompt = `Write a reply from CardanoWatchTower. Rules:
- Be helpful and conversational. Add genuine value.
- If we have on-chain data, share the key finding naturally.
- If no data, share a relevant observation or offer to help.
- NEVER fabricate on-chain data, tx counts, or analysis you don't have.
- Valid Cardano addresses start with addr1, stake1, Ae2, Ddz, drep1, or pool1. Anything else is NOT Cardano.
- If the tweet discusses a non-Cardano token/address (Solana, Ethereum, etc.), acknowledge it's not your chain. Don't pretend to analyze it.
- NEVER include cardanoscan.io links unless we provided real on-chain data above.
- Be a community member first, watchdog second.
- Under 280 characters.
- NO hashtags. Zero.`;

if (engager.includes(oldPrompt)) {
  engager = engager.replace(oldPrompt, newPrompt);
  fs.writeFileSync('/home/opc/agent/src/engager.js', engager);
  console.log('✅ Patched engager.js — anti-hallucination rules added to reply prompt');
} else {
  console.log('❌ Could not find old prompt in engager.js');
  // Try a more flexible match
  console.log('Looking for partial match...');
  if (engager.includes('Be a community member first, watchdog second.')) {
    console.log('Found partial match — needs manual patch');
  }
}
