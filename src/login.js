/**
 * LOGIN — One-time X login for CardanoWatchTower
 *
 * Run this once to log into X. Cookies persist after that.
 *
 * Usage:
 *   node src/login.js                    — auto-login with .env credentials
 *   node src/login.js --manual           — opens browser for manual login
 *
 * After successful login, cookies are saved to .cookies.json
 * and the Chrome profile in .chrome-profile/ stays logged in.
 * You shouldn't need to run this again unless cookies expire.
 */
require('dotenv').config();
const browser = require('./browser');

const MANUAL = process.argv.includes('--manual');

async function main() {
  console.log('🔐 CardanoWatchTower — X Login\n');

  if (MANUAL) {
    // Launch visible browser for manual login
    console.log('Opening Chrome for manual login...');
    console.log('Log in to X, then press Ctrl+C when done.\n');

    // Override to launch visible
    const puppeteer = require('puppeteer-core');
    const fs = require('fs');
    const path = require('path');

    const chromePath = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.CHROME_PATH
    ].filter(Boolean).find(p => fs.existsSync(p));

    const userDataDir = path.join(__dirname, '..', '.chrome-profile');
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    const b = await puppeteer.launch({
      executablePath: chromePath,
      headless: false,  // VISIBLE for manual login
      userDataDir,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,900'
      ],
      defaultViewport: null
    });

    const page = (await b.pages())[0];
    await page.goto('https://x.com/login');

    // Wait for user to close or Ctrl+C
    process.on('SIGINT', async () => {
      console.log('\nSaving cookies and closing...');
      const cookies = await page.cookies();
      const cookiesFile = path.join(__dirname, '..', '.cookies.json');
      fs.writeFileSync(cookiesFile, JSON.stringify(cookies, null, 2));
      console.log(`✓ Saved ${cookies.length} cookies`);
      await b.close();
      process.exit(0);
    });

    // Keep alive
    await new Promise(() => {});
  } else {
    // Auto-login with credentials from .env
    const username = process.env.X_USERNAME;
    const password = process.env.X_PASSWORD;

    if (!username || !password) {
      console.log('Set X_USERNAME and X_PASSWORD in .env, or use --manual flag.\n');
      console.log('  X_USERNAME=CardanoWT');
      console.log('  X_PASSWORD=your_password_here\n');
      process.exit(1);
    }

    // Check if already logged in
    const alreadyIn = await browser.isLoggedIn();
    if (alreadyIn) {
      console.log('✓ Already logged into X! No action needed.');
      await browser.close();
      process.exit(0);
    }

    // Login
    const success = await browser.login(username, password);

    if (success) {
      console.log('\n✓ Login successful! Cookies saved.');
      console.log('  The agent will stay logged in across restarts.');
    } else {
      console.log('\n✗ Login may have failed.');
      console.log('  Try: node src/login.js --manual');
    }

    await browser.close();
    process.exit(success ? 0 : 1);
  }
}

main().catch(e => {
  console.error('Login error:', e.message);
  process.exit(1);
});
