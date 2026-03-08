/**
 * Open headful Chrome with the agent's profile so the user can log in manually.
 * After logging in, press Ctrl+C and the session/cookies will persist.
 */
require('dotenv').config();
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, '.chrome-profile');
const COOKIES_FILE = path.join(__dirname, '.cookies.json');

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.CHROME_PATH
].filter(Boolean);

// Clean locks before launch
['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'].forEach(f => {
  const fp = path.join(USER_DATA_DIR, f);
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {}
});

(async () => {
  const chromePath = CHROME_PATHS.find(p => fs.existsSync(p));
  console.log('🌐 Opening headful Chrome — log into X, then Ctrl+C');
  console.log('   Profile:', USER_DATA_DIR);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,900',
      '--lang=en-US'
    ],
    defaultViewport: null
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  await page.goto('https://x.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('✓ Login page loaded — log in manually, then Ctrl+C');

  // Save cookies on exit
  process.on('SIGINT', async () => {
    console.log('\n💾 Saving cookies...');
    try {
      const cookies = await page.cookies();
      fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
      console.log(`✓ Saved ${cookies.length} cookies`);
    } catch (e) {}
    await browser.close();
    process.exit(0);
  });

  // Keep alive
  setInterval(() => {}, 60000);
})();
