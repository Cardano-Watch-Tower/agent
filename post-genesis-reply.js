require("dotenv").config();
const browser = require('./src/browser');
const path = require('path');

const TWEET_URL = 'https://x.com/jonahkoch/status/2030991737976729998';
const IMAGE_PATH = path.join(__dirname, 'data', 'genesis-flowchart.png');
const REPLY_TEXT = "Built it. \u{1F441}\uFE0F\n\nFull genesis flow + whale reward tracking. 5 stakekeys, 6.69M \u20B3 in lifetime staking rewards.\n\nVerified on-chain. Where should we dig next? \u{1F50D}";

async function main() {
  const page = await browser.getPage();
  // Bigger viewport so reply button is visible
  await page.setViewport({ width: 1280, height: 1800 });

  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await browser.sleep(3000);

  await page.goto(TWEET_URL, { waitUntil: 'load', timeout: 30000 });
  await browser.sleep(6000);

  // Dismiss overlays
  await page.evaluate(() => {
    document.querySelectorAll('[data-testid="sheetDialog"] [data-testid="app-bar-close"]').forEach(el => el.click());
  });
  await browser.sleep(1000);

  const sel = '[data-testid="tweetTextarea_0"]';
  let box = await page.$(sel);
  if (!box) {
    const btn = await page.$('[data-testid="reply"]');
    if (btn) { await btn.click(); await browser.sleep(3000); }
  }

  await page.waitForSelector(sel, { timeout: 15000 });

  // Scroll textarea into view
  await page.evaluate(() => {
    document.querySelector('[data-testid="tweetTextarea_0"]').scrollIntoView({ block: 'center' });
  });
  await browser.sleep(500);

  await page.click(sel);
  await browser.sleep(500);

  // Clear stale text
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await browser.sleep(500);

  console.log('Typing ' + REPLY_TEXT.length + ' chars');
  await page.keyboard.type(REPLY_TEXT, { delay: 12 });
  await browser.sleep(1000);

  // Attach image
  const inputs = await page.$$('input[type="file"]');
  if (inputs.length > 0) {
    await inputs[0].uploadFile(IMAGE_PATH);
    await browser.sleep(5000);
  }

  // Check button
  const ready = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="tweetButtonInline"]') || document.querySelector('[data-testid="tweetButton"]');
    return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  });
  console.log('Button ready:', ready);
  if (!ready) { await browser.screenshot('disabled'); throw new Error('Button disabled'); }

  // Scroll button into view and click it properly
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="tweetButtonInline"]') || document.querySelector('[data-testid="tweetButton"]');
    b.scrollIntoView({ block: 'center' });
  });
  await browser.sleep(500);

  await browser.screenshot('pre-click');

  // Click using Puppeteer's element click (handles scrolling internally)
  const postBtn = await page.$('[data-testid="tweetButtonInline"]') || await page.$('[data-testid="tweetButton"]');
  await postBtn.click();
  console.log('Clicked reply button via element.click()');

  await browser.sleep(10000);
  await browser.screenshot('post-click');

  // Check if text cleared
  const after = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tweetTextarea_0"]');
    return el ? el.textContent : 'GONE';
  });
  console.log('After:', after ? '"' + after.substring(0,30) + '"' : 'EMPTY=SUCCESS');

  await browser.saveCookies();
  await browser.close();
  process.exit(0);
}

main().catch(async err => {
  console.error('FATAL:', err.message);
  try { await browser.screenshot('error'); } catch(e) {}
  try { await browser.close(); } catch(e) {}
  process.exit(1);
});
