/**
 * Debug login — takes screenshots at every step to see what X shows.
 */
require('dotenv').config();
const browser = require('./src/browser');

(async () => {
  try {
    await browser.launch();
    const page = await browser.getPage();

    console.log('🔐 Navigating to login...');
    await page.goto('https://x.com/i/flow/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await browser.sleep(3000);
    await browser.screenshot('login-1-initial');

    // Enter username
    console.log('Entering username...');
    const usernameInput = await page.waitForSelector('input[autocomplete="username"]', { timeout: 10000 });
    await usernameInput.type(process.env.X_USERNAME, { delay: 50 });
    await browser.sleep(500);
    await browser.screenshot('login-2-username-typed');

    // Click Next
    const nextButtons = await page.$$('button');
    for (const btn of nextButtons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text.includes('Next')) {
        await btn.click();
        console.log('Clicked Next');
        break;
      }
    }
    await browser.sleep(3000);
    await browser.screenshot('login-3-after-next');

    // Check what's on screen
    const pageContent = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.map(i => ({
        type: i.type,
        name: i.name,
        autocomplete: i.autocomplete,
        placeholder: i.placeholder,
        testid: i.getAttribute('data-testid')
      }));
    });
    console.log('Visible inputs:', JSON.stringify(pageContent, null, 2));

    // Check for verification prompt
    const verifyInput = await page.$('input[data-testid="ocfEnterTextTextInput"]');
    if (verifyInput) {
      console.log('⚠️  X is asking for verification (email/phone)');
      await browser.screenshot('login-4-verification');
    }

    // Try to find password field with broader selector
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) {
      console.log('Found password field, entering password...');
      await pwInput.type(process.env.X_PASSWORD, { delay: 50 });
      await browser.sleep(500);
      await browser.screenshot('login-5-password-typed');

      // Click Log in
      const loginButtons = await page.$$('button');
      for (const btn of loginButtons) {
        const text = await page.evaluate(el => el.textContent, btn);
        if (text.includes('Log in')) {
          await btn.click();
          console.log('Clicked Log in');
          break;
        }
      }
      await browser.sleep(5000);
      await browser.screenshot('login-6-after-login');
    } else {
      console.log('No password field found');
    }

    const loggedIn = await browser.isLoggedIn();
    console.log('Final status — logged in:', loggedIn);
    if (loggedIn) await browser.saveCookies();

    await browser.close();
    process.exit(loggedIn ? 0 : 1);
  } catch (e) {
    console.error('Error:', e.message);
    try { await browser.screenshot('login-error'); } catch(x) {}
    await browser.close();
    process.exit(1);
  }
})();
