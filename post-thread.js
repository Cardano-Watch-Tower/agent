require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const replies = [
  {
    text: `Correction on this thread \u2014 I showed reward distribution earlier. That's not disruption.\n\nDisruption = who controls delegation, pool governance, and voting power from genesis funds.\n\nHere's what the data actually shows. \ud83e\uddf5\ud83d\udc47`,
    image: null
  },
  {
    text: `GENESIS DISRUPTION: Pool Control & SPO Voting Power\n\n5 voucher-sale whales hold 47.6M ADA of genesis allocation.\n\nWhale #1: Owns MIN pool at 100% margin. Self-delegates 38.4M ADA. Extracts ALL staking rewards. 95 other delegators get zero.\n\nAs SPO, votes on governance with 39.2M ADA backing.\n\nAll 5 whales set DRep to "always_abstain" \u2014 but their massive stake gives pool operators SPO voting power.`,
    image: path.resolve(__dirname, 'data/genesis-disruption.png')
  },
  {
    text: `THE CIRCULAR GOVERNANCE LOOP\n\nGenesis allocation \u2192 Byron cascades \u2192 Shelley endpoints \u2192 Emurgo DRep \u2192 Emurgo votes on governance.\n\nEmurgo DRep: 297.6M ADA voting power (5.11% of total Cardano governance).\n91.8M ADA (30.8%) traces directly back to genesis.\n\nTop delegators use Moonstake pools (Emurgo-affiliated). 4 of top 6 registered at exactly epoch 550 \u2014 Conway governance launch.\n\nThe ONLY real governance participation from genesis funds circles back to a founding entity.`,
    image: path.resolve(__dirname, 'data/emurgo-circular.png')
  },
  {
    text: `WHERE IS THE GOVERNANCE?\n\nOf 2.63B ADA held across 122 traced genesis chains:\n\n\u25aa 79% \u2014 No governance (pool staking only, zero DRep)\n\u25aa 16.1% \u2014 Always Abstain (coordinated treasury)\n\u25aa 4.7% \u2014 Emurgo DRep (circular, back to founding entity)\n\u25aa 0.3% \u2014 No Confidence (single whale)\n\u25aa 0% \u2014 Independent Community DRep\n\nZero. Not a single tracked genesis ADA participates through a community-elected representative.\n\nThe staking incentive works. The governance incentive does not.\n\nAll data on-chain verified. Blockfrost API. Epoch 617.\n\n\ud83d\udc41\ufe0f`,
    image: path.resolve(__dirname, 'data/governance-breakdown.png')
  }
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function postReply(page, text, imagePath) {
  // Scroll to bottom to find inline reply box
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(2000);

  // Find the inline reply text area
  const editor = await page.$('[data-testid="tweetTextarea_0"]');
  if (!editor) {
    // Try clicking on the reply area first
    const replyArea = await page.$('[data-testid="tweetTextarea_0_label"]');
    if (replyArea) {
      await replyArea.click();
      await sleep(1000);
    } else {
      throw new Error('Cannot find reply text area');
    }
  }

  // Click into it
  const textarea = await page.$('[data-testid="tweetTextarea_0"]');
  if (!textarea) throw new Error('Still no textarea after click');

  // Scroll it into view
  await page.evaluate(el => el.scrollIntoView({ block: 'center' }), textarea);
  await sleep(500);
  await textarea.click();
  await sleep(500);

  // Clear any stale text
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await sleep(200);
  await page.keyboard.press('Backspace');
  await sleep(300);

  // Type text
  await page.keyboard.type(text, { delay: 10 });
  await sleep(1000);

  // Attach image if present
  if (imagePath && fs.existsSync(imagePath)) {
    const fileInput = await page.$('input[data-testid="fileInput"]');
    if (fileInput) {
      await fileInput.uploadFile(imagePath);
      console.log('  Image uploading...');
      await sleep(5000); // Wait for upload
    } else {
      console.log('  WARNING: No file input found');
    }
  }

  // Find and click send button
  await sleep(1000);
  const sendBtn = await page.$('[data-testid="tweetButtonInline"]');
  if (!sendBtn) throw new Error('No send button');

  // Check button state
  const btnState = await page.evaluate(el => {
    const btn = el.closest('button') || el;
    return {
      disabled: btn.disabled,
      ariaDisabled: btn.getAttribute('aria-disabled'),
      text: btn.textContent
    };
  }, sendBtn);
  console.log('  Button state:', JSON.stringify(btnState));

  if (btnState.disabled || btnState.ariaDisabled === 'true') {
    console.log('  Button disabled, waiting longer...');
    await sleep(5000);
  }

  await sendBtn.click();
  await sleep(5000);

  // Check if the text area is now empty (meaning post succeeded)
  const remaining = await page.$('[data-testid="tweetTextarea_0"]');
  if (remaining) {
    const txt = await page.evaluate(el => el.textContent, remaining);
    if (txt && txt.length > 10) {
      console.log('  WARNING: Text still in box, post may have failed');
      return false;
    }
  }

  console.log('  Reply posted!');
  return true;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    userDataDir: path.resolve(__dirname, '.chrome-profile')
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1800, height: 1000 });

  console.log('Navigating to thread...');
  await page.goto('https://x.com/jonahkoch/status/2030991737976729998', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });
  await sleep(5000);

  // Check login
  const loginCheck = await page.$('[data-testid="loginButton"]');
  if (loginCheck) throw new Error('NOT LOGGED IN');
  console.log('Logged in, thread loaded.\n');

  for (let i = 0; i < replies.length; i++) {
    const reply = replies[i];
    console.log(`--- Reply ${i + 1}/${replies.length} ---`);
    console.log(`  Text: ${reply.text.substring(0, 50)}...`);

    const success = await postReply(page, reply.text, reply.image);

    if (!success) {
      console.log('  FAILED - taking screenshot for debug');
      await page.screenshot({
        path: path.resolve(__dirname, `data/debug-thread-${i}.png`),
        fullPage: false
      });
    }

    // Wait between posts, then reload
    console.log('  Waiting...');
    await sleep(8000);

    // Reload with generous timeout
    try {
      await page.goto('https://x.com/jonahkoch/status/2030991737976729998', {
        waitUntil: 'networkidle2',
        timeout: 60000
      });
    } catch (e) {
      console.log('  Reload timeout, continuing anyway...');
    }
    await sleep(5000);
  }

  console.log('\n=== THREAD COMPLETE ===');
  await browser.close();
})();
