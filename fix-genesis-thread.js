#!/usr/bin/env node
/**
 * Fix: Delete misplaced tweets, re-post thread chained correctly.
 *
 * Problem: Tweets 2-5 were posted as replies to a whale alert, not to tweet 1.
 * Fix: Delete those 4, find tweet 1 in Jonah's thread, chain tweets 2-5 from it.
 * If tweet 1 isn't found, re-post all 5 from CWT's "Stand by" tweet.
 *
 * Key fix: After posting each reply, find it by unique text content on the
 * current page instead of navigating to the profile Tweets tab (which doesn't
 * show replies).
 */

require('dotenv').config();
const browser = require('./src/browser');
const poster = require('./src/poster');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STAND_BY_TWEET = 'https://x.com/CardanoWT/status/2031017605771784398';
const WHALE_POST_ID = '2031078207726788763';
const WHALE_POST = 'https://x.com/CardanoWT/status/' + WHALE_POST_ID;
const BOT = 'CardanoWT';

// Tweet 1 content (in case we need to re-post)
const TWEET_1 = {
  text: 'Circular delegation data \u2014 here\'s what 122 genesis chains look like today.\n\n2.63B ADA traced from genesis addresses:\n\u2022 79% zero governance participation\n\u2022 16.1% always abstain\n\u2022 4.7% Emurgo DRep\n\u2022 0% to independent community DReps\n\n\ud83e\uddf5 (1/5)',
  imagePath: '/home/opc/agent/data/governance-breakdown.png',
  finder: 'Circular delegation data'
};

// Tweets 2-5
const TWEETS_2_5 = [
  {
    text: 'The Emurgo DRep circular loop:\n\nGenesis funds \u2192 Byron cascades \u2192 Shelley migration \u2192 Emurgo DRep.\n\n297.6M ADA voting power. 91.8M traces to genesis \u2014 30.8% of their total.\n\n5.11% of all Cardano voting power routed from genesis wallets through one DRep. (2/5)',
    imagePath: '/home/opc/agent/data/emurgo-circular.png',
    finder: 'Emurgo DRep circular loop'
  },
  {
    text: 'Voucher sale whales:\n\nWhale #1 \u2014 38.4M ADA. Owns a pool at 100% margin. Extracted 6.27M ADA in rewards. 95 delegators in that pool get zero.\n\nAll 5 tracked voucher whales: always_abstain.\n47.6M ADA. Zero governance input. (3/5)',
    imagePath: '/home/opc/agent/data/genesis-disruption.png',
    finder: 'Voucher sale whales'
  },
  {
    text: '422M ADA set to always_abstain in coordinated patterns. Delegation paths show structured routing from genesis through intermediaries.\n\nIOHK\'s 44M ADA sits dark \u2014 no delegation, no governance, no movement.\n\nGovernance by absence. (4/5)',
    imagePath: '/home/opc/agent/data/genesis-flowchart.png',
    finder: '422M ADA set to always_abstain'
  },
  {
    text: 'Full trace \u2014 122 chains, every number verifiable on-chain:\n\nhttps://github.com/Cardano-Watch-Tower/watchers/tree/main/investigations/genesis-trace\n\n@jonahkoch \u2014 this is the disruption picture. Genesis funds aren\'t participating. They\'re disrupting by default. (5/5)',
    imagePath: null,
    finder: 'verifiable on-chain'
  }
];

// Known misplaced text snippets (tweets 2-5 that went to wrong place)
const MISPLACED_FINDERS = TWEETS_2_5.map(t => t.finder);

// ============================================================
// HELPERS
// ============================================================

/**
 * Navigate to a URL using 'load' (not networkidle2 which hangs on X).
 */
async function nav(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await sleep(5000); // Let React hydrate
}

/**
 * Find a tweet on the current page by text snippet. Returns its status URL or null.
 */
async function findTweetByText(page, snippet) {
  // Scroll down to reveal replies
  for (let scroll = 0; scroll < 3; scroll++) {
    const url = await page.evaluate((text) => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (const article of articles) {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        if (textEl && textEl.textContent.includes(text)) {
          // Get the tweet's own URL via the timestamp link (most reliable)
          const timeLink = article.querySelector('time[datetime]');
          if (timeLink) {
            const a = timeLink.closest('a');
            if (a && a.href.includes('/status/')) return a.href;
          }
          // Fallback: any status link from this user
          const links = article.querySelectorAll('a[href*="/status/"]');
          for (const link of links) {
            if (link.href.includes('/CardanoWT/status/')) return link.href;
          }
        }
      }
      return null;
    }, snippet);

    if (url) return url;

    // Scroll more and wait
    await page.evaluate(() => window.scrollBy(0, 800));
    await sleep(2000);
  }
  return null;
}

/**
 * Delete a tweet by navigating to it and using the ... menu.
 */
async function deleteTweet(page, url, preview) {
  console.log('  Deleting: ' + preview.substring(0, 50) + '...');
  await nav(page, url);

  // Find the caret (... menu) on the FIRST article (the main tweet)
  const caret = await page.$('article[data-testid="tweet"] [data-testid="caret"]');
  if (!caret) {
    console.log('    Could not find ... menu, skipping');
    return false;
  }
  await caret.click();
  await sleep(1500);

  // Look for Delete in the dropdown menu
  const menuItems = await page.$$('[role="menuitem"]');
  for (const item of menuItems) {
    const text = await item.evaluate(el => el.textContent);
    if (text.toLowerCase().includes('delete')) {
      await item.click();
      await sleep(1500);

      // Confirm the deletion dialog
      const confirm = await page.$('[data-testid="confirmationSheetConfirm"]');
      if (confirm) {
        await confirm.click();
        await sleep(3000);
        console.log('    Deleted.');
        return true;
      }
      break;
    }
  }
  console.log('    Delete failed');
  return false;
}

/**
 * Post a reply on a tweet detail page and return the new reply's URL.
 * Does NOT close/reopen Chrome — uses the existing page.
 */
async function postReplyAndGetUrl(page, parentUrl, text, imagePath, finderSnippet) {
  await nav(page, parentUrl);
  await page.setViewport({ width: 1280, height: 1800 });

  const replySelector = '[data-testid="tweetTextarea_0"]';

  // Find reply box (visible on tweet detail pages when logged in)
  let replyBox = await page.$(replySelector);
  if (!replyBox) {
    // Click reply icon to open it
    const replyIcon = await page.$('[data-testid="reply"]');
    if (replyIcon) {
      await replyIcon.click();
      await sleep(2000);
    }
  }

  await page.waitForSelector(replySelector, { timeout: 15000 });
  await page.evaluate((sel) => {
    document.querySelector(sel).scrollIntoView({ block: 'center' });
  }, replySelector);
  await sleep(500);
  await page.click(replySelector);
  await sleep(500);

  // Clear any leftover text
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(300);

  // Type the reply text
  await page.keyboard.type(text, { delay: 20 + Math.random() * 30 });
  await sleep(1000);

  // Attach image
  if (imagePath) {
    await poster.attachImage(page, imagePath);
    await sleep(1500);
  }

  // Click the reply/post button
  let btn = await page.$('[data-testid="tweetButtonInline"]');
  if (!btn) btn = await page.$('[data-testid="tweetButton"]');
  if (!btn) throw new Error('Cannot find reply button');

  const disabled = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="tweetButtonInline"]') ||
              document.querySelector('[data-testid="tweetButton"]');
    return b && (b.disabled || b.getAttribute('aria-disabled') === 'true');
  });
  if (disabled) throw new Error('Reply button disabled — text may exceed char limit');

  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="tweetButtonInline"]') ||
              document.querySelector('[data-testid="tweetButton"]');
    if (b) b.scrollIntoView({ block: 'center' });
  });
  await sleep(300);
  await btn.click();
  await sleep(8000); // Wait for reply to post and appear in conversation

  // Now find the reply we just posted on this page by its unique text
  const newUrl = await findTweetByText(page, finderSnippet);
  if (newUrl) {
    console.log('    Reply URL: ' + newUrl);
  } else {
    console.log('    Warning: could not find reply URL on page');
  }

  await browser.saveCookies();
  return newUrl;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  let page;

  try {
    console.log('Launching Chrome...');
    page = await browser.getPage();
    await page.setViewport({ width: 1280, height: 1800 });
    console.log('Chrome ready.\n');

    // ---- PHASE 1: Delete misplaced tweets from whale post ----
    console.log('=== PHASE 1: Find and delete misplaced tweets ===');
    await nav(page, WHALE_POST);

    // Scroll to load replies
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(1500);
    }

    // Find misplaced tweets by their text content
    const toDelete = [];
    for (const snippet of MISPLACED_FINDERS) {
      const url = await findTweetByText(page, snippet);
      if (url) {
        toDelete.push({ url, snippet });
        console.log('  Found misplaced: "' + snippet + '" at ' + url);
      }
    }

    // Also check if tweet 1 ended up on the whale post
    const tweet1OnWhale = await findTweetByText(page, TWEET_1.finder);
    if (tweet1OnWhale) {
      toDelete.push({ url: tweet1OnWhale, snippet: TWEET_1.finder });
      console.log('  Found tweet 1 also misplaced on whale post!');
    }

    console.log('Deleting ' + toDelete.length + ' misplaced tweets...');
    for (const item of toDelete) {
      await deleteTweet(page, item.url, item.snippet);
    }

    // ---- PHASE 2: Check if tweet 1 exists in Jonah's thread ----
    console.log('\n=== PHASE 2: Check for tweet 1 in Jonah\'s thread ===');
    await nav(page, STAND_BY_TWEET);

    // Scroll to load replies
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(1500);
    }

    let tweet1Url = await findTweetByText(page, TWEET_1.finder);

    if (tweet1Url) {
      console.log('Tweet 1 found in Jonah\'s thread: ' + tweet1Url);
    } else {
      console.log('Tweet 1 NOT found — posting it now...');
      tweet1Url = await postReplyAndGetUrl(
        page, STAND_BY_TWEET,
        TWEET_1.text, TWEET_1.imagePath, TWEET_1.finder
      );
      if (!tweet1Url) {
        // Fallback: navigate back and search
        await nav(page, STAND_BY_TWEET);
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollBy(0, 600));
          await sleep(1500);
        }
        tweet1Url = await findTweetByText(page, TWEET_1.finder);
      }
      if (tweet1Url) {
        console.log('Tweet 1 posted: ' + tweet1Url);
      } else {
        throw new Error('Cannot find tweet 1 after posting — aborting');
      }
    }

    // ---- PHASE 3: Post tweets 2-5 chained from tweet 1 ----
    console.log('\n=== PHASE 3: Chain tweets 2-5 ===');
    let parentUrl = tweet1Url;

    for (let i = 0; i < TWEETS_2_5.length; i++) {
      const t = TWEETS_2_5[i];
      const num = i + 2;
      console.log('  Posting ' + num + '/5 → reply to ' + parentUrl.split('/status/')[1]);

      const newUrl = await postReplyAndGetUrl(page, parentUrl, t.text, t.imagePath, t.finder);

      if (newUrl) {
        parentUrl = newUrl;
        console.log('  \u2713 ' + num + '/5 posted and chained');
      } else {
        // Fallback: navigate back to parent, scroll, search
        console.log('  Retrying URL discovery...');
        await nav(page, parentUrl);
        for (let s = 0; s < 4; s++) {
          await page.evaluate(() => window.scrollBy(0, 600));
          await sleep(1500);
        }
        const retryUrl = await findTweetByText(page, t.finder);
        if (retryUrl) {
          parentUrl = retryUrl;
          console.log('  \u2713 ' + num + '/5 found on retry: ' + retryUrl);
        } else {
          console.log('  \u26a0 ' + num + '/5 posted but could not chain — next tweet replies to same parent');
        }
      }

      // Brief pause between tweets
      await sleep(3000);
    }

    console.log('\n\u2705 Thread complete. 5 tweets in Jonah\'s conversation.');

  } catch (e) {
    console.error('\n\u274c FAILED: ' + e.message);
    console.error(e.stack);
  }

  try { await browser.close(); } catch(e) {}
  process.exit(0);
}

main();
