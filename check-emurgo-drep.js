require("dotenv").config();
const https = require("https");

const API_KEY = process.env.BLOCKFROST_KEY || "mainnetehvvvJVoJUAz5DFJJz2L9fHZmkXlXTMP";
const EMURGO_DREP = "drep1ytvlwvyjmzfyn56n0zz4f6lj94wxhmsl5zky6knnzrf4jygpyahug";

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
  // Get DRep info
  console.log("=== EMURGO DREP INFO ===\n");
  try {
    const drep = await bf(`/governance/dreps/${EMURGO_DREP}`);
    console.log("DRep ID:", EMURGO_DREP);
    console.log("Active:", drep.active);
    console.log("Amount:", (parseInt(drep.amount || 0) / 1e6).toLocaleString(), "ADA voting power");
    console.log("Has script:", drep.has_script);
    console.log("Registered epoch:", drep.registered_epoch || "N/A");
    console.log("Raw:", JSON.stringify(drep, null, 2));
  } catch(e) {
    console.log("Error getting DRep info:", e.message.slice(0, 200));
  }

  // Get DRep metadata
  console.log("\n=== DREP METADATA ===\n");
  try {
    const meta = await bf(`/governance/dreps/${EMURGO_DREP}/metadata`);
    console.log(JSON.stringify(meta, null, 2));
  } catch(e) {
    console.log("Metadata:", e.message.slice(0, 200));
  }

  // Get delegators to this DRep
  console.log("\n=== DELEGATORS TO EMURGO DREP ===\n");
  let allDelegators = [];
  let page = 1;
  while (true) {
    try {
      const dels = await bf(`/governance/dreps/${EMURGO_DREP}/delegators?count=100&page=${page}&order=desc`);
      if (!Array.isArray(dels) || dels.length === 0) break;
      allDelegators = allDelegators.concat(dels);
      if (dels.length < 100) break;
      page++;
      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.log("Error page", page, ":", e.message.slice(0, 100));
      break;
    }
  }

  console.log("Total delegators:", allDelegators.length);

  // Sort by amount descending
  allDelegators.sort((a, b) => parseInt(b.amount || 0) - parseInt(a.amount || 0));

  let totalAda = 0;
  console.log("\nTop delegators:");
  for (let i = 0; i < Math.min(allDelegators.length, 30); i++) {
    const d = allDelegators[i];
    const ada = parseInt(d.amount || 0) / 1e6;
    totalAda += ada;
    console.log(`  ${i+1}. ${d.address}  ${ada.toLocaleString()} ADA`);
  }

  // Sum all
  const grandTotal = allDelegators.reduce((s, d) => s + parseInt(d.amount || 0) / 1e6, 0);
  console.log("\nTotal ADA delegated to Emurgo DRep:", grandTotal.toLocaleString(), "ADA");

  // Check which of our 5 whale stakekeys are in the list
  const WHALES = [
    "stake1u9f9v0z5zzlldgx58n8tklphu8mf7h4jvp2j2gddluemnssjfnkzz",
    "stake179penqfa4kgmk799avtuyml4ppftcawnlfakaxhgwgevesggrke2g",
    "stake1ux7ppl339txknchp9j7zejs94g8yxt3aaejat22fsdzwf2ssw6paf",
    "stake1uy22xxwr0436nhxrmr626yp4y4xyqnvqy5kzvrtr3ls9d6gc3y95z",
    "stake1uxuqr63t8nya7ny4efpdj54q2d77twlfvpkefrjumngunrst8tgtg"
  ];

  console.log("\n=== CROSS-REFERENCE: OUR 5 WHALES ===");
  for (const w of WHALES) {
    const found = allDelegators.find(d => d.address === w);
    if (found) {
      console.log("MATCH:", w.slice(0,25) + "...", (parseInt(found.amount)/1e6).toLocaleString(), "ADA");
    }
  }

  // Check how many large delegators (>1M ADA) there are
  const bigDelegators = allDelegators.filter(d => parseInt(d.amount || 0) / 1e6 > 1000000);
  console.log("\nDelegators with >1M ADA:", bigDelegators.length);
  for (const d of bigDelegators) {
    console.log("  ", d.address, (parseInt(d.amount)/1e6).toLocaleString(), "ADA");
  }

  console.log("\nDone.");
})();
