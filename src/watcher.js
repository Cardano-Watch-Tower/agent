/**
 * CHAIN WATCHER
 *
 * Polls Cardano mainnet for new blocks, extracts transactions above
 * a configurable ADA threshold, enriches with stake/governance data,
 * and emits alerts.
 *
 * Runs as a continuous loop:
 *   1. Fetch latest block
 *   2. If new block since last check → scan its transactions
 *   3. For each tx above threshold → enrich and emit alert
 *   4. Sleep until next poll
 *
 * Alerts go to stdout as JSON (piped to formatter/poster downstream).
 */
require('dotenv').config();
const { api, rateLimited } = require('./blockfrost');
const { formatAlert } = require('./formatter');
const fs = require('fs');
const path = require('path');

// === CONFIG ===
const POLL_INTERVAL = 30_000;         // 30 seconds between block checks
const ADA_THRESHOLD = 5_000_000;      // Alert on movements >= 5M ADA
const WHALE_THRESHOLD = 10_000_000;   // WHALE classification >= 10M ADA
const STATE_FILE = path.join(__dirname, '..', 'watcher-state.json');

// === STATE ===
let lastBlockHash = null;
let lastBlockHeight = 0;
let alertCount = 0;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      lastBlockHash = state.lastBlockHash;
      lastBlockHeight = state.lastBlockHeight || 0;
      alertCount = state.alertCount || 0;
      log(`Resumed from block ${lastBlockHeight}`);
    }
  } catch (e) {
    log('Fresh start (no state file)');
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    lastBlockHash,
    lastBlockHeight,
    alertCount,
    lastUpdate: new Date().toISOString()
  }, null, 2));
}

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// === CORE LOGIC ===

/**
 * Fetch latest block and check if it's new.
 * Returns the block if new, null if we've already processed it.
 */
async function checkForNewBlock() {
  const block = await rateLimited(() => api.blocksLatest());
  if (block.hash === lastBlockHash) return null;
  return block;
}

/**
 * Get all transactions in a block and filter by ADA threshold.
 * Returns enriched transaction objects.
 */
async function scanBlock(block) {
  const alerts = [];

  // Blocks can have many txs — paginate
  let page = 1;
  while (true) {
    let txHashes;
    try {
      txHashes = await rateLimited(() =>
        api.blocksTxs(block.hash, { page, count: 100 })
      );
    } catch (e) {
      if (e.status_code === 404) break;
      throw e;
    }

    if (!txHashes || txHashes.length === 0) break;

    for (const txHash of txHashes) {
      const alert = await analyzeTx(txHash, block);
      if (alert) alerts.push(alert);
    }

    if (txHashes.length < 100) break;
    page++;
  }

  return alerts;
}

/**
 * Analyze a single transaction. Returns an alert object if it exceeds
 * the ADA threshold, null otherwise.
 */
async function analyzeTx(txHash, block) {
  const utxos = await rateLimited(() => api.txsUtxos(txHash));
  if (!utxos) return null;

  // Calculate total ADA moved (sum of outputs, minus change)
  const inputAddrs = new Set(utxos.inputs.map(i => i.address));

  let totalMoved = 0;
  let selfReturn = 0;
  const destinations = [];

  for (const out of utxos.outputs) {
    const lovelace = out.amount.find(a => a.unit === 'lovelace');
    const ada = lovelace ? Math.floor(Number(lovelace.quantity) / 1_000_000) : 0;

    if (inputAddrs.has(out.address)) {
      selfReturn += ada;
    } else {
      totalMoved += ada;
      destinations.push({
        address: out.address,
        ada,
        isScript: out.address.startsWith('addr1w') || out.address.startsWith('addr1z'),
        isByron: out.address.startsWith('Ae2') || out.address.startsWith('Ddz')
      });
    }
  }

  if (totalMoved < ADA_THRESHOLD) return null;

  // Enrich: resolve stakekeys for top destinations
  const enriched = [];
  // Only resolve top 5 to keep API usage reasonable
  const topDests = destinations.sort((a, b) => b.ada - a.ada).slice(0, 5);

  for (const dest of topDests) {
    if (dest.isScript || dest.isByron) {
      enriched.push(dest);
      continue;
    }

    try {
      const addrInfo = await rateLimited(() => api.addresses(dest.address));
      dest.stakeAddress = addrInfo.stake_address || null;

      if (dest.stakeAddress) {
        try {
          const account = await rateLimited(() => api.accounts(dest.stakeAddress));
          dest.pool = account.pool_id || null;
          dest.drep = account.drep_id || null;
          dest.controlledAda = Math.floor(Number(account.controlled_amount) / 1_000_000);
        } catch (e) { /* non-staked address */ }
      }
    } catch (e) { /* address lookup failed */ }

    enriched.push(dest);
  }

  // Classify the sender(s)
  const senderStakes = new Set();
  for (const inp of utxos.inputs) {
    try {
      const addrInfo = await rateLimited(() => api.addresses(inp.address));
      if (addrInfo.stake_address) senderStakes.add(addrInfo.stake_address);
    } catch (e) { /* skip */ }
    if (senderStakes.size >= 3) break; // Don't resolve too many
  }

  return {
    type: totalMoved >= WHALE_THRESHOLD ? 'WHALE_ALERT' : 'LARGE_TX',
    txHash,
    blockHeight: block.height,
    blockTime: block.time,
    totalMoved,
    destinationCount: destinations.length,
    topDestinations: enriched,
    senderStakeKeys: [...senderStakes],
    timestamp: new Date().toISOString()
  };
}

// === MAIN LOOP ===

async function run() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   CARDANO WATCHERS — Chain Watcher                      ║');
  console.log('║   Cardano, we\'re watching.                                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Threshold: ${(ADA_THRESHOLD/1_000_000).toFixed(0)}M ADA`);
  console.log(`  Whale:     ${WHALE_THRESHOLD.toLocaleString()} ADA`);
  console.log(`  Poll:      ${POLL_INTERVAL / 1000}s`);
  console.log('');

  loadState();

  // Test mode: scan last 3 blocks and exit
  if (process.argv.includes('--test')) {
    log('TEST MODE: scanning last 3 blocks');
    const latest = await rateLimited(() => api.blocksLatest());
    let blockHash = latest.hash;

    for (let i = 0; i < 3; i++) {
      const block = await rateLimited(() => api.blocks(blockHash));
      log(`Scanning block ${block.height} (${block.tx_count} txs)`);
      const alerts = await scanBlock(block);

      for (const alert of alerts) {
        console.log('\n' + formatAlert(alert));
      }

      if (alerts.length === 0) log('  No movements above threshold');

      // Get previous block
      blockHash = block.previous_block;
    }

    log('TEST COMPLETE');
    return;
  }

  // Production loop
  while (true) {
    try {
      const block = await checkForNewBlock();

      if (block) {
        const blocksSkipped = lastBlockHeight > 0 ? block.height - lastBlockHeight - 1 : 0;
        if (blocksSkipped > 0) {
          log(`Skipped ${blocksSkipped} blocks (catching up)`);
        }

        log(`New block ${block.height} | ${block.tx_count} txs | slot ${block.slot}`);

        if (block.tx_count > 0) {
          const alerts = await scanBlock(block);

          for (const alert of alerts) {
            alertCount++;
            alert.alertId = alertCount;

            // Output formatted alert
            console.log('\n' + formatAlert(alert));

            // Also write raw JSON for downstream consumers
            const alertFile = path.join(__dirname, '..', 'alerts', `alert-${alertCount}.json`);
            const alertDir = path.dirname(alertFile);
            if (!fs.existsSync(alertDir)) fs.mkdirSync(alertDir, { recursive: true });
            fs.writeFileSync(alertFile, JSON.stringify(alert, null, 2));
          }
        }

        lastBlockHash = block.hash;
        lastBlockHeight = block.height;
        saveState();
      }
    } catch (err) {
      log(`ERROR: ${err.message}`);
      // Don't crash on transient errors — just wait and retry
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

/**
 * Update internal state after processing a block.
 * Call this from the orchestrator after scanning.
 */
function updateState(block) {
  lastBlockHash = block.hash;
  lastBlockHeight = block.height;
}

// Export for orchestrator use
module.exports = {
  checkForNewBlock,
  scanBlock,
  analyzeTx,
  loadState,
  saveState,
  updateState,
  ADA_THRESHOLD,
  WHALE_THRESHOLD
};

// Run standalone if called directly
if (require.main === module) {
  run().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
