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

async function getAllDelegations(sk) {
  let all = [];
  let page = 1;
  while (true) {
    const data = await bf(`/accounts/${sk}/delegations?count=100&page=${page}&order=asc`);
    if (!Array.isArray(data) || data.length === 0) break;
    all = all.concat(data);
    if (data.length < 100) break;
    page++;
    await new Promise(r => setTimeout(r, 200));
  }
  return all;
}

(async () => {
  // Get full delegation history for the big whale (pool owner)
  const bigWhale = "stake1u9f9v0z5zzlldgx58n8tklphu8mf7h4jvp2j2gddluemnssjfnkzz";
  console.log("=== FULL DELEGATION HISTORY: BIG WHALE (38.4M ADA, MIN pool owner) ===\n");
  
  const hist = await getAllDelegations(bigWhale);
  console.log("Total delegation events:", hist.length);
  
  const poolCounts = {};
  for (const d of hist) {
    poolCounts[d.pool_id] = (poolCounts[d.pool_id] || 0) + 1;
    console.log("  Epoch", d.active_epoch, "->", d.pool_id);
  }
  
  console.log("\nPool delegation counts:");
  for (const [p, c] of Object.entries(poolCounts)) {
    console.log(" ", p, ":", c, "times");
  }
  
  // Get all delegations for whale #2 and #3 (both on SMILE)
  console.log("\n=== DELEGATION HISTORY: WHALE #2 (2.2M ADA) ===\n");
  const w2 = await getAllDelegations("stake179penqfa4kgmk799avtuyml4ppftcawnlfakaxhgwgevesggrke2g");
  console.log("Total events:", w2.length);
  for (const d of w2) {
    console.log("  Epoch", d.active_epoch, "->", d.pool_id);
  }
  
  console.log("\n=== DELEGATION HISTORY: WHALE #3 (4.6M ADA) ===\n");
  const w3 = await getAllDelegations("stake1ux7ppl339txknchp9j7zejs94g8yxt3aaejat22fsdzwf2ssw6paf");
  console.log("Total events:", w3.length);
  for (const d of w3) {
    console.log("  Epoch", d.active_epoch, "->", d.pool_id);
  }
  
  console.log("\nDone.");
})();
