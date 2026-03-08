/**
 * One-shot: Delete the genesis thread and repost with corrected framing.
 * The original thread focused on "unused governance" — wrong angle.
 * The real story is CIRCULAR DELEGATION: genesis funds delegating to Emurgo's own DRep.
 */
require('dotenv').config();
const browser = require('./src/browser');

const THREAD_URL = 'https://x.com/CardanoWT/status/2030699645177889111';
const BOT_USERNAME = process.env.X_USERNAME || 'CardanoWT';

// Corrected thread — focuses on circular delegation
const correctedThread = [
  `We traced the Cardano Genesis Block. Every UTXO path. Every delegation chain.\n\n122 connected chains. 4,322 stake keys. 14.8B ₳ tracked from block zero.\n\nWhat we found in the governance data is worth a closer look. 👁️🧵`,

  `41 chains carrying 123M ₳ in genesis funds are delegated to the Emurgo DRep.\n\nGenesis funds → stake keys → delegated back to their own DRep.\n\nCircular delegation. Self-referential governance power from day-zero money.`,

  `To be clear: 64 chains holding 2.08B ₳ with no governance delegation? That's fine. Unused is neutral.\n\nBut funds tracing back to genesis actively used to boost a single DRep's voting power — that's a different conversation.`,

  `Full trace. No assumptions. Just the chain.\n\nData drops incoming. 👁️`
];

async function deleteTweet(url) {
  const page = await browser.getPage();
  await browser.goto(url);
  await browser.sleep(3000);

  // Find tweets from our account on this page
  const deleted = await page.evaluate((botUser) => {
    // Look for the "more" button on our own tweets
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      const userLink = article.querySelector('a[href^="/"]');
      if (userLink) {
        const href = userLink.getAttribute('href');
        if (href === '/' + botUser) {
          // Found our tweet — click the ... menu
          const moreBtn = article.querySelector('[data-testid="caret"]');
          if (moreBtn) {
            moreBtn.click();
            return true;
          }
        }
      }
    }
    return false;
  }, BOT_USERNAME);

  if (!deleted) {
    console.log(`  Could not find our tweet at ${url}`);
    return false;
  }

  await browser.sleep(1000);

  // Click "Delete" in the dropdown
  const deleteClicked = await page.evaluate(() => {
    const menuItems = document.querySelectorAll('[role="menuitem"]');
    for (const item of menuItems) {
      if (item.textContent.includes('Delete')) {
        item.click();
        return true;
      }
    }
    return false;
  });

  if (!deleteClicked) {
    console.log(`  No "Delete" option found`);
    return false;
  }

  await browser.sleep(1000);

  // Confirm deletion
  const confirmed = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.includes('Delete') && btn.getAttribute('data-testid') === 'confirmationSheetConfirm') {
        btn.click();
        return true;
      }
    }
    // Fallback: any red/destructive Delete button
    for (const btn of buttons) {
      if (btn.textContent.trim() === 'Delete') {
        btn.click();
        return true;
      }
    }
    return false;
  });

  await browser.sleep(2000);
  return confirmed;
}

async function postThread(tweets) {
  const { postTweet } = require('./src/poster');
  const page = await browser.getPage();

  // Post first tweet
  await postTweet(tweets[0]);
  await browser.sleep(2000);

  // Find first tweet on profile
  await browser.goto(`https://x.com/${BOT_USERNAME}`);
  await browser.sleep(3000);

  const firstTweetLink = await page.evaluate(() => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (articles.length > 0) {
      const link = articles[0].querySelector('a[href*="/status/"]');
      return link ? link.href : null;
    }
    return null;
  });

  if (!firstTweetLink) {
    console.log('⚠️  Could not find posted tweet for threading');
    return;
  }

  // Reply chain
  const { reply } = require('./src/poster');
  for (let i = 1; i < tweets.length; i++) {
    await browser.sleep(2000);
    await reply(firstTweetLink, tweets[i]);
  }
}

(async () => {
  try {
    console.log('🚀 Launching browser...');
    await browser.launch();

    const loggedIn = await browser.isLoggedIn();
    if (!loggedIn) {
      console.error('✗ Not logged in');
      process.exit(1);
    }

    // Step 1: Delete the old thread
    console.log('\n🗑️  Deleting old thread...');

    // Navigate to profile and find thread tweets to delete
    await browser.goto(`https://x.com/${BOT_USERNAME}`);
    await browser.sleep(3000);

    // Get all our recent tweet URLs
    const page = await browser.getPage();
    const tweetUrls = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      const urls = [];
      for (const article of articles) {
        const link = article.querySelector('a[href*="/status/"]');
        if (link) urls.push(link.href);
      }
      return urls;
    });

    console.log(`  Found ${tweetUrls.length} tweets on profile`);

    // Delete the thread tweets (they should be the most recent 4)
    // Delete from bottom up so indices don't shift
    const threadTweets = tweetUrls.slice(0, 4);
    for (const url of threadTweets.reverse()) {
      console.log(`  Deleting: ${url.split('/status/')[1]}`);
      const result = await deleteTweet(url);
      console.log(`  ${result ? '✓ Deleted' : '✗ Failed'}`);
      await browser.sleep(2000);
    }

    // Step 2: Post corrected thread
    console.log('\n📢 Posting corrected thread...');
    correctedThread.forEach((t, i) => console.log(`  [${i+1}] ${t.substring(0, 80)}...`));

    await postThread(correctedThread);
    console.log('\n✅ Corrected thread posted!');

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error(`\n✗ Failed: ${e.message}`);
    console.error(e.stack);
    await browser.close();
    process.exit(1);
  }
})();
