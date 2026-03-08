/**
 * Post the corrected genesis thread (deletion already done).
 * Posts one tweet at a time with recovery between each.
 */
require('dotenv').config();
const browser = require('./src/browser');
const { postTweet, reply: replyToTweet } = require('./src/poster');

const correctedThread = [
  `We traced the Cardano Genesis Block. Every UTXO path. Every delegation chain.\n\n122 connected chains. 4,322 stake keys. 14.8B ₳ tracked from block zero.\n\nWhat we found in the governance data is worth a closer look. 👁️🧵`,

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

    // Post first tweet
    console.log('\n📢 Posting tweet 1/4...');
    await postTweet(correctedThread[0]);
    console.log('✓ Tweet 1 posted');

    // Wait and find it on profile to thread off of
    await browser.sleep(3000);
    const page = await browser.getPage();
    await browser.goto(`https://x.com/CardanoWT`);
    await browser.sleep(3000);

    const firstTweetUrl = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      if (articles.length > 0) {
        const link = articles[0].querySelector('a[href*="/status/"]');
        return link ? link.href : null;
      }
      return null;
    });

    if (!firstTweetUrl) {
      console.log('⚠️  Could not find posted tweet for threading — posting standalone');
      for (let i = 1; i < correctedThread.length; i++) {
        await browser.sleep(3000);
        console.log(`📢 Posting tweet ${i+1}/4 (standalone)...`);
        await postTweet(correctedThread[i]);
        console.log(`✓ Tweet ${i+1} posted`);
      }
    } else {
      console.log(`  Thread anchor: ${firstTweetUrl}`);
      for (let i = 1; i < correctedThread.length; i++) {
        await browser.sleep(3000);
        console.log(`📢 Posting reply ${i+1}/4...`);
        await replyToTweet(firstTweetUrl, correctedThread[i]);
        console.log(`✓ Reply ${i+1} posted`);
      }
    }

    console.log('\n✅ Corrected thread posted!');
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error(`\n✗ Failed: ${e.message}`);
    try { await browser.screenshot('post-error'); } catch(x) {}
    await browser.close();
    process.exit(1);
  }
})();
