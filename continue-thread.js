/**
 * Continue the corrected thread — tweet 1 is already posted.
 * Finds it on profile and replies tweets 2-4.
 */
require('dotenv').config();
const browser = require('./src/browser');
const { reply: replyToTweet, postTweet } = require('./src/poster');

const remainingTweets = [
  `41 chains carrying 123M ₳ in genesis funds are delegated to the Emurgo DRep.\n\nGenesis funds → stake keys → delegated back to their own DRep.\n\nCircular delegation. Self-referential governance power from day-zero money.`,

  `To be clear: 64 chains holding 2.08B ₳ with no governance delegation? That's fine. Unused is neutral.\n\nBut funds tracing back to genesis actively used to boost a single DRep's voting power — that's a different conversation.`,

  `Full trace. No assumptions. Just the chain.\n\nData drops incoming. 👁️`
];

(async () => {
  try {
    console.log('🚀 Launching browser...');
    await browser.launch();

    const loggedIn = await browser.isLoggedIn();
    if (!loggedIn) {
      console.error('✗ Not logged in');
      await browser.close();
      process.exit(1);
    }
    console.log('✓ Logged in');

    // Find tweet 1 on profile
    console.log('🔍 Finding tweet 1 on profile...');
    const page = await browser.getPage();
    await browser.goto('https://x.com/CardanoWT');
    await browser.sleep(4000);

    const firstTweetUrl = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      if (articles.length > 0) {
        const link = articles[0].querySelector('a[href*="/status/"]');
        return link ? link.href : null;
      }
      return null;
    });

    if (!firstTweetUrl) {
      console.log('⚠️  Could not find tweet 1 for threading — posting standalone');
      for (let i = 0; i < remainingTweets.length; i++) {
        await browser.sleep(3000);
        console.log(`📢 Posting tweet ${i+2}/4 (standalone)...`);
        await postTweet(remainingTweets[i]);
        console.log(`✓ Tweet ${i+2} posted`);
      }
    } else {
      console.log(`  Thread anchor: ${firstTweetUrl}`);
      for (let i = 0; i < remainingTweets.length; i++) {
        await browser.sleep(4000);
        console.log(`📢 Posting reply ${i+2}/4...`);
        await replyToTweet(firstTweetUrl, remainingTweets[i]);
        console.log(`✓ Reply ${i+2} posted`);
      }
    }

    console.log('\n✅ Thread completed!');
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error(`\n✗ Failed: ${e.message}`);
    try { await browser.screenshot('continue-error'); } catch(x) {}
    await browser.close();
    process.exit(1);
  }
})();
