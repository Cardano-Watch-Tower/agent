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
const puppeteer = require('puppeteer');
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

// Browser operation lock - prevents concurrent Chrome navigation crashes
let _lockQueue = Promise.resolve();

function withLock(fn) {
  const prev = _lockQueue;
  let resolve;
  _lockQueue = new Promise(r => resolve = r);
  return (async () => {
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  })();
}

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
    execFileSync('pkill', ['-f', 'chrome'], { stdio: 'ignore' });
    console.log('🧹 Killed all Chrome processes');
  } catch (e) {
    // No chrome running — that's fine
  }

  // Wait for OS to release file handles (sync sleep via ping)
  try {
    execFileSync('sleep', ['3'], { stdio: 'ignore' });
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
      '--disable-dev-shm-usage',
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
  try {
    await page.goto(url, { waitUntil: waitFor, timeout: 30000 });
  } catch (e) {
    if (e.message.includes('ERR_ABORTED') || e.message.includes('net::ERR_')) {
      console.log('⟳ Navigation retry (' + url.substring(0, 40) + ')');
      await sleep(2000);
      await page.goto(url, { waitUntil: waitFor, timeout: 30000 });
    } else {
      throw e;
    }
  }
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
 * Wait for any of the given selectors to appear. Returns the selector that matched.
 */
async function waitForAny(page, selectors, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) return sel;
    }
    await sleep(500);
  }
  return null;
}

/**
 * Click the first button whose text includes any of the given labels.
 */
async function clickButtonWithText(page, labels) {
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await page.evaluate(el => el.textContent || '', btn);
    if (labels.some(l => text.includes(l))) {
      await btn.click();
      return true;
    }
  }
  return false;
}

/**
 * Wait for a code to be written to a file (used for 2FA and verification).
 * Polls every 3 seconds for up to 10 minutes.
 */
async function waitForCodeFile(filePath, timeoutMs = 600_000) {
  const fs = require('fs');
  const start = Date.now();
  // Remove any stale code file first
  try { fs.unlinkSync(filePath); } catch (e) { /* fine */ }

  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(filePath)) {
        const code = fs.readFileSync(filePath, 'utf8').trim();
        if (code.length > 0) {
          fs.unlinkSync(filePath); // consume it
          console.log('    Code received: ' + '*'.repeat(code.length));
          return code;
        }
      }
    } catch (e) { /* ignore */ }
    await sleep(3000);
  }
  throw new Error('Timed out waiting for verification code in ' + filePath);
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

  // Step 1: Enter username — insertText + Tab (to sync React state) + Enter (to submit)
  await page.waitForSelector('input[autocomplete="username"]', { timeout: 20000 });
  await page.focus('input[autocomplete="username"]');
  await sleep(800);
  const cdp1 = await page.createCDPSession();
  await cdp1.send('Input.insertText', { text: username });
  await cdp1.detach();
  await sleep(500);
  await page.keyboard.press('Tab');   // blur — triggers React onChange with typed value
  await sleep(600);
  await screenshot('after-type-username');
  // Press Enter to submit (more reliable than button-click for React forms)
  await page.keyboard.press('Enter');
  await sleep(2000);
  await screenshot('after-click-next');
  await sleep(2000);

  // Step 2: X may show a verification step before password (OCF flow)
  // Wait for EITHER the verification input OR the password input
  const afterUsername = await waitForAny(page, [
    'input[data-testid="ocfEnterTextTextInput"]',
    'input[autocomplete="current-password"]'
  ], 20000);

  if (!afterUsername) {
    await screenshot('login-after-username');
    throw new Error('Login stuck — neither verification nor password input appeared after username');
  }

  if (afterUsername === 'input[data-testid="ocfEnterTextTextInput"]') {
    console.log('⚠️  X is asking for email/username verification.');
    console.log('    Write your verification input to /tmp/x_code.txt to continue...');
    const verifyInput = await page.$('input[data-testid="ocfEnterTextTextInput"]');
    const code = await waitForCodeFile('/tmp/x_code.txt');
    await verifyInput.type(code.trim(), { delay: 50 });
    await sleep(500);
    await clickButtonWithText(page, ['Next', 'Verify', 'Confirm']);
    await sleep(3000);
  }

  // Step 3: Password — CDP insertText
  await page.waitForSelector('input[autocomplete="current-password"]', { timeout: 15000 });
  await page.focus('input[autocomplete="current-password"]');
  await sleep(800);
  const cdp2 = await page.createCDPSession();
  await cdp2.send('Input.insertText', { text: password });
  await cdp2.detach();
  await sleep(600);

  await clickButtonWithText(page, ['Log in']);

  await sleep(4000);

  // Handle 2FA / email code challenge after password entry
  const twoFaInput = await page.$('input[data-testid="LoginTwoFactorAuthInput"]');
  const challengeInput = await page.$('input[data-testid="ocfEnterTextTextInput"]');
  const activeChallenge = twoFaInput || challengeInput;
  if (activeChallenge) {
    console.log('⚠️  X is asking for a 2FA or verification code.');
    console.log('    Write your code to /tmp/x_code.txt to continue...');
    const code = await waitForCodeFile('/tmp/x_code.txt');
    await activeChallenge.type(code.trim(), { delay: 50 });
    await sleep(500);
    const challengeButtons = await page.$$('button');
    for (const btn of challengeButtons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text.includes('Next') || text.includes('Confirm') || text.includes('Log in') || text.includes('Verify')) {
        await btn.click();
        break;
      }
    }
    await sleep(3000);
  }

  await sleep(2000);
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


// --- Auto Re-Login with Suspension-Safe Limits ---
// 4 attempts max: 2 strikes, 2 min wait, 2 more strikes, then full stop.
// Emails owner on permanent failure.
let _reloginDead = false;
let _reloginAttempts = 0;

async function ensureLoggedIn() {
  if (_reloginDead) return false;

  try {
    const loggedIn = await isLoggedIn();
    if (loggedIn) return true;
  } catch (e) {
    console.log('ensureLoggedIn check failed: ' + e.message);
  }

  console.log('Session expired. Starting re-login sequence (max 4 attempts)...');

  const username = process.env.X_USERNAME;
  const password = process.env.X_PASSWORD;
  if (!username || !password) {
    console.log('No X_USERNAME/X_PASSWORD in .env - cannot re-login');
    _reloginDead = true;
    _notifyLoginDead('No credentials in .env');
    return false;
  }

  // Cycle 1: strikes 1 and 2
  for (let strike = 1; strike <= 2; strike++) {
    _reloginAttempts++;
    console.log('Re-login attempt ' + _reloginAttempts + '/4 (cycle 1, strike ' + strike + ')...');
    try {
      const success = await login(username, password);
      if (success) {
        console.log('Re-login succeeded on attempt ' + _reloginAttempts);
        _reloginAttempts = 0;
        return true;
      }
    } catch (e) {
      console.log('Re-login attempt ' + _reloginAttempts + ' failed: ' + e.message);
    }
  }

  // Wait 2 minutes between cycles
  console.log('Re-login cycle 1 failed. Waiting 2 minutes before cycle 2...');
  await sleep(120000);

  // Cycle 2: strikes 3 and 4
  for (let strike = 1; strike <= 2; strike++) {
    _reloginAttempts++;
    console.log('Re-login attempt ' + _reloginAttempts + '/4 (cycle 2, strike ' + strike + ')...');
    try {
      const success = await login(username, password);
      if (success) {
        console.log('Re-login succeeded on attempt ' + _reloginAttempts);
        _reloginAttempts = 0;
        return true;
      }
    } catch (e) {
      console.log('Re-login attempt ' + _reloginAttempts + ' failed: ' + e.message);
    }
  }

  // All 4 attempts failed - permanent stop
  console.log('RE-LOGIN PERMANENTLY FAILED after 4 attempts. All X loops will fail until restart.');
  _reloginDead = true;
  _reloginAttempts = 0;
  _notifyLoginDead('4 consecutive login attempts failed');
  return false;
}

function _notifyLoginDead(reason) {
  try {
    const messenger = require('./messenger');
    const lines = [
      'The agent failed to re-login to X after 4 attempts.',
      '',
      'Reason: ' + reason,
      '',
      'All X loops (posting, engagement, mentions, etc.) are dead.',
      'The agent process is still running but cannot interact with X.',
      '',
      'Action required: SSH into the server and run:',
      '  node src/login.js',
      '',
      'Or provide fresh cookies via .cookies.json and restart the agent.'
    ];
    messenger.sendEmailToOwner(
      'CRITICAL: CardanoWatchers X login permanently failed',
      lines.join('\n')
    );
  } catch (e) {
    console.log('Could not send login-failure email: ' + e.message);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  launch, goto, isLoggedIn, login, ensureLoggedIn,
  humanType, click, waitFor, getText,
  screenshot, getPage, close,
  saveCookies, loadCookies, sleep, withLock
};
