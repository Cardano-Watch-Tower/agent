/**
 * GENESIS WHALE REWARDS TRACKER
 *
 * Scans recent large transactions for Byron-era (genesis) addresses,
 * resolves their stake keys, pulls full reward history, and saves
 * structured data for visualization.
 *
 * Output: /home/opc/agent/data/genesis-whale-rewards.json
 *
 * Usage: node genesis-rewards-tracker.js [--recent N] [--stake stake1...]
 *   --recent N    Scan last N blocks for whale txs (default: 1000)
 *   --stake KEY   Directly analyze a specific stake key
 */
require('dotenv').config();
const { api, rateLimited, govFetch } = require('./src/blockfrost');
const fs = require('fs');
const path = require('path');

const ADA = (lovelace) => Math.floor(Number(lovelace) / 1_000_000);
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Fetch ALL reward records for a stake address (paginated).
 */
async function fetchAllRewards(stakeAddr) {
  const all = [];
  let page = 1;
  while (true) {
    try {
      const batch = await rateLimited(() =>
        api.accountsRewards(stakeAddr, { page, count: 100, order: 'asc' })
      );
      if (!batch || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 100) break;
      page++;
    } catch (e) {
      if (e.status_code === 404) break;
      throw e;
    }
  }
  return all;
}

/**
 * Fetch full account info for a stake address.
 */
async function fetchAccountInfo(stakeAddr) {
  try {
    const info = await rateLimited(() => api.accounts(stakeAddr));
    return {
      stakeAddress: stakeAddr,
      active: info.active,
      activeEpoch: info.active_epoch,
      controlledAda: ADA(info.controlled_amount),
      rewardsSumAda: ADA(info.rewards_sum),
      withdrawalsSumAda: ADA(info.withdrawals_sum),
      reservesSumAda: ADA(info.reserves_sum),
      treasurySumAda: ADA(info.treasury_sum),
      withdrawableAda: ADA(info.withdrawable_amount),
      poolId: info.pool_id || null,
      drepId: info.drep_id || null
    };
  } catch (e) {
    console.error(`  Failed to fetch account ${stakeAddr}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch addresses associated with a stake key.
 */
async function fetchStakeAddresses(stakeAddr) {
  const addrs = [];
  let page = 1;
  while (true) {
    try {
      const batch = await rateLimited(() =>
        api.accountsAddresses(stakeAddr, { page, count: 100 })
      );
      if (!batch || batch.length === 0) break;
      addrs.push(...batch.map(a => a.address));
      if (batch.length < 100) break;
      page++;
    } catch (e) {
      break;
    }
  }
  return addrs;
}

/**
 * Analyze a single whale by stake address.
 * Returns full profile with reward history.
 */
async function analyzeWhale(stakeAddr) {
  console.log(`\n🐋 Analyzing: ${stakeAddr}`);

  // 1. Account summary
  const account = await fetchAccountInfo(stakeAddr);
  if (!account) return null;
  console.log(`  💰 Controlled: ${account.controlledAda.toLocaleString()} ADA`);
  console.log(`  🎁 Lifetime rewards: ${account.rewardsSumAda.toLocaleString()} ADA`);

  // 2. Full reward history (per-epoch)
  console.log(`  📊 Fetching reward history...`);
  const rewards = await fetchAllRewards(stakeAddr);
  console.log(`  📊 ${rewards.length} epochs of rewards`);

  const rewardHistory = rewards.map(r => ({
    epoch: r.epoch,
    ada: ADA(r.amount),
    lovelace: r.amount,
    poolId: r.pool_id,
    type: r.type  // 'member' or 'leader'
  }));

  // 3. Cumulative rewards over time
  let cumulative = 0;
  const cumulativeHistory = rewardHistory.map(r => {
    cumulative += r.ada;
    return { epoch: r.epoch, reward: r.ada, cumulative, poolId: r.poolId };
  });

  // 4. Pool history (which pools they delegated to over time)
  const poolHistory = [];
  let currentPool = null;
  for (const r of rewardHistory) {
    if (r.poolId !== currentPool) {
      poolHistory.push({ epoch: r.epoch, poolId: r.poolId });
      currentPool = r.poolId;
    }
  }

  // 5. Associated addresses
  console.log(`  🔗 Fetching associated addresses...`);
  const addresses = await fetchStakeAddresses(stakeAddr);
  console.log(`  🔗 ${addresses.length} addresses found`);

  // Check if any are Byron-era
  const byronAddresses = addresses.filter(a => a.startsWith('Ae2') || a.startsWith('Ddz'));
  const shelleyAddresses = addresses.filter(a => a.startsWith('addr1'));

  // 6. DRep/governance info
  let governance = null;
  if (account.drepId) {
    governance = { drepId: account.drepId };
    if (account.drepId.startsWith('drep1')) {
      try {
        const drepInfo = await govFetch(`/governance/dreps/${account.drepId}`);
        governance.votingPower = ADA(drepInfo.amount);
        governance.active = drepInfo.active;
      } catch (e) { /* no drep data */ }
    }
  }

  return {
    stakeAddress: stakeAddr,
    account,
    isGenesis: byronAddresses.length > 0,
    byronAddressCount: byronAddresses.length,
    shelleyAddressCount: shelleyAddresses.length,
    totalAddresses: addresses.length,
    sampleAddresses: {
      byron: byronAddresses.slice(0, 3),
      shelley: shelleyAddresses.slice(0, 3)
    },
    governance,
    rewardSummary: {
      totalEpochs: rewardHistory.length,
      firstEpoch: rewardHistory.length > 0 ? rewardHistory[0].epoch : null,
      lastEpoch: rewardHistory.length > 0 ? rewardHistory[rewardHistory.length - 1].epoch : null,
      totalRewardsAda: account.rewardsSumAda,
      avgRewardPerEpoch: rewardHistory.length > 0
        ? Math.round(account.rewardsSumAda / rewardHistory.length)
        : 0,
      peakEpochReward: rewardHistory.length > 0
        ? Math.max(...rewardHistory.map(r => r.ada))
        : 0,
    },
    rewardHistory: cumulativeHistory,
    poolHistory,
    links: {
      stakeKey: `https://cardanoscan.io/stakekey/${stakeAddr}`,
      pool: account.poolId ? `https://cardanoscan.io/pool/${account.poolId}` : null,
      drep: account.drepId && account.drepId.startsWith('drep1')
        ? `https://cardanoscan.io/drep/${account.drepId}` : null
    }
  };
}

/**
 * Scan recent blocks for large transactions involving Byron-era addresses.
 * Returns unique stake keys found.
 */
async function findGenesisWhales(blockCount = 500) {
  console.log(`🔍 Scanning last ${blockCount} blocks for genesis whale activity...`);

  const stakeKeys = new Map(); // stakeKey -> { ada, isByron, txHash }

  const latest = await rateLimited(() => api.blocksLatest());
  let blockHash = latest.hash;

  for (let i = 0; i < blockCount; i++) {
    if (i % 50 === 0) console.log(`  Block ${i}/${blockCount}...`);

    const block = await rateLimited(() => api.blocks(blockHash));

    if (block.tx_count > 0) {
      let txHashes;
      try {
        txHashes = await rateLimited(() => api.blocksTxs(block.hash, { count: 100 }));
      } catch (e) { txHashes = []; }

      for (const txHash of txHashes) {
        try {
          const utxos = await rateLimited(() => api.txsUtxos(txHash));

          // Check outputs for large amounts
          for (const out of utxos.outputs) {
            const lovelace = out.amount.find(a => a.unit === 'lovelace');
            const ada = lovelace ? ADA(lovelace.quantity) : 0;

            if (ada < 100_000) continue; // Only care about 100K+ ADA movements

            const isByron = out.address.startsWith('Ae2') || out.address.startsWith('Ddz');

            // Resolve stake key
            try {
              const addrInfo = await rateLimited(() => api.addresses(out.address));
              if (addrInfo.stake_address) {
                const existing = stakeKeys.get(addrInfo.stake_address);
                if (!existing || ada > existing.ada) {
                  stakeKeys.set(addrInfo.stake_address, {
                    ada,
                    isByron,
                    txHash,
                    address: out.address
                  });
                }
              }
            } catch (e) { /* skip */ }
          }

          // Also check inputs
          for (const inp of utxos.inputs) {
            const lovelace = inp.amount.find(a => a.unit === 'lovelace');
            const ada = lovelace ? ADA(lovelace.quantity) : 0;

            if (ada < 100_000) continue;

            const isByron = inp.address.startsWith('Ae2') || inp.address.startsWith('Ddz');

            try {
              const addrInfo = await rateLimited(() => api.addresses(inp.address));
              if (addrInfo.stake_address) {
                const existing = stakeKeys.get(addrInfo.stake_address);
                if (!existing || ada > existing.ada) {
                  stakeKeys.set(addrInfo.stake_address, {
                    ada,
                    isByron,
                    txHash,
                    address: inp.address
                  });
                }
              }
            } catch (e) { /* skip */ }
          }
        } catch (e) { /* skip tx */ }
      }
    }

    blockHash = block.previous_block;
    if (!blockHash) break;
  }

  console.log(`\n📋 Found ${stakeKeys.size} unique whale stake keys`);
  return stakeKeys;
}

/**
 * Main: Build the full genesis whale rewards report.
 */
async function main() {
  const args = process.argv.slice(2);
  const stakeArg = args.find(a => a.startsWith('--stake'));
  const recentArg = args.find(a => a.startsWith('--recent'));

  let stakeKeysToAnalyze = [];

  if (args.includes('--stake')) {
    // Direct stake key analysis
    const idx = args.indexOf('--stake');
    const keys = args.slice(idx + 1).filter(a => a.startsWith('stake1'));
    stakeKeysToAnalyze = keys.map(k => ({ key: k, source: 'direct' }));
  } else {
    // Scan blocks for whales
    const blockCount = recentArg ? parseInt(args[args.indexOf('--recent') + 1]) : 500;
    const whales = await findGenesisWhales(blockCount);

    // Sort by ADA amount, take top 20
    const sorted = [...whales.entries()]
      .sort((a, b) => b[1].ada - a[1].ada)
      .slice(0, 20);

    stakeKeysToAnalyze = sorted.map(([key, info]) => ({
      key,
      source: 'chain-scan',
      discoveredAda: info.ada,
      discoveredByron: info.isByron,
      discoveredTx: info.txHash
    }));
  }

  console.log(`\n🐋 Analyzing ${stakeKeysToAnalyze.length} whale stake keys...\n`);

  const results = [];
  for (const entry of stakeKeysToAnalyze) {
    try {
      const profile = await analyzeWhale(entry.key);
      if (profile) {
        profile.discoverySource = entry.source;
        if (entry.discoveredAda) profile.discoveredInTxAda = entry.discoveredAda;
        if (entry.discoveredTx) profile.discoveredInTx = entry.discoveredTx;
        results.push(profile);
      }
    } catch (e) {
      console.error(`  ❌ Failed: ${entry.key}: ${e.message}`);
    }
  }

  // Sort by lifetime rewards (descending)
  results.sort((a, b) => b.rewardSummary.totalRewardsAda - a.rewardSummary.totalRewardsAda);

  // Build the full report
  const report = {
    metadata: {
      generatedAt: new Date().toISOString(),
      whalesAnalyzed: results.length,
      genesisWhales: results.filter(r => r.isGenesis).length,
      scanMethod: stakeKeysToAnalyze[0]?.source || 'unknown',
      description: 'Genesis and whale stake key reward analysis for Cardano blockchain',
      purpose: 'Track how much ADA has been distributed in staking rewards to large holders'
    },
    summary: {
      totalControlledAda: results.reduce((s, r) => s + r.account.controlledAda, 0),
      totalLifetimeRewards: results.reduce((s, r) => s + r.rewardSummary.totalRewardsAda, 0),
      avgRewardsPerWhale: results.length > 0
        ? Math.round(results.reduce((s, r) => s + r.rewardSummary.totalRewardsAda, 0) / results.length)
        : 0,
      topRewardEarner: results.length > 0 ? {
        stakeAddress: results[0].stakeAddress,
        rewardsAda: results[0].rewardSummary.totalRewardsAda,
        controlledAda: results[0].account.controlledAda
      } : null,
      epochRange: {
        earliest: Math.min(...results.filter(r => r.rewardSummary.firstEpoch).map(r => r.rewardSummary.firstEpoch)),
        latest: Math.max(...results.filter(r => r.rewardSummary.lastEpoch).map(r => r.rewardSummary.lastEpoch))
      }
    },
    whales: results
  };

  // Save the full report
  const outFile = path.join(DATA_DIR, 'genesis-whale-rewards.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n✅ Report saved to ${outFile}`);
  console.log(`   ${report.metadata.whalesAnalyzed} whales analyzed`);
  console.log(`   ${report.metadata.genesisWhales} with Byron-era (genesis) addresses`);
  console.log(`   Total controlled: ${report.summary.totalControlledAda.toLocaleString()} ADA`);
  console.log(`   Total lifetime rewards: ${report.summary.totalLifetimeRewards.toLocaleString()} ADA`);

  // Also save a CSV-friendly summary for easy charting
  const csvFile = path.join(DATA_DIR, 'whale-rewards-summary.csv');
  const csvLines = ['stake_address,controlled_ada,lifetime_rewards_ada,epochs_staked,avg_reward_per_epoch,is_genesis,pool_id,drep_id,cardanoscan_link'];
  for (const w of results) {
    csvLines.push([
      w.stakeAddress,
      w.account.controlledAda,
      w.rewardSummary.totalRewardsAda,
      w.rewardSummary.totalEpochs,
      w.rewardSummary.avgRewardPerEpoch,
      w.isGenesis,
      w.account.poolId || '',
      w.account.drepId || '',
      w.links.stakeKey
    ].join(','));
  }
  fs.writeFileSync(csvFile, csvLines.join('\n'));
  console.log(`   CSV summary: ${csvFile}`);

  // Save per-whale reward timeseries for charting
  const timeseriesFile = path.join(DATA_DIR, 'whale-reward-timeseries.csv');
  const tsLines = ['stake_address,epoch,reward_ada,cumulative_ada,pool_id'];
  for (const w of results) {
    for (const r of w.rewardHistory) {
      tsLines.push([w.stakeAddress, r.epoch, r.reward, r.cumulative, r.poolId].join(','));
    }
  }
  fs.writeFileSync(timeseriesFile, tsLines.join('\n'));
  console.log(`   Timeseries: ${timeseriesFile}`);

  return report;
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
