/**
 * DETECTORS — Specialized chain event detectors
 *
 * Each detector watches for a specific type of on-chain activity:
 *   - Large ADA movements (handled by watcher.js)
 *   - Stake delegation changes (pool switches)
 *   - DRep delegation changes (governance shifts)
 *   - Smart contract interactions (DEX trades, lending)
 *   - Token movements (NFT + FT whale moves)
 *   - New stake pool registrations
 */
const { api, rateLimited } = require('./blockfrost');
const { formatAda } = require('./formatter');

/**
 * Detect governance-relevant events in a block's transactions.
 * Looks for: DRep delegations, stake registrations, pool changes.
 */
async function detectGovernanceEvents(block) {
  const events = [];
  let page = 1;

  while (true) {
    let txHashes;
    try {
      txHashes = await rateLimited(() =>
        api.blocksTxs(block.hash, { page, count: 100 })
      );
    } catch (e) {
      break;
    }
    if (!txHashes || txHashes.length === 0) break;

    for (const txHash of txHashes) {
      try {
        const tx = await rateLimited(() => api.txs(txHash));

        // Check for delegation certificates
        if (tx.delegation_count > 0) {
          const delegations = await rateLimited(() => api.txsDelegations(txHash));
          for (const d of delegations) {
            events.push({
              type: 'DELEGATION_CHANGE',
              txHash,
              blockHeight: block.height,
              stakeAddress: d.address,
              pool: d.pool_id,
              activeEpoch: d.active_epoch,
              timestamp: new Date(block.time * 1000).toISOString()
            });
          }
        }

        // Check for stake registrations/deregistrations
        if (tx.stake_cert_count > 0) {
          const certs = await rateLimited(() => api.txsStakes(txHash));
          for (const c of certs) {
            events.push({
              type: c.registration ? 'STAKE_REGISTRATION' : 'STAKE_DEREGISTRATION',
              txHash,
              blockHeight: block.height,
              stakeAddress: c.address,
              timestamp: new Date(block.time * 1000).toISOString()
            });
          }
        }

        // Check for pool registrations/updates
        if (tx.pool_update_count > 0) {
          events.push({
            type: 'POOL_UPDATE',
            txHash,
            blockHeight: block.height,
            timestamp: new Date(block.time * 1000).toISOString()
          });
        }

        // Check for pool retirements
        if (tx.pool_retire_count > 0) {
          events.push({
            type: 'POOL_RETIREMENT',
            txHash,
            blockHeight: block.height,
            timestamp: new Date(block.time * 1000).toISOString()
          });
        }

      } catch (e) {
        // Skip txs that error
        continue;
      }
    }

    if (txHashes.length < 100) break;
    page++;
  }

  return events;
}

/**
 * Detect large token movements in a transaction.
 * Returns events for NFT transfers and large fungible token moves.
 */
async function detectTokenEvents(txHash, block) {
  const events = [];

  try {
    const utxos = await rateLimited(() => api.txsUtxos(txHash));

    // Collect all non-ADA tokens in outputs
    const tokenOutputs = new Map();
    for (const out of utxos.outputs) {
      for (const amt of out.amount) {
        if (amt.unit === 'lovelace') continue;

        const qty = Number(amt.quantity);
        if (!tokenOutputs.has(amt.unit)) {
          tokenOutputs.set(amt.unit, { unit: amt.unit, totalQty: 0, addresses: [] });
        }
        const entry = tokenOutputs.get(amt.unit);
        entry.totalQty += qty;
        entry.addresses.push(out.address);
      }
    }

    // Flag NFTs (quantity = 1) and large token moves
    for (const [unit, data] of tokenOutputs) {
      if (data.totalQty === 1) {
        // NFT transfer — only flag if we want NFT tracking
        // events.push({ type: 'NFT_TRANSFER', ... });
      } else if (data.totalQty > 1_000_000) {
        events.push({
          type: 'LARGE_TOKEN_MOVE',
          txHash,
          blockHeight: block.height,
          policyId: unit.substring(0, 56),
          assetName: unit.substring(56),
          quantity: data.totalQty,
          destinationCount: data.addresses.length,
          timestamp: new Date(block.time * 1000).toISOString()
        });
      }
    }
  } catch (e) {
    // Skip on error
  }

  return events;
}

/**
 * Check if a specific stakekey changed its DRep delegation.
 * Useful for monitoring known genesis-linked keys.
 */
async function checkDrepChange(stakeKey, knownDrep) {
  try {
    const account = await rateLimited(() => api.accounts(stakeKey));
    const currentDrep = account.drep_id || null;

    if (currentDrep !== knownDrep) {
      return {
        type: 'DREP_CHANGE',
        stakeKey,
        previousDrep: knownDrep,
        currentDrep,
        controlledAda: Math.floor(Number(account.controlled_amount) / 1_000_000),
        timestamp: new Date().toISOString()
      };
    }
  } catch (e) {
    // Account lookup failed
  }

  return null;
}

/**
 * Monitor a list of watched addresses for any activity.
 * Returns events for any new transactions.
 */
async function checkWatchedAddresses(watchList, lastKnownTxCounts) {
  const events = [];

  for (const entry of watchList) {
    try {
      const info = await rateLimited(() => api.addresses(entry.address));
      const prevCount = lastKnownTxCounts.get(entry.address) || 0;

      if (info.tx_count > prevCount) {
        const newTxCount = info.tx_count - prevCount;

        // Get the new transactions
        const txs = await rateLimited(() =>
          api.addressesTransactions(entry.address, { count: newTxCount, order: 'desc' })
        );

        for (const tx of txs) {
          events.push({
            type: 'WATCHED_ADDRESS_ACTIVITY',
            address: entry.address,
            label: entry.label,
            txHash: tx.tx_hash,
            blockHeight: tx.block_height,
            timestamp: new Date().toISOString()
          });
        }

        lastKnownTxCounts.set(entry.address, info.tx_count);
      }
    } catch (e) {
      continue;
    }
  }

  return events;
}

module.exports = {
  detectGovernanceEvents,
  detectTokenEvents,
  checkDrepChange,
  checkWatchedAddresses
};
