require("dotenv").config();
const https = require("https");

const API_KEY = process.env.BLOCKFROST_KEY || "mainnetehvvvJVoJUAz5DFJJz2L9fHZmkXlXTMP";

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

// Top delegators to Emurgo DRep
const TOP_DELEGATORS = [
  { addr: "stake1uyjcwe7lqxgan0lf5hwlx9nq0ajc3dv4cy9ymtrqh8nvx2s98rukg", ada: 58818841 },
  { addr: "stake1u820ljmthp8al8hqnf5fu7aujadt9frcg8dvmlehn45fj9qltf9zz", ada: 52216989 },
  { addr: "stake1u9mmtpa0w89ltyz4pkywaamsrexe7awlc7uymth58u8klmswzu0h2", ada: 44820977 },
  { addr: "stake1uycagy7tsuqztar72tufexak6n0l0622ugr9jzxy8xhespcvjhxs4", ada: 40023146 },
  { addr: "stake1u9xjfhrz5vmeutgxw7sh4hnsq7dashgsd7yf8455cucr4rgyjwckx", ada: 31503831 },
  { addr: "stake1u9zvudxnx88m07htsmd27uq9kscln9e2vgtesx3xecllrlq9qqrny", ada: 22151178 }
];

(async () => {
  console.log("=== CHECKING TOP EMURGO DREP DELEGATORS ===\n");
  
  for (const d of TOP_DELEGATORS) {
    console.log("--- " + d.addr.slice(0,25) + "... (" + d.ada.toLocaleString() + " ADA)");
    
    const acct = await bf(`/accounts/${d.addr}`);
    console.log("  Pool:", acct.pool_id || "NONE");
    console.log("  Rewards:", (parseInt(acct.rewards_sum || 0) / 1e6).toLocaleString(), "ADA");
    console.log("  Withdrawals:", (parseInt(acct.withdrawals_sum || 0) / 1e6).toLocaleString(), "ADA");
    
    // Check delegation history - first delegation epoch indicates if genesis-era
    const hist = await bf(`/accounts/${d.addr}/delegations?count=5&order=asc`);
    if (Array.isArray(hist) && hist.length > 0) {
      const firstEpoch = hist[0].active_epoch;
      console.log("  First delegation epoch:", firstEpoch, firstEpoch <= 10 ? "*** GENESIS ERA ***" : firstEpoch <= 100 ? "(early era)" : "");
      console.log("  First pool:", hist[0].pool_id);
    }
    
    // Check registration history
    const regs = await bf(`/accounts/${d.addr}/registrations?count=5&order=asc`);
    if (Array.isArray(regs) && regs.length > 0) {
      // Get the tx of first registration to check its epoch
      const firstTx = regs[0].tx_hash;
      const txInfo = await bf(`/txs/${firstTx}`);
      console.log("  First registration: block", txInfo.block_height, "epoch", txInfo.epoch || "N/A");
      if (txInfo.epoch !== undefined && txInfo.epoch <= 10) {
        console.log("  *** CONFIRMED GENESIS ERA REGISTRATION ***");
      }
    }
    
    // Check pool details if delegated
    if (acct.pool_id) {
      const pool = await bf(`/pools/${acct.pool_id}`);
      const meta = await bf(`/pools/${acct.pool_id}/metadata`).catch(() => null);
      console.log("  Pool ticker:", meta?.ticker || "N/A");
      console.log("  Pool name:", meta?.name || "N/A");
      console.log("  Pool margin:", (parseFloat(pool.margin_cost || 0) * 100).toFixed(1) + "%");
      
      // Check if this stakekey owns the pool
      if (pool.owners && pool.owners.includes(d.addr)) {
        console.log("  *** OWNS THIS POOL ***");
      }
    }
    
    console.log("");
    await new Promise(r => setTimeout(r, 300));
  }
  
  console.log("Done.");
})();
