# Genesis Research Brief — Quick Reference
**Updated:** March 9, 2026 | **Source:** Blockfrost API, on-chain verified

---

## The Big Numbers

- **122 connected chains** traced from genesis block zero
- **14.8B ADA** tracked through UTXO paths
- **2.63B ADA** currently held across traced endpoints
- **4,322 stake keys** identified in genesis fund flows

## Genesis Development Pool (5.185B ADA)

| Entity | Share | ADA | Status |
|--------|-------|-----|--------|
| IOHK / Input Output | 48% | 2.46B | 44M ADA "black hole" — inactive, no governance |
| Emurgo | 40% | 2.07B | Circular DRep delegation back to own entity |
| Cardano Foundation | 12% | 648M | Untraceable within search depth |

## Governance Breakdown (of 2.63B currently held)

| Category | ADA | % | What It Means |
|----------|-----|---|---------------|
| No governance | ~2.08B | 79.0% | Pool staking only, zero DRep |
| Always abstain | ~423M | 16.1% | Coordinated abstention (treasury) |
| Emurgo DRep | ~123M | 4.7% | Circular — genesis funds → Emurgo DRep |
| No confidence | ~8M | 0.3% | Single whale, permanent opposition |
| Independent DRep | 0 | 0% | Zero genesis ADA to community DReps |

## The Circular Governance Loop (KEY FINDING)

**Chain:** Genesis allocation → Byron cascades → Shelley endpoints → Emurgo DRep → Emurgo votes

- Emurgo DRep ID: `drep1ytvlwvyjmzfyn56n0zz4f6lj94wxhmsl5zky6knnzrf4jygpyahug`
- Total voting power: **297.6M ADA** (402 delegators)
- Genesis-traceable: **91.8M ADA (30.8%)** of that voting power
- Emurgo DRep = **5.11% of total Cardano voting power**
- Top 6 delegators hold 249.5M ADA — 4 of 6 registered exactly at epoch 550 (Conway launch)
- Multiple delegators use Moonstake pools (MS4, MS5, MS6) — Emurgo-affiliated staking service

## Voucher Sale Whales (5 tracked stakekeys, 47.6M ADA)

| # | ADA | Pool | Key Finding |
|---|-----|------|-------------|
| 1 | 38.4M | MIN (Minswap) | **OWNS pool, 100% margin, self-delegates** |
| 2 | 2.2M | SMILE | Delegator, epoch 486 |
| 3 | 4.6M | SMILE | Delegator, epoch 538 |
| 4 | 772K | PPTG1 | Switched from P2P, epoch 597 |
| 5 | 1.7M | WRM01 (WingRiders) | Delegator, epoch 550 |

### Whale #1 Self-Dealing Pool (MIN/Minswap)
- **100% margin** — all staking rewards go to operator
- **6.27M ADA** lifetime rewards extracted
- **12,446 blocks** minted
- **95 other delegators get ZERO rewards**
- **SPO voting power:** 39.2M ADA backing
- Owner stakekey: `stake1u9f9v0z5zzlldgx58n8tklphu8mf7h4jvp2j2gddluemnssjfnkzz`

### All 5 whales: DRep = always_abstain
- They abstain from DRep governance personally
- But their delegated stake gives pool operators SPO voting power
- Whale #1 IS the pool operator — votes as SPO with 39.2M ADA backing

## Treasury "Abstain Army"

- **422M ADA** in coordinated `always_abstain` delegation
- Systematically splits 32M ADA lots across 11+ separate stake keys
- Each key delegates to a different pool
- All set to `drep_always_abstain`
- If this ever changed its vote, it would shift governance outcomes

## IOHK 44M ADA Black Hole

- Stake key: `stake1u833p40y8cm07ra9wgrqgp70z6khc5pttrena97c6en6p8c7pzxda`
- **44.5M ADA** controlled, 500+ addresses
- Account: **inactive**
- Pool: **none**, DRep: **none**
- Earns nothing, governs nothing, just sits

## Stakekey Verification Links

1. https://cardanoscan.io/stakekey/stake1u9f9v0z5zzlldgx58n8tklphu8mf7h4jvp2j2gddluemnssjfnkzz
2. https://cardanoscan.io/stakekey/stake179penqfa4kgmk799avtuyml4ppftcawnlfakaxhgwgevesggrke2g
3. https://cardanoscan.io/stakekey/stake1ux7ppl339txknchp9j7zejs94g8yxt3aaejat22fsdzwf2ssw6paf
4. https://cardanoscan.io/stakekey/stake1uy22xxwr0436nhxrmr626yp4y4xyqnvqy5kzvrtr3ls9d6gc3y95z
5. https://cardanoscan.io/stakekey/stake1uxuqr63t8nya7ny4efpdj54q2d77twlfvpkefrjumngunrst8tgtg

## Key Pool Details

| Pool | Ticker | Stake | Margin | Blocks | Notes |
|------|--------|-------|--------|--------|-------|
| pool1ases3...mrdlk | MIN | 39.2M | 100% | 12,446 | Owned by Whale #1 |
| pool1ea34c...ygdl3 | SMILE | 7.6M | 3% | 1,917 | Whales #2+#3 here |
| pool1lu2lu...rxcm | PPTG1 | 64M | 4% | 875 | Whale #4 |
| pool19m547...lpue | WRM01 | 4.1M | 1% | 893 | Whale #5 |

## Data Sources

- Blockfrost Mainnet API (real-time on-chain)
- Mainnet Byron Genesis JSON
- Full investigation: `data/investigations/genesis-trace/`
- Tools: `data/investigations/genesis-trace/tools/` (10+ trace scripts)
- GitHub: https://github.com/Cardano-Watch-Tower/watchers/tree/main/investigations/genesis-trace
