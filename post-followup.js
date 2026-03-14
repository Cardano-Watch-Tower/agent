require("dotenv").config();
const browser = require('./src/browser');
const path = require('path');

// Reply to CWT's own reply (the genesis flowchart one)
// We need to find CWT's latest reply in the thread first
const THREAD_URL = 'https://x.com/jonahkoch/status/2030991737976729998';

const FOLLOWUP = "Stakekeys tracked \u2014 verify yourself \u{1F441}\uFE0F\n\nhttps://cardanoscan.io/stakekey/stake1u9f9v0z5zzlldgx58n8tklphu8mf7h4jvp2j2gddluemnssjfnkzz\nhttps://cardanoscan.io/stakekey/stake179penqfa4kgmk799avtuyml4ppftcawnlfakaxhgwgevesggrke2g\nhttps://cardanoscan.io/stakekey/stake1ux7ppl339txknchp9j7zejs94g8yxt3aaejat22fsdzwf2ssw6paf\nhttps://cardanoscan.io/stakekey/stake1uy22xxwr0436nhxrmr626yp4y4xyqnvqy5kzvrtr3ls9d6gc3y95z\nhttps://cardanoscan.io/stakekey/stake1uxuqr63t8nya7ny4efpdj54q2d77twlfvpkefrjumngunrst8tgtg";

async function main() {
  const page = await browser.getPage();
  await page.setViewport({ width: 1280, height: 1800 });

  // Navigate to the thread
  await page.goto(THREAD_URL, { waitUntil: 'load', timeout: 30000 });
  await browser.sleep(6000);

  // Dismiss overlays
  await page.evaluate(() => {
    document.querySelectorAll('[data-testid="sheetDialog"] [data-testid="app-bar-close"]').forEach(el => el.click());
  });
  await browser.sleep(1000);

  // Find reply textarea, scroll to it
  const sel = '[data-testid="tweetTextarea_0"]';
  let box = await page.$(sel);
  if (!box) {
    const btn = await page.$('[data-testid="reply"]');
    if (btn) { await btn.click(); await browser.sleep(3000); }
  }

  await page.waitForSelector(sel, { timeout: 15000 });
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el) el.scrollIntoView({ block: 'center' });
  }, sel);
  await browser.sleep(300);
  await page.click(sel);
  await browser.sleep(500);

  // Clear stale text
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await browser.sleep(300);

  // X counts URLs as 23 chars each. 5 URLs = 115 + intro text ~30 = ~145 chars
  console.log('Text length:', FOLLOWUP.length, '(URLs counted as 23 each by X)');
  await page.keyboard.type(FOLLOWUP, { delay: 10 });
  await browser.sleep(1500);

  // Check button
  const ready = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="tweetButtonInline"]') || document.querySelector('[data-testid="tweetButton"]');
    return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  });
  console.log('Button ready:', ready);
  if (!ready) { await browser.screenshot('followup-disabled'); throw new Error('Button disabled'); }

  // Scroll button into view and click
  const postBtn = await page.$('[data-testid="tweetButtonInline"]') || await page.$('[data-testid="tweetButton"]');
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="tweetButtonInline"]') || document.querySelector('[data-testid="tweetButton"]');
    if (b) b.scrollIntoView({ block: 'center' });
  });
  await browser.sleep(300);
  await postBtn.click();
  console.log('Clicked reply');

  await browser.sleep(8000);

  // Verify text cleared
  const after = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tweetTextarea_0"]');
    return el ? el.textContent : 'GONE';
  });
  console.log('After:', after ? '"' + after.substring(0,30) + '"' : 'EMPTY=SUCCESS');

  await browser.saveCookies();
  await browser.screenshot('followup-result');
  await browser.close();
  process.exit(0);
}

main().catch(async err => {
  console.error('FATAL:', err.message);
  try { await browser.screenshot('followup-error'); } catch(e) {}
  try { await browser.close(); } catch(e) {}
  process.exit(1);
});
