/**
 * Shared Blockfrost client for the agent.
 * Rate-limited to ~9.5 req/s (105ms between calls).
 */
require('dotenv').config();
const { BlockFrostAPI } = require('@blockfrost/blockfrost-js');

const api = new BlockFrostAPI({
  projectId: process.env.BLOCKFROST_API_KEY
});

let lastCall = 0;
const MIN_DELAY = 105;

async function rateLimited(fn) {
  const now = Date.now();
  const wait = MIN_DELAY - (now - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}

/**
 * Raw fetch for governance endpoints (SDK v6 doesn't have these yet).
 * Handles rate limiting same as SDK calls.
 */
async function govFetch(path) {
  const now = Date.now();
  const wait = MIN_DELAY - (now - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();

  const res = await fetch(`https://cardano-mainnet.blockfrost.io/api/v0${path}`, {
    headers: { 'project_id': process.env.BLOCKFROST_API_KEY }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Blockfrost ${res.status}: ${path} — ${body}`);
  }
  return res.json();
}

module.exports = { api, rateLimited, govFetch };
