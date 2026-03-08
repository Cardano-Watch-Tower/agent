/**
 * ALERT FORMATTER
 *
 * Turns raw chain alert data into tweet-ready text.
 * Voice: anonymous, direct, slightly ominous. "Cardano, we're watching."
 *
 * Format rules:
 *   - Lead with the number (ADA amount)
 *   - Short, punchy sentences
 *   - Tag governance status when relevant
 *   - Include tx hash (shortened) for verification
 *   - Stay under 280 chars for X posts
 */

function txLink(hash) {
  if (!hash) return '???';
  return `cardanoscan.io/transaction/${hash}`;
}

function stakeLink(stakeKey) {
  if (!stakeKey) return 'unknown';
  return `cardanoscan.io/stakekey/${stakeKey}`;
}

// Keep short versions for console logging only
function shortenHash(hash) {
  if (!hash) return '???';
  return hash.substring(0, 8) + '...' + hash.substring(hash.length - 6);
}

function shortenStake(stakeKey) {
  if (!stakeKey) return 'unknown';
  return stakeKey.substring(0, 20) + '...';
}

function formatAda(amount) {
  if (amount >= 1_000_000_000) return (amount / 1_000_000_000).toFixed(2) + 'B';
  if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(1) + 'M';
  if (amount >= 1_000) return (amount / 1_000).toFixed(0) + 'K';
  return amount.toLocaleString();
}

function classifyGovernance(drep) {
  if (!drep) return null;
  if (drep === 'drep_always_abstain') return 'ABSTAIN';
  if (drep === 'drep_always_no_confidence') return 'NO CONFIDENCE';
  return 'DRep delegated';
}

/**
 * Generate the tweet-ready text for an alert.
 */
function formatTweet(alert) {
  const ada = formatAda(alert.totalMoved);
  const emoji = alert.type === 'WHALE_ALERT' ? '🐋' : '👁️';
  const hash = shortenHash(alert.txHash);

  let lines = [];

  // Headline
  lines.push(`${emoji} ${ada} ₳ just moved.`);

  // Destination info
  if (alert.topDestinations && alert.topDestinations.length > 0) {
    const top = alert.topDestinations[0];

    if (top.isScript) {
      lines.push(`→ Smart contract`);
    } else if (top.isByron) {
      lines.push(`→ Legacy (Byron) address`);
    } else if (top.controlledAda) {
      const destAda = formatAda(top.controlledAda);
      lines.push(`→ Wallet holding ${destAda} ₳`);

      const gov = classifyGovernance(top.drep);
      if (gov) lines.push(`   Governance: ${gov}`);
    }

    if (alert.destinationCount > 1) {
      lines.push(`   Split across ${alert.destinationCount} destinations`);
    }
  }

  // TX reference — full cardanoscan link so people can verify
  lines.push(`\n${txLink(alert.txHash)}`);

  return lines.join('\n');
}

/**
 * Generate a longer-form console alert (for logging/display).
 */
function formatAlert(alert) {
  const ada = formatAda(alert.totalMoved);
  const border = alert.type === 'WHALE_ALERT'
    ? '🐋'.repeat(20)
    : '─'.repeat(50);

  let lines = [];
  lines.push(border);
  lines.push(`  ${alert.type}: ${ada} ₳ moved`);
  lines.push(`  TX: ${alert.txHash}`);
  lines.push(`  Block: ${alert.blockHeight} | Time: ${new Date(alert.blockTime * 1000).toISOString()}`);
  lines.push('');

  if (alert.senderStakeKeys && alert.senderStakeKeys.length > 0) {
    lines.push('  FROM:');
    for (const sk of alert.senderStakeKeys) {
      lines.push(`    ${shortenStake(sk)}`);
    }
  }

  if (alert.topDestinations && alert.topDestinations.length > 0) {
    lines.push('  TO:');
    for (const dest of alert.topDestinations) {
      const destAda = formatAda(dest.ada);
      let label = dest.isScript ? 'SCRIPT' : dest.isByron ? 'BYRON' : 'SHELLEY';
      if (dest.stakeAddress) label = shortenStake(dest.stakeAddress);

      let gov = '';
      const govStatus = classifyGovernance(dest.drep);
      if (govStatus) gov = ` [${govStatus}]`;

      lines.push(`    ${destAda} ₳ → ${label}${gov}`);
    }
  }

  lines.push(border);

  // Include tweet draft
  lines.push('');
  lines.push('  TWEET DRAFT:');
  lines.push('  ' + formatTweet(alert).split('\n').join('\n  '));
  lines.push('');

  return lines.join('\n');
}

module.exports = { formatAlert, formatTweet, formatAda, shortenHash, txLink, stakeLink };
