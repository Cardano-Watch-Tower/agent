require('dotenv').config();
const browser = require('./src/browser');

const TWEET_URL = 'https://x.com/jonahkoch/status/2030991737976729998';

const text = "Correction \u2014 I jumped to distribution when you asked about disruption. Two different things.\n\nGetting the circular delegation data now: which pools these whales control, delegation cycling, and governance influence.\n\nStand by. \ud83d\udc41\ufe0f";

(async () => {
  try {
    console.log('Text length:', text.length);

    const page = await browser.getPage();
    await page.setViewport({ width: 1280, height: 1800 });

    await page.goto(TWEET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await browser.sleep(4000);

    // Find and click reply textarea
    const replySelector = '[data-testid="tweetTextarea_0"]';
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'center' });
    }, replySelector);
    await browser.sleep(500);
    await page.click(replySelector);
    await browser.sleep(500);

    // Clear stale text
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await browser.sleep(300);

    await page.keyboard.type(text, { delay: 30 });
    await browser.sleep(2000);

    // Check button state
    const btnReady = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="tweetButtonInline"]') ||
                document.querySelector('[data-testid="tweetButton"]');
      if (!b) return 'NOT_FOUND';
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return 'DISABLED';
      return 'READY';
    });
    console.log('Button:', btnReady);

    if (btnReady === 'DISABLED') {
      throw new Error('Reply button disabled - text too long');
    }
    if (btnReady === 'NOT_FOUND') {
      throw new Error('Reply button not found');
    }

    // Scroll button into view and click
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="tweetButtonInline"]') ||
                document.querySelector('[data-testid="tweetButton"]');
      if (b) b.scrollIntoView({ block: 'center' });
    });
    await browser.sleep(300);

    const postButton = await page.$('[data-testid="tweetButtonInline"]') ||
                       await page.$('[data-testid="tweetButton"]');
    await postButton.click();
    console.log('Clicked reply');

    await browser.sleep(5000);

    // Verify
    const afterText = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tweetTextarea_0"]');
      return el ? el.textContent : 'NO_ELEMENT';
    });
    console.log('After:', afterText === '' || afterText === 'Post your reply' ? 'EMPTY=SUCCESS' : afterText);

  } catch (err) {
    console.error('Error:', err.message);
  }
  process.exit(0);
})();
