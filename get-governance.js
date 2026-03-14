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

const STAKEKEYS = [
  { name: "Whale #1 (38.4M)", key: "stake1u9f9v0z5zzlldgx58n8tklphu8mf7h4jvp2j2gddluemnssjfnkzz" },
  { name: "Whale #2 (2.2M)", key: "stake179penqfa4kgmk799avtuyml4ppftcawnlfakaxhgwgevesggrke2g" },
  { name: "Whale #3 (4.6M)", key: "stake1ux7ppl339txknchp9j7zejs94g8yxt3aaejat22fsdzwf2ssw6paf" },
  { name: "Whale #4 (772K)", key: "stake1uy22xxwr0436nhxrmr626yp4y4xyqnvqy5kzvrtr3ls9d6gc3y95z" },
  { name: "Whale #5 (1.7M)", key: "stake1uxuqr63t8nya7ny4efpdj54q2d77twlfvpkefrjumngunrst8tgtg" }
];

const POOLS = [
  { name: "MIN (Minswap)", id: "pool1ases3nklh6gyjf74r7dqm89exjfd520z9cefqru959wcccmrdlk" },
  { name: "SMILE", id: "pool1ea34czsr90yc63fmv4gj4tetp7ds7c4jhpj6vqg4yw40wvygdl3" },
  { name: "PPTG1", id: "pool1lu2luhmkyayq9njh848kfknn6evwzmn3gzsxar7z3sttg7grxcm" },
  { name: "WRM01", id: "pool19m547w9wkcqm5hcstz67fly4ucz0zsp3dqv4n956xyusy4dlpue" }
];

(async () => {
  // Check DRep delegations for each whale
  console.log("=== DREP DELEGATIONS ===\n");
  for (const w of STAKEKEYS) {
    const acct = await bf(`/accounts/${w.key}`);
    console.log(w.name + ":");
    console.log("  DRep ID:", acct.drep_id || "NONE");
    console.log("");
    await new Promise(r => setTimeout(r, 200));
  }

  // Check pool voting history
  console.log("\n=== POOL GOVERNANCE VOTES ===\n");
  for (const p of POOLS) {
    console.log(p.name + " (" + p.id.slice(0,20) + "...):");
    try {
      const votes = await bf(`/governance/pools/${p.id}/votes?count=10&order=desc`);
      if (Array.isArray(votes) && votes.length > 0) {
        console.log("  Recent votes:", votes.length);
        for (const v of votes.slice(0, 5)) {
          console.log("    Action:", v.tx_hash ? v.tx_hash.slice(0,16) + "..." : "N/A", "Vote:", v.vote);
        }
      } else if (votes.status_code === 404) {
        console.log("  No votes found");
      } else {
        console.log("  Response:", JSON.stringify(votes).slice(0, 200));
      }
    } catch(e) {
      console.log("  Error:", e.message.slice(0, 100));
    }
    console.log("");
    await new Promise(r => setTimeout(r, 200));
  }

  // Get network-level SPO voting stats
  console.log("\n=== GOVERNANCE PARAMETERS ===\n");
  try {
    const params = await bf("/epochs/latest/parameters");
    console.log("Current epoch:", params.epoch);
    console.log("Pool voting threshold (gov actions):", params.pool_voting_thresholds || "N/A");
    console.log("DRep voting threshold:", params.drep_voting_thresholds || "N/A");
  } catch(e) {
    console.log("Error:", e.message.slice(0, 100));
  }

  console.log("\nDone.");
})();
