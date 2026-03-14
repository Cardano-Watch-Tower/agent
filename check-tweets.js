require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    userDataDir: path.resolve(__dirname, '.chrome-profile'),
    protocolTimeout: 60000
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1800, height: 1000 });

  // Go to CWT profile to see recent tweets
  await page.goto('https://x.com/CardanoWT', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });
  await new Promise(r => setTimeout(r, 5000));

  // Get all tweet text from the profile
  const tweets = await page.evaluate(() => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    return Array.from(articles).slice(0, 10).map(a => {
      const text = a.querySelector('[data-testid="tweetText"]');
      const time = a.querySelector('time');
      return {
        text: text ? text.textContent.substring(0, 120) : '(no text)',
        time: time ? time.getAttribute('datetime') : 'unknown'
      };
    });
  });

  console.log('=== Recent CWT Tweets ===');
  tweets.forEach((t, i) => {
    console.log(`${i + 1}. [${t.time}] ${t.text}`);
  });

  await browser.close();
})();
