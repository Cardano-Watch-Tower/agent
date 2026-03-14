#!/usr/bin/env node
/**
 * One-shot script: Post the genesis disruption thread as reply chain
 * to CWT's existing tweet about circular delegation data.
 *
 * Run from /home/opc/agent with watchtower stopped:
 *   node post-genesis-thread.js
 */

require('dotenv').config();
const poster = require('./src/poster');
const browser = require('./src/browser');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PARENT_TWEET = 'https://x.com/CardanoWT/status/2031017605771784398';

const tweets = [
  {
    text: 'Circular delegation data \u2014 here\'s what 122 genesis chains look like today.\n\n2.63B ADA traced from genesis addresses:\n\u2022 79% zero governance participation\n\u2022 16.1% always abstain\n\u2022 4.7% Emurgo DRep\n\u2022 0% to independent community DReps\n\n\ud83e\uddf5 (1/5)',
    imagePath: '/home/opc/agent/data/governance-breakdown.png'
  },
  {
    text: 'The Emurgo DRep circular loop:\n\nGenesis funds \u2192 Byron cascades \u2192 Shelley migration \u2192 Emurgo DRep.\n\n297.6M ADA voting power. 91.8M traces to genesis \u2014 30.8% of their total.\n\n5.11% of all Cardano voting power routed from genesis wallets through one DRep. (2/5)',
    imagePath: '/home/opc/agent/data/emurgo-circular.png'
  },
  {
    text: 'Voucher sale whales:\n\nWhale #1 \u2014 38.4M ADA. Owns a pool at 100% margin. Extracted 6.27M ADA in rewards. 95 delegators in that pool get zero.\n\nAll 5 tracked voucher whales: always_abstain.\n47.6M ADA. Zero governance input. (3/5)',
    imagePath: '/home/opc/agent/data/genesis-disruption.png'
  },
  {
    text: '422M ADA set to always_abstain in coordinated patterns. Delegation paths show structured routing from genesis through intermediaries.\n\nIOHK\'s 44M ADA sits dark \u2014 no delegation, no governance, no movement.\n\nGovernance by absence. (4/5)',
    imagePath: '/home/opc/agent/data/genesis-flowchart.png'
  },
  {
    text: 'Full trace \u2014 122 chains, every number verifiable on-chain:\n\nhttps://github.com/Cardano-Watch-Tower/watchers/tree/main/investigations/genesis-trace\n\n@jonahkoch \u2014 this is the disruption picture. Genesis funds aren\'t participating. They\'re disrupting by default. (5/5)',
    imagePath: null
  }
];

async function getLatestTweetUrl() {
  const page = await browser.getPage();
  await browser.goto('https://x.com/CardanoWT');
  await sleep(4000);

  const url = await page.evaluate(() => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (articles.length > 0) {
      const link = articles[0].querySelector('a[href*="/status/"]');
      return link ? link.href : null;
    }
    return null;
  });
  return url;
}

async function main() {
  console.log('=== Genesis Disruption Thread ===');
  console.log('Replying to: ' + PARENT_TWEET);
  console.log('Tweets: ' + tweets.length);
  console.log('');

  try {
    // Tweet 1: reply to existing conversation
    console.log('Posting 1/' + tweets.length + '...');
    await poster.replyToTweet(PARENT_TWEET, tweets[0].text, tweets[0].imagePath);
    console.log('\u2713 Posted 1/' + tweets.length);
    await sleep(5000);

    // Navigate to profile to find tweet 1 URL
    let lastUrl = await getLatestTweetUrl();
    if (!lastUrl) {
      throw new Error('Could not find tweet 1 on profile — aborting thread');
    }
    console.log('  Chain from: ' + lastUrl);

    // Chain remaining tweets
    for (let i = 1; i < tweets.length; i++) {
      await sleep(3000);
      console.log('Posting ' + (i + 1) + '/' + tweets.length + '...');
      await poster.replyToTweet(lastUrl, tweets[i].text, tweets[i].imagePath);
      console.log('\u2713 Posted ' + (i + 1) + '/' + tweets.length);

      // Get URL of this tweet for next chain link (skip on last tweet)
      if (i < tweets.length - 1) {
        await sleep(5000);
        const newUrl = await getLatestTweetUrl();
        if (newUrl && newUrl !== lastUrl) {
          lastUrl = newUrl;
          console.log('  Chain from: ' + lastUrl);
        } else {
          console.log('  Warning: could not find new tweet, continuing with last URL');
        }
      }
    }

    console.log('\n\u2705 Genesis thread posted! 5 tweets chained.');
  } catch (e) {
    console.error('\u274c FAILED at step: ' + e.message);
    console.error(e.stack);
  }

  try { await browser.close(); } catch (e) { /* ignore */ }
  process.exit(0);
}

main();
