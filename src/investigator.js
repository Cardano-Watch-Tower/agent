/**
 * INVESTIGATOR
 *
 * On-demand address/tx investigation. When a user tags the bot with
 * an address or tx hash, this module runs a quick investigation and
 * returns a summary.
 *
 * Capabilities:
 *   - Address lookup: balance, stakekey, governance, tx count
 *   - TX lookup: inputs, outputs, ADA moved, timestamp
 *   - Stake key profile: pool, drep, total controlled, address count
 *   - Quick trace: follow the money 1-2 hops from an address
 */
const { api, rateLimited, govFetch } = require('./blockfrost');
const { formatAda, shortenHash } = require('./formatter');

/**
 * Detect what kind of query the user sent.
 * Returns: { type: 'address'|'tx'|'stake'|'pool'|'unknown', value: string }
 */
/**
 * Extract blockchain identifiers from user input.
 * Returns null if no blockchain data is found (= casual message).
 * Returns array of { type, value } for all found identifiers.
 * Single match returns one object for backward compat.
 */
function parseQuery(input) {
  const cleaned = input.trim();
  const found = [];

  // Extract all addresses (addr1...)
  const addrMatches = cleaned.match(/\b(addr1[a-z0-9]{50,}|addr_[a-z0-9]{50,})\b/gi);
  if (addrMatches) {
    for (const m of addrMatches) found.push({ type: 'address', value: m });
  }

  // Byron-era addresses
  const byronMatches = cleaned.match(/\b(Ae2[a-zA-Z0-9]{50,}|Ddz[a-zA-Z0-9]{50,})\b/g);
  if (byronMatches) {
    for (const m of byronMatches) found.push({ type: 'address', value: m });
  }

  // Extract all stakekeys
  const stakeMatches = cleaned.match(/\b(stake1[a-z0-9]{40,}|stake_[a-z0-9]{40,})\b/gi);
  if (stakeMatches) {
    for (const m of stakeMatches) found.push({ type: 'stake', value: m });
  }

  // Extract all DRep IDs
  const drepMatches = cleaned.match(/\b(drep1[a-z0-9]{40,})\b/gi);
  if (drepMatches) {
    for (const m of drepMatches) found.push({ type: 'drep', value: m });
  }

  // Extract all pool IDs
  const poolMatches = cleaned.match(/\b(pool1[a-z0-9]{40,})\b/gi);
  if (poolMatches) {
    for (const m of poolMatches) found.push({ type: 'pool', value: m });
  }

  // Extract all tx hashes (64-char hex strings)
  const txMatches = cleaned.match(/\b([a-f0-9]{64})\b/gi);
  if (txMatches) {
    for (const m of txMatches) found.push({ type: 'tx', value: m.toLowerCase() });
  }

  // Nothing found = casual message, return null
  if (found.length === 0) return null;

  // Single match — return it directly (backward compat)
  if (found.length === 1) return found[0];

  // Multiple matches — return array with .type and .value from first for compat
  found.type = found[0].type;
  found.value = found[0].value;
  found.multi = true;
  return found;
}

/**
 * Investigate an address.
 */
async function investigateAddress(address) {
  const info = await rateLimited(() => api.addresses(address));

  const result = {
    type: 'ADDRESS_REPORT',
    address: address.substring(0, 30) + '...',
    txCount: info.tx_count,
    stakeAddress: info.stake_address || null,
    balance: 0,
    tokens: 0
  };

  // Parse balance
  for (const amt of info.amount) {
    if (amt.unit === 'lovelace') {
      result.balance = Math.floor(Number(amt.quantity) / 1_000_000);
    } else {
      result.tokens++;
    }
  }

  // If staked, get governance info
  if (info.stake_address) {
    try {
      const account = await rateLimited(() => api.accounts(info.stake_address));
      result.pool = account.pool_id || null;
      result.drep = account.drep_id || null;
      result.controlledAda = Math.floor(Number(account.controlled_amount) / 1_000_000);
      result.rewards = Math.floor(Number(account.withdrawable_amount) / 1_000_000);
      result.active = account.active;
    } catch (e) { /* not staked */ }
  }

  // Get last few txs
  try {
    const txs = await rateLimited(() =>
      api.addressesTransactions(address, { count: 5, order: 'desc' })
    );
    result.recentTxs = txs.map(t => ({
      hash: shortenHash(t.tx_hash),
      block: t.block_height
    }));
  } catch (e) { /* no txs */ }

  return result;
}

/**
 * Investigate a transaction.
 */
async function investigateTx(txHash) {
  const utxos = await rateLimited(() => api.txsUtxos(txHash));
  const txInfo = await rateLimited(() => api.txs(txHash));

  const inputAddrs = new Set(utxos.inputs.map(i => i.address));
  let totalIn = 0;
  let totalOut = 0;
  let totalMoved = 0;

  for (const inp of utxos.inputs) {
    const lov = inp.amount.find(a => a.unit === 'lovelace');
    if (lov) totalIn += Math.floor(Number(lov.quantity) / 1_000_000);
  }

  const destinations = [];
  for (const out of utxos.outputs) {
    const lov = out.amount.find(a => a.unit === 'lovelace');
    const ada = lov ? Math.floor(Number(lov.quantity) / 1_000_000) : 0;
    totalOut += ada;

    if (!inputAddrs.has(out.address)) {
      totalMoved += ada;
      destinations.push({
        address: out.address.substring(0, 30) + '...',
        ada
      });
    }
  }

  return {
    type: 'TX_REPORT',
    txHash: shortenHash(txHash),
    fullHash: txHash,
    blockHeight: txInfo.block_height,
    blockTime: new Date(txInfo.block_time * 1000).toISOString(),
    fees: Math.floor(Number(txInfo.fees) / 1_000_000),
    totalIn,
    totalOut,
    totalMoved,
    inputCount: utxos.inputs.length,
    outputCount: utxos.outputs.length,
    topDestinations: destinations.sort((a, b) => b.ada - a.ada).slice(0, 5)
  };
}

/**
 * Investigate a stakekey.
 */
async function investigateStake(stakeKey) {
  const account = await rateLimited(() => api.accounts(stakeKey));

  const result = {
    type: 'STAKE_REPORT',
    stakeKey: stakeKey.substring(0, 25) + '...',
    fullKey: stakeKey,
    controlledAda: Math.floor(Number(account.controlled_amount) / 1_000_000),
    rewards: Math.floor(Number(account.withdrawable_amount) / 1_000_000),
    pool: account.pool_id || 'NOT STAKED',
    drep: account.drep_id || 'NO DREP',
    active: account.active,
    governance: 'none'
  };

  if (account.drep_id === 'drep_always_abstain') result.governance = 'ABSTAIN';
  else if (account.drep_id === 'drep_always_no_confidence') result.governance = 'NO CONFIDENCE';
  else if (account.drep_id) result.governance = 'Delegated to DRep';

  // Count addresses
  try {
    const addrs = await rateLimited(() =>
      api.accountsAddresses(stakeKey, { count: 100 })
    );
    result.addressCount = addrs.length;
  } catch (e) {
    result.addressCount = 0;
  }

  return result;
}

/**
 * Investigate a DRep (Delegated Representative).
 */
async function investigateDrep(drepId) {
  // Get DRep info
  const info = await govFetch(`/governance/dreps/${drepId}`);

  const result = {
    type: 'DREP_REPORT',
    drepId: drepId.substring(0, 25) + '...',
    fullDrepId: drepId,
    votingPower: Math.floor(Number(info.amount) / 1_000_000),
    active: info.active,
    retired: info.retired,
    activeEpoch: info.active_epoch,
    hasScript: info.has_script,
    votes: [],
    topDelegators: [],
    name: null
  };

  // Get DRep metadata (name, bio)
  try {
    const meta = await govFetch(`/governance/dreps/${drepId}/metadata`);
    if (meta.json_metadata) {
      const body = meta.json_metadata.body || meta.json_metadata;
      result.name = body.givenName || (body.dRepName && body.dRepName['@value']) || null;
    }
  } catch (e) { /* no metadata */ }

  // Get recent votes (last 5)
  try {
    const votes = await govFetch(`/governance/dreps/${drepId}/votes?order=desc&count=5`);
    for (const v of votes) {
      let proposalType = null;
      try {
        const prop = await govFetch(`/governance/proposals/${v.proposal_tx_hash}/${v.proposal_cert_index}`);
        proposalType = prop.governance_type || null;
      } catch (e) { /* can't get proposal details */ }

      result.votes.push({
        vote: v.vote,
        proposalId: v.proposal_id || null,
        proposalTxHash: v.proposal_tx_hash,
        proposalCertIndex: v.proposal_cert_index,
        proposalType: proposalType,
        txHash: v.tx_hash
      });
    }
  } catch (e) { /* no votes */ }

  // Get top delegators (by ADA amount, top 5)
  try {
    const delegators = await govFetch(`/governance/dreps/${drepId}/delegators?order=desc&count=20`);
    // Sort by amount descending and take top 5
    const sorted = delegators
      .map(d => ({ address: d.address, ada: Math.floor(Number(d.amount) / 1_000_000) }))
      .sort((a, b) => b.ada - a.ada)
      .slice(0, 5);
    result.topDelegators = sorted;
    result.delegatorCount = delegators.length;
  } catch (e) {
    result.delegatorCount = 0;
  }

  return result;
}

/**
 * Format investigation results for display/tweet.
 */
function formatReport(result) {
  const lines = [];

  switch (result.type) {
    case 'ADDRESS_REPORT':
      lines.push(`📍 Address Report`);
      lines.push(`Balance: ${formatAda(result.balance)} ₳`);
      if (result.tokens > 0) lines.push(`Tokens: ${result.tokens} types`);
      lines.push(`TX count: ${result.txCount}`);
      if (result.pool) lines.push(`Pool: ${result.pool.substring(0, 15)}...`);
      if (result.drep) {
        if (result.drep === 'drep_always_abstain') lines.push(`Governance: ABSTAIN`);
        else if (result.drep === 'drep_always_no_confidence') lines.push(`Governance: NO CONFIDENCE`);
        else lines.push(`DRep: ${result.drep.substring(0, 15)}...`);
      } else {
        lines.push(`Governance: NONE`);
      }
      if (result.controlledAda) lines.push(`Total controlled: ${formatAda(result.controlledAda)} ₳`);
      break;

    case 'TX_REPORT':
      lines.push(`🔍 Transaction Report`);
      lines.push(`Moved: ${formatAda(result.totalMoved)} ₳`);
      lines.push(`Block: ${result.blockHeight}`);
      lines.push(`Time: ${result.blockTime}`);
      lines.push(`Fees: ${result.fees} ₳`);
      lines.push(`${result.inputCount} inputs → ${result.outputCount} outputs`);
      if (result.topDestinations.length > 0) {
        lines.push(`Top destinations:`);
        for (const d of result.topDestinations.slice(0, 3)) {
          lines.push(`  ${formatAda(d.ada)} ₳ → ${d.address}`);
        }
      }
      break;

    case 'DREP_REPORT':
      lines.push(`🗳️ DRep Report`);
      if (result.name) lines.push(`Name: ${result.name}`);
      lines.push(`Voting power: ${formatAda(result.votingPower)} ₳`);
      lines.push(`Active: ${result.active ? 'YES' : 'NO'}${result.retired ? ' (RETIRED)' : ''}`);
      if (result.delegatorCount !== undefined) lines.push(`Delegators: ${result.delegatorCount}+`);
      if (result.votes.length > 0) {
        lines.push(`Recent votes:`);
        for (const v of result.votes.slice(0, 3)) {
          const type = v.proposalType ? ` (${v.proposalType.replace(/_/g, ' ')})` : '';
          lines.push(`  ${v.vote.toUpperCase()}${type}`);
        }
      }
      if (result.topDelegators.length > 0) {
        lines.push(`Top delegators:`);
        for (const d of result.topDelegators.slice(0, 3)) {
          lines.push(`  ${formatAda(d.ada)} ₳ — ${d.address.substring(0, 20)}...`);
        }
      }
      break;

    case 'STAKE_REPORT':
      lines.push(`🔑 Stake Key Report`);
      lines.push(`Controlled: ${formatAda(result.controlledAda)} ₳`);
      lines.push(`Addresses: ${result.addressCount}`);
      lines.push(`Pool: ${result.pool.substring(0, 20)}...`);
      lines.push(`Governance: ${result.governance}`);
      lines.push(`Active: ${result.active ? 'YES' : 'NO'}`);
      lines.push(`Unclaimed rewards: ${formatAda(result.rewards)} ₳`);
      break;
  }

  return lines.join('\n');
}

/**
 * Main entry point. Takes raw user input, detects type, investigates.
 */
async function investigate(input) {
  const query = parseQuery(input);

  if (!query) return null;

  switch (query.type) {
    case 'address':
      return await investigateAddress(query.value);
    case 'tx':
      return await investigateTx(query.value);
    case 'stake':
      return await investigateStake(query.value);
    case 'drep':
      return await investigateDrep(query.value);
    case 'pool':
      return { type: 'POOL_REPORT', message: 'Pool investigation coming soon' };
    default:
      return null;
  }
}

module.exports = { investigate, investigateAddress, investigateTx, investigateStake, investigateDrep, formatReport, parseQuery };
