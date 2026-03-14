/**
 * DETECTIVE — Hireable on-chain investigation service
 *
 * Flow:
 *   1. User tags @CardanoWatchers with a request
 *   2. Brain assesses complexity and generates quote
 *   3. Bot replies with quote and payment address
 *   4. User pays → bot detects payment on-chain
 *   5. Investigation begins automatically
 *   6. Results posted as thread + saved to GitHub
 *
 * Job types:
 *   - TRACE: Follow money through the chain
 *   - PROFILE: Full analysis of an address/stakekey
 *   - MONITOR: Watch an address for activity (ongoing)
 *   - GOVERNANCE: Check governance participation of funds
 */
const fs = require('fs');
const path = require('path');
const { investigate, formatReport } = require('./investigator');
const { assessJob, chat } = require('./brain');

const JOBS_DIR = path.join(__dirname, '..', 'jobs');

// Job states
const STATES = {
  QUOTED: 'QUOTED',         // Quote sent, awaiting payment
  PAID: 'PAID',             // Payment detected, investigation starting
  IN_PROGRESS: 'IN_PROGRESS', // Investigation running
  COMPLETE: 'COMPLETE',     // Results delivered
  EXPIRED: 'EXPIRED',       // Quote expired (24h)
  CANCELLED: 'CANCELLED'    // User cancelled or refunded
};

function ensureJobsDir() {
  if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });
}

function saveJob(job) {
  ensureJobsDir();
  const fp = path.join(JOBS_DIR, `job-${job.id}.json`);
  fs.writeFileSync(fp, JSON.stringify(job, null, 2));
}

function loadJob(jobId) {
  const fp = path.join(JOBS_DIR, `job-${jobId}.json`);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function listJobs(state = null) {
  ensureJobsDir();
  const files = fs.readdirSync(JOBS_DIR).filter(f => f.startsWith('job-'));
  const jobs = files.map(f => JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8')));
  if (state) return jobs.filter(j => j.state === state);
  return jobs;
}

/**
 * Create a new job from a user request.
 * Returns the job object with quote.
 */
async function createJob(userMessage, userId) {
  const assessment = await assessJob(userMessage);

  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    state: STATES.QUOTED,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    userId,
    originalRequest: userMessage,
    assessment,
    quoteAda: assessment.quoteAda || 0,
    paymentAddress: null,  // Set when payment system is configured
    findings: null,
    deliveredAt: null
  };

  saveJob(job);
  return job;
}

/**
 * Run an investigation for a paid job.
 * This is where the actual detective work happens.
 */
async function executeJob(job) {
  job.state = STATES.IN_PROGRESS;
  job.startedAt = new Date().toISOString();
  saveJob(job);

  const findings = {
    jobId: job.id,
    request: job.originalRequest,
    results: [],
    summary: null
  };

  // Extract addresses/tx hashes from the request
  const addressPattern = /addr1[a-z0-9]{50,}/gi;
  const txPattern = /[a-f0-9]{64}/gi;
  const stakePattern = /stake1[a-z0-9]{40,}/gi;

  const addresses = job.originalRequest.match(addressPattern) || [];
  const txHashes = job.originalRequest.match(txPattern) || [];
  const stakeKeys = job.originalRequest.match(stakePattern) || [];

  // Investigate each found identifier
  for (const addr of addresses) {
    try {
      const result = await investigate(addr);
      findings.results.push({ type: 'address', query: addr, data: result });
    } catch (e) {
      findings.results.push({ type: 'address', query: addr, error: e.message });
    }
  }

  for (const tx of txHashes) {
    try {
      const result = await investigate(tx);
      findings.results.push({ type: 'tx', query: tx, data: result });
    } catch (e) {
      findings.results.push({ type: 'tx', query: tx, error: e.message });
    }
  }

  for (const sk of stakeKeys) {
    try {
      const result = await investigate(sk);
      findings.results.push({ type: 'stake', query: sk, data: result });
    } catch (e) {
      findings.results.push({ type: 'stake', query: sk, error: e.message });
    }
  }

  // Generate summary using Grok
  const summaryPrompt = `You just completed an on-chain investigation for a client. Here's what was found:

Original request: "${job.originalRequest}"

Investigation results:
${JSON.stringify(findings.results, null, 2)}

Write a professional but concise investigation report (3-5 paragraphs). Include:
1. What was investigated
2. Key findings with on-chain evidence
3. Any patterns or concerns identified
4. Conclusion

Maintain the CardanoWatchers voice — professional, direct, data-driven.`;

  try {
    findings.summary = await chat(
      [{ role: 'user', content: summaryPrompt }],
      { temperature: 0.4, maxTokens: 1000 }
    );
  } catch (e) {
    findings.summary = 'Summary generation failed. Raw data available in findings.';
  }

  job.findings = findings;
  job.state = STATES.COMPLETE;
  job.completedAt = new Date().toISOString();
  saveJob(job);

  return job;
}

/**
 * Generate the delivery message (tweet thread format).
 */
function formatDelivery(job) {
  if (!job.findings) return 'No findings available.';

  const lines = [];
  lines.push(`🔍 Investigation Complete — Job #${job.id}`);
  lines.push('');

  if (job.findings.summary) {
    lines.push(job.findings.summary);
  }

  lines.push('');
  lines.push(`Full report: github.com/Cardano-Watch-Tower/watchers/investigations`);
  lines.push(`👁️ Cardano, we're watching.`);

  return lines.join('\n');
}

module.exports = {
  createJob,
  executeJob,
  loadJob,
  listJobs,
  formatDelivery,
  STATES
};
