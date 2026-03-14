require("dotenv").config();
const https = require("https");

const API_KEY = process.env.BLOCKFROST_KEY || "mainnetehvvvJVoJUAz5DFJJz2L9fHZmkXlXTMP";

const STAKEKEYS = [
  "stake1u9f9v0z5zzlldgx58n8tklphu8mf7h4jvp2j2gddluemnssjfnkzz",
  "stake179penqfa4kgmk799avtuyml4ppftcawnlfakaxhgwgevesggrke2g",
  "stake1ux7ppl339txknchp9j7zejs94g8yxt3aaejat22fsdzwf2ssw6paf",
  "stake1uy22xxwr0436nhxrmr626yp4y4xyqnvqy5kzvrtr3ls9d6gc3y95z",
  "stake1uxuqr63t8nya7ny4efpdj54q2d77twlfvpkefrjumngunrst8tgtg"
];

function bf(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "cardano-mainnet.blockfrost.io",
      path: `/api/v0${path}`,
      headers: { project_id: API_KEY }
    };
    https.get(opts, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error(d)); }
      });
    }).on("error", reject);
  });
}

(async () => {
  console.log("=== DELEGATION & POOL DATA ===\n");
  
  const poolsSeen = new Set();
  
  for (const sk of STAKEKEYS) {
    console.log("--- STAKEKEY:", sk.slice(0,20) + "..." + sk.slice(-8));
    
    // Get account info (current delegation, rewards, etc)
    const acct = await bf(`/accounts/${sk}`);
    console.log("  Active:", acct.active);
    console.log("  Balance:", (parseInt(acct.controlled_amount || 0) / 1e6).toLocaleString(), "ADA");
    console.log("  Rewards:", (parseInt(acct.rewards_sum || 0) / 1e6).toLocaleString(), "ADA");
    console.log("  Delegated to pool:", acct.pool_id || "NONE");
    
    if (acct.pool_id) poolsSeen.add(acct.pool_id);
    
    // Get delegation history (last 10)
    const hist = await bf(`/accounts/${sk}/delegations?count=10&order=desc`);
    if (Array.isArray(hist) && hist.length > 0) {
      console.log("  Recent delegations:");
      for (const d of hist) {
        console.log("    Epoch", d.active_epoch, "->", d.pool_id);
        poolsSeen.add(d.pool_id);
      }
    }
    console.log("");
    
    // Rate limit respect
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Now get pool details for all pools seen
  console.log("\n=== POOL DETAILS ===\n");
  
  for (const poolId of poolsSeen) {
    const pool = await bf(`/pools/${poolId}`);
    const meta = await bf(`/pools/${poolId}/metadata`).catch(() => null);
    
    console.log("--- POOL:", poolId);
    console.log("  Ticker:", meta?.ticker || "N/A");
    console.log("  Name:", meta?.name || "N/A");
    console.log("  Live Stake:", (parseInt(pool.live_stake || 0) / 1e6).toLocaleString(), "ADA");
    console.log("  Live Delegators:", pool.live_delegators);
    console.log("  Blocks Minted:", pool.blocks_minted);
    console.log("  Margin:", (parseFloat(pool.margin_cost || 0) * 100).toFixed(2) + "%");
    console.log("  Fixed Cost:", (parseInt(pool.fixed_cost || 0) / 1e6).toLocaleString(), "ADA");
    console.log("  Owners:", pool.owners?.join(", ") || "N/A");
    console.log("  Retired:", pool.retired || false);
    console.log("");
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Check if any whale stakekeys own pools (cross-reference owners)
  console.log("\n=== CROSS-REFERENCE: WHALE STAKEKEYS vs POOL OWNERS ===\n");
  
  for (const poolId of poolsSeen) {
    const pool = await bf(`/pools/${poolId}`);
    if (pool.owners) {
      for (const owner of pool.owners) {
        if (STAKEKEYS.includes(owner)) {
          console.log("MATCH\! Pool", poolId, "is owned by whale stakekey", owner);
        }
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  
  console.log("\nDone.");
})();
