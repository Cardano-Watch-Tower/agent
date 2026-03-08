/**
 * BROWSER — Puppeteer session manager for CardanoWatchTower
 *
 * Replaces X API with direct browser automation.
 * The agent becomes a user — keyboard, mouse, same as anyone else.
 *
 * Handles:
 *   - Chrome launch with persistent profile (stays logged in)
 *   - Cookie/session persistence across restarts
 *   - Singleton pattern (only one Chrome instance, ever)
 *   - Stale lock recovery (kills orphaned Chrome from crashed processes)
 *   - Navigation helpers
 *   - Element waiting and interaction
 *   - Screenshot capture for debugging
 */
const puppeteer = require('puppeteer-core');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Persistent Chrome profile — cookies, localStorage, session all survive restarts
const USER_DATA_DIR = path.join(__dirname, '..', '.chrome-profile');
const COOKIES_FILE = path.join(__dirname, '..', '.cookies.json');
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

// Find Chrome on Windows
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.CHROME_PATH
].filter(Boolean);

let browser = null;
let page = null;
let launchPromise = null; // Dedup concurrent launch() calls
let lastLoginAttempt = 0; // Cooldown: don't hammer X with login attempts
const LOGIN_COOLDOWN_MS = 120_000; // 2 minutes between login attempts

/**
 * Delete all Chrome lock/state files from profile dir.
 * Must be called BEFORE puppeteer.launch() on Windows, because
 * Puppeteer checks 'lockfile' existence post-crash and throws
 * "already running" even when the lock was created by the process
 * that just crashed (not by a separate running browser).
 */
function cleanLockFiles() {
  for (const lockName of ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
    const lockPath = path.join(USER_DATA_DIR, lockName);
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch (e) { /* locked — killOrphanedChrome will handle it */ }
  }
}

/**
 * Kill orphaned Chrome processes that hold our profile lock.
 * This happens when the node process crashes without calling close().
 */
function killOrphanedChrome() {
  // Nuclear option: kill ALL chrome.exe — the wmic commandline query misses
  // freshly-spawned headless Chrome that hasn't registered yet.
  try {
    execFileSync('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore' });
    console.log('🧹 Killed all Chrome processes');
  } catch (e) {
    // No chrome running — that's fine
  }

  // Wait for OS to release file handles (sync sleep via ping)
  try {
    execFileSync('ping', ['-n', '4', '127.0.0.1'], { stdio: 'ignore' });
  } catch (e) { /* ignore */ }

  // Delete ALL lock artifacts Chrome uses
  for (const lockName of ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
    const lockPath = path.join(USER_DATA_DIR, lockName);
    try {
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    } catch (e) { /* still locked, oh well */ }
  }
}

/**
 * Launch browser or reconnect to existing session.
 * Uses a persistent profile so X login survives restarts.
 *
 * SINGLETON: If multiple callers hit launch() concurrently,
 * they all await the same promise — only one Chrome spawns.
 */
async function launch() {
  // Fast path: browser already alive
  if (browser && page) {
    try {
      await page.title(); // test connection
      return page;
    } catch (e) {
      // Dead session, will relaunch below
      browser = null;
      page = null;
      launchPromise = null;
    }
  }

  // Dedup: if a launch is already in progress, wait for it
  if (launchPromise) {
    await launchPromise;
    return page;
  }

  // This is the ONE launch — everyone else waits on this promise
  launchPromise = _doLaunch();
  try {
    await launchPromise;
    return page;
  } finally {
    launchPromise = null;
  }
}

/**
 * Internal launch — only called once at a time.
 */
async function _doLaunch() {
  const chromePath = CHROME_PATHS.find(p => fs.existsSync(p));
  if (!chromePath) {
    throw new Error('Chrome not found. Set CHROME_PATH in .env');
  }

  // Ensure dirs exist
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  console.log('🌐 Launching Chrome...');

  // Pre-clean: delete lock files BEFORE launch. On Windows, Puppeteer checks
  // for 'lockfile' existence AFTER Chrome crashes and interprets it as
  // "already running" — even when the lockfile was just created by the
  // Chrome process that just crashed. Cleaning first prevents this false positive.
  cleanLockFiles();

  const launchOpts = {
    executablePath: chromePath,
    headless: 'new',
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--disable-extensions',
      '--disable-gpu',
      '--lang=en-US'
    ],
    defaultViewport: { width: 1920, height: 1080 }
  };

  let failedBrowser = null; // Track first attempt so its events don't nuke the retry

  try {
    browser = await puppeteer.launch(launchOpts);
  } catch (e) {
    if (e.message.includes('already running') || e.message.includes('lock')) {
      // The first attempt may have spawned Chrome that partially started.
      // Its 'disconnected' event could fire AFTER our retry succeeds,
      // nuking the browser/page references. Detach it.
      failedBrowser = browser;
      browser = null;
      if (failedBrowser) {
        failedBrowser.removeAllListeners('disconnected');
        try { await failedBrowser.close(); } catch (_) {}
      }

      console.log('🔒 Stale Chrome lock detected — recovering...');
      killOrphanedChrome();
      // Clean locks AGAIN after kill — Chrome may recreate them during shutdown
      cleanLockFiles();
      browser = await puppeteer.launch(launchOpts);
    } else {
      throw e;
    }
  }

  // Handle unexpected browser disconnection — only for the FINAL working browser
  const currentBrowser = browser;
  browser.on('disconnected', () => {
    // Only reset if this is still the active browser (not a stale reference)
    if (browser === currentBrowser) {
      console.log('⚠️  Chrome disconnected unexpectedly');
      browser = null;
      page = null;
      launchPromise = null;
    }
  });

  page = await browser.newPage();

  // Stealth: remove webdriver detection flags
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.navigator.chrome = { runtime: {} };
  });

  // Set a realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );

  // Restore cookies if we have them
  await loadCookies();

  console.log('🌐 Chrome ready');
}

/**
 * Save current cookies to disk.
 */
async function saveCookies() {
  if (!page) return;
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  } catch (e) {
    // Page might be navigating or closed — ignore
  }
}

/**
 * Restore cookies from disk.
 */
async function loadCookies() {
  if (!page) return;
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
        console.log(`🍪 Restored ${cookies.length} cookies`);
      }
    }
  } catch (e) {
    console.error('Cookie restore failed:', e.message);
  }
}

/**
 * Navigate to a URL and wait for it to load.
 */
async function goto(url, waitFor = 'networkidle2') {
  await launch();
  await page.goto(url, { waitUntil: waitFor, timeout: 30000 });
  await saveCookies();
  return page;
}

/**
 * Check if we're logged into X.
 * Returns true if we see the compose button or home timeline.
 */
async function isLoggedIn() {
  await launch();
  await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  const url = page.url();
  if (url.includes('/login') || url.includes('/i/flow/login')) {
    return false;
  }

  const hasTimeline = await page.evaluate(() => {
    return document.querySelector('[data-testid="tweetTextarea_0"]') !== null ||
           document.querySelector('[data-testid="SideNav_NewTweet_Button"]') !== null ||
           document.querySelector('article[data-testid="tweet"]') !== null;
  });

  return hasTimeline;
}

/**
 * Login to X with username/password.
 * Call this once — after that cookies persist.
 */
async function login(username, password) {
  // Cooldown: don't hammer X with login attempts (causes account blocks)
  const timeSinceLast = Date.now() - lastLoginAttempt;
  if (timeSinceLast < LOGIN_COOLDOWN_MS) {
    const waitSec = Math.ceil((LOGIN_COOLDOWN_MS - timeSinceLast) / 1000);
    console.log(`⏳ Login cooldown: waiting ${waitSec}s before next attempt...`);
    await sleep(LOGIN_COOLDOWN_MS - timeSinceLast);
  }
  lastLoginAttempt = Date.now();

  await launch();
  console.log('🔐 Logging into X...');

  await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  const usernameInput = await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
  await usernameInput.type(username, { delay: 50 });
  await sleep(500);

  const nextButtons = await page.$$('button');
  for (const btn of nextButtons) {
    const text = await page.evaluate(el => el.textContent, btn);
    if (text.includes('Next')) {
      await btn.click();
      break;
    }
  }
  await sleep(2000);

  const verifyInput = await page.$('input[data-testid="ocfEnterTextTextInput"]');
  if (verifyInput) {
    console.log('⚠️  X is asking for verification (email/phone). Check the browser.');
    throw new Error('X verification required — need email/phone confirmation');
  }

  const passwordInput = await page.waitForSelector('input[autocomplete="current-password"]', { timeout: 10000 });
  await passwordInput.type(password, { delay: 50 });
  await sleep(500);

  const loginButtons = await page.$$('button');
  for (const btn of loginButtons) {
    const text = await page.evaluate(el => el.textContent, btn);
    if (text.includes('Log in')) {
      await btn.click();
      break;
    }
  }

  await sleep(5000);
  await saveCookies();

  const loggedIn = await isLoggedIn();
  if (loggedIn) {
    console.log('✓ Logged into X');
  } else {
    console.log('✗ Login may have failed — check screenshots');
    await screenshot('login-result');
  }

  return loggedIn;
}

/**
 * Type text with human-like delays.
 */
async function humanType(selector, text) {
  await launch();
  const el = await page.waitForSelector(selector, { timeout: 10000 });
  for (const char of text) {
    await el.type(char, { delay: 30 + Math.random() * 70 });
  }
}

/**
 * Click an element matching a selector.
 */
async function click(selector) {
  await launch();
  const el = await page.waitForSelector(selector, { timeout: 10000 });
  await el.click();
}

/**
 * Wait for a selector to appear.
 */
async function waitFor(selector, timeout = 10000) {
  await launch();
  return page.waitForSelector(selector, { timeout });
}

/**
 * Get text content of an element.
 */
async function getText(selector) {
  await launch();
  const el = await page.$(selector);
  if (!el) return null;
  return page.evaluate(el => el.textContent, el);
}

/**
 * Take a screenshot for debugging.
 */
async function screenshot(name = 'debug') {
  if (!page) return null;
  const filename = `${name}-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  console.log(`📸 Screenshot: ${filepath}`);
  return filepath;
}

/**
 * Get the raw page object for advanced operations.
 */
async function getPage() {
  await launch();
  return page;
}

/**
 * Clean shutdown.
 */
async function close() {
  if (browser) {
    await saveCookies();
    try {
      await browser.close();
    } catch (e) {
      // Browser might already be dead
    }
    browser = null;
    page = null;
    launchPromise = null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  launch, goto, isLoggedIn, login,
  humanType, click, waitFor, getText,
  screenshot, getPage, close,
  saveCookies, loadCookies, sleep
};
