/**
 * REPO MONITOR — Watches the CardanoWatchers GitHub repos for updates
 *
 * Polls GitHub API for new commits to:
 *   - Cardano-Watch-Tower/watchers (investigations + findings)
 *   - Cardano-Watch-Tower/agent (bot code updates)
 *
 * When new commits are found, generates tweet via Grok about the update.
 * Uses GitHub's public API (no auth needed, 60 req/hour limit).
 */
const { chat } = require('./brain');

const REPOS = [
  { owner: 'Cardano-Watch-Tower', repo: 'watchers', label: 'investigations' },
  { owner: 'Cardano-Watch-Tower', repo: 'agent', label: 'agent' }
];

const GITHUB_API = 'https://api.github.com';

// Track last seen commit per repo
const lastSeen = new Map();

/**
 * Check all repos for new commits.
 * Returns array of { repo, label, commits[] } for repos with new activity.
 */
async function checkRepos() {
  const updates = [];

  for (const { owner, repo, label } of REPOS) {
    try {
      const url = `${GITHUB_API}/repos/${owner}/${repo}/commits?per_page=5`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });

      if (!response.ok) continue;

      const commits = await response.json();
      if (!commits.length) continue;

      const latestSha = commits[0].sha;
      const prevSha = lastSeen.get(`${owner}/${repo}`);

      if (prevSha && prevSha !== latestSha) {
        // Find new commits since last check
        const newCommits = [];
        for (const c of commits) {
          if (c.sha === prevSha) break;
          newCommits.push({
            sha: c.sha.substring(0, 7),
            message: c.commit.message.split('\n')[0], // First line only
            author: c.commit.author.name,
            date: c.commit.author.date
          });
        }

        if (newCommits.length > 0) {
          updates.push({ owner, repo, label, commits: newCommits });
        }
      }

      lastSeen.set(`${owner}/${repo}`, latestSha);
    } catch (e) {
      // Skip on error
    }
  }

  return updates;
}

/**
 * Generate a tweet about repo updates.
 */
async function composeUpdateTweet(update) {
  const commitSummary = update.commits
    .map(c => `- ${c.message} (${c.sha})`)
    .join('\n');

  const prompt = `CardanoWatchers just pushed updates to the ${update.label} repository (${update.owner}/${update.repo}).

Recent commits:
${commitSummary}

Write a tweet announcing this update. Be brief, direct. If the commits mention investigation findings or new data, highlight that. If it's code updates, mention what capability was added. Under 280 chars. Include the GitHub URL: github.com/${update.owner}/${update.repo}

Reply with ONLY the tweet text.`;

  return await chat([{ role: 'user', content: prompt }], { temperature: 0.7 });
}

/**
 * Initialize last-seen state (call on startup to avoid
 * tweeting about old commits on first run).
 */
async function initialize() {
  for (const { owner, repo } of REPOS) {
    try {
      const url = `${GITHUB_API}/repos/${owner}/${repo}/commits?per_page=1`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });

      if (!response.ok) continue;

      const commits = await response.json();
      if (commits.length > 0) {
        lastSeen.set(`${owner}/${repo}`, commits[0].sha);
      }
    } catch (e) {
      // Skip
    }
  }

  console.log(`📂 Repo monitor initialized — tracking ${lastSeen.size} repos`);
}

module.exports = { checkRepos, composeUpdateTweet, initialize };
