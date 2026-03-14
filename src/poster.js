/**
 * POSTER — Browser-based X posting for CardanoWatchers
 *
 * No API. No OAuth. No dev account. No tier fees.
 * Just a browser typing and clicking like any user.
 *
 * Handles:
 *   - Posting tweets (compose box → type → click post)
 *   - Posting threads (reply to own tweets)
 *   - Reading mentions (notifications page scrape)
 *   - Replying to tweets (navigate → reply)
 *   - Liking tweets
 *   - Following users
 *   - Attaching images to tweets and replies
 */
const browser = require('./browser');
const { withLock } = browser;
const fs = require('fs');
const path = require('path');

const BOT_USERNAME = process.env.BOT_HANDLE || process.env.X_USERNAME || 'CardanoWatchers';

// === Image Attachment ===

/**
 * Attach an image to the current compose/reply box.
 * Call AFTER text is typed but BEFORE clicking post/reply.
 *
 * @param {object} page - Puppeteer page object
 * @param {string} imagePath - Absolute path to image file
 * @returns {boolean} true if image was attached, false if skipped
 */
async function attachImage(page, imagePath) {
  if (!imagePath) return false;

  // Check file exists
  if (!fs.existsSync(imagePath)) {
    console.log(`⚠️  Image not found: ${imagePath} — posting without image`);
    return false;
  }

  try {
    // Primary selector: X's stable test ID for file input
    let fileInput = await page.$('input[data-testid="fileInput"]');

    if (!fileInput) {
      // Fallback: click the media button to inject file input into DOM
      const mediaButton = await page.$('[data-testid="tweetMediaButton"]');
      if (mediaButton) {
        await mediaButton.click();
        await browser.sleep(1000);
        fileInput = await page.$('input[data-testid="fileInput"]');
      }
    }

    if (!fileInput) {
      // Last resort: generic file input
      fileInput = await page.$('input[type="file"][accept*="image"]');
    }

    if (!fileInput) {
      console.log('⚠️  Could not find file input — posting without image');
      return false;
    }

    // Upload the file
    await fileInput.uploadFile(imagePath);

    // Wait for image preview to confirm upload succeeded
    const previewSelector = '[data-testid="attachments"]';
    try {
      await page.waitForSelector(previewSelector, { timeout: 8000 });
      console.log(`📎 Image attached: ${path.basename(imagePath)}`);
      return true;
    } catch (e) {
      // Preview didn't appear — retry once
      console.log('⚠️  Image preview not detected — retrying upload...');
      await browser.sleep(1000);
      await fileInput.uploadFile(imagePath);
      try {
        await page.waitForSelector(previewSelector, { timeout: 8000 });
        console.log(`📎 Image attached (retry): ${path.basename(imagePath)}`);
        return true;
      } catch (e2) {
        console.log('⚠️  Image upload failed after retry — posting without image');
        await browser.screenshot('image-upload-failed');
        return false;
      }
    }
  } catch (e) {
    console.log(`⚠️  Image attachment error: ${e.message} — posting without image`);
    return false;
  }
}

// === Posting ===

/**
 * Post a single tweet via browser.
 * Navigates to compose, types, clicks post.
 *
 * @param {string} text - Tweet text
 * @param {object|string|null} options - Either:
 *   - string: treated as replyToId (backward compat)
 *   - object: { replyToId, imagePath }
 *   - null: simple tweet
 * @returns {boolean} true on success
 */
async function postTweet(text, options = null) {
  // Backward compat: if options is a string, it's a replyToId
  let replyToId = null;
  let imagePath = null;

  if (typeof options === 'string') {
    replyToId = options;
  } else if (options && typeof options === 'object') {
    replyToId = options.replyToId || null;
    imagePath = options.imagePath || null;
  }

  if (replyToId) {
    return await replyToTweet(replyToId, text, imagePath);
  }

  // Fresh Chrome — kill stale X JS, restore cookies, clean slate
  await browser.close();
  const page = await browser.getPage();

  // Navigate to home
  await browser.goto('https://x.com/home', 'domcontentloaded');
  await browser.sleep(2000);

  // Verify still logged in
  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
    throw new Error('X session expired — not logged in');
  }

  // Click the compose area
  try {
    const composeSelector = '[data-testid="tweetTextarea_0"]';
    await page.waitForSelector(composeSelector, { timeout: 10000 });
    await page.click(composeSelector);
    await browser.sleep(500);

    // Type the tweet with human-like delays
    await page.keyboard.type(text, { delay: 20 + Math.random() * 30 });
    await browser.sleep(1000);

    // Attach image if provided (after typing, before posting)
    if (imagePath) {
      await attachImage(page, imagePath);
      await browser.sleep(1000);
    }

    // Click the post button
    const postButton = await page.waitForSelector('[data-testid="tweetButtonInline"]', { timeout: 5000 });
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="tweetButtonInline"]');
      if (b) b.scrollIntoView({ block: 'center' });
    });
    await browser.sleep(300);
    await postButton.click();
    await browser.sleep(3000);

    // Save cookies after posting
    await browser.saveCookies();

    console.log(`✓ Posted tweet${imagePath ? ' (with image)' : ''}: ${text.substring(0, 80)}...`);
    return true;
  } catch (e) {
    console.error(`✗ Post failed: ${e.message}`);
    await browser.screenshot('post-failed');
    throw e;
  }
}

/**
 * Reply to a specific tweet by navigating to it.
 *
 * X's tweet detail pages hang with networkidle2 in headless mode (continuous
 * background requests prevent idle). Use load + explicit waits
 * for the React content to hydrate.
 *
 * @param {string} tweetId - Tweet ID or full URL
 * @param {string} text - Reply text
 * @param {string|null} imagePath - Optional image to attach
 */
async function replyToTweet(tweetId, text, imagePath = null) {
  // Fresh Chrome — kill stale X JS, restore cookies, clean slate
  await browser.close();
  const page = await browser.getPage();

  // Ensure viewport is tall enough for reply UI
  await page.setViewport({ width: 1280, height: 1800 });

  // If tweetId is a URL, go directly. Otherwise construct URL.
  const url = tweetId.startsWith('http') ? tweetId :
    `https://x.com/i/status/${tweetId}`;

  // Use 'load' instead of 'networkidle2' — tweet detail pages never go idle
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await browser.sleep(5000); // Give React time to hydrate

  try {
    const replySelector = '[data-testid="tweetTextarea_0"]';

    // Check if reply box is already visible (it is on tweet detail pages when logged in)
    let replyBox = await page.$(replySelector);

    if (!replyBox) {
      console.log('  Reply box not visible — clicking reply icon...');
      const replyIcon = await page.$('[data-testid="reply"]');
      if (replyIcon) {
        await replyIcon.click();
        await browser.sleep(2000);
      }
    }

    // Wait for textarea, scroll it into view, then click
    await page.waitForSelector(replySelector, { timeout: 15000 });
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'center' });
    }, replySelector);
    await browser.sleep(300);
    await page.click(replySelector);
    await browser.sleep(500);

    // Clear any stale text from previous failed attempts
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await browser.sleep(300);

    // Type reply
    await page.keyboard.type(text, { delay: 20 + Math.random() * 30 });
    await browser.sleep(1000);

    // Attach image if provided
    if (imagePath) {
      await attachImage(page, imagePath);
      await browser.sleep(1000);
    }

    // Find reply button — try both selectors
    let postButton = await page.$('[data-testid="tweetButtonInline"]');
    if (!postButton) {
      postButton = await page.$('[data-testid="tweetButton"]');
    }
    if (!postButton) {
      throw new Error('Could not find post/reply button');
    }

    // Check if button is enabled (text might be too long)
    const btnDisabled = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="tweetButtonInline"]') ||
                document.querySelector('[data-testid="tweetButton"]');
      return b && (b.disabled || b.getAttribute('aria-disabled') === 'true');
    });
    if (btnDisabled) {
      throw new Error('Reply button disabled — text may exceed character limit');
    }

    // Scroll button into view and click
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="tweetButtonInline"]') ||
                document.querySelector('[data-testid="tweetButton"]');
      if (b) b.scrollIntoView({ block: 'center' });
    });
    await browser.sleep(300);
    await postButton.click();

    await browser.sleep(5000);
    await browser.saveCookies();
    console.log(`✓ Replied to ${tweetId}${imagePath ? ' (with image)' : ''}: ${text.substring(0, 80)}...`);
    return true;
  } catch (e) {
    console.error(`✗ Reply failed: ${e.message}`);
    await browser.screenshot('reply-failed');
    throw e;
  }
}

/**
 * Post a thread (array of tweet texts or {text, imagePath} objects).
 * Posts first tweet, then replies to each in chain.
 *
 * @param {Array<string|{text: string, imagePath?: string}>} tweets
 */
async function postThread(tweets) {
  if (tweets.length === 0) return [];

  // Normalize: convert strings to objects
  const normalized = tweets.map(t =>
    typeof t === 'string' ? { text: t, imagePath: null } : t
  );

  // Post first tweet
  await postTweet(normalized[0].text, { imagePath: normalized[0].imagePath });
  await browser.sleep(2000);

  // Navigate to our profile to find the tweet we just posted
  const page = await browser.getPage();
  await browser.goto(`https://x.com/${BOT_USERNAME}`);
  await browser.sleep(3000);

  // Get the first tweet link from our profile
  const firstTweetLink = await page.evaluate(() => {
    const tweets = document.querySelectorAll('article[data-testid="tweet"]');
    if (tweets.length > 0) {
      const link = tweets[0].querySelector('a[href*="/status/"]');
      return link ? link.href : null;
    }
    return null;
  });

  if (!firstTweetLink) {
    console.log('⚠️  Could not find posted tweet to thread');
    return [true];
  }

  // Reply chain for remaining tweets
  const results = [true];
  let lastTweetUrl = firstTweetLink;

  for (let i = 1; i < normalized.length; i++) {
    await browser.sleep(2000);
    await replyToTweet(lastTweetUrl, normalized[i].text, normalized[i].imagePath);
    results.push(true);
  }

  return results;
}

/**
 * Get recent mentions by scraping notifications.
 * Returns array of { id, text, authorUsername, authorName }.
 */
async function getMentions(lastSeenId = null) {
  const page = await browser.getPage();

  await browser.goto('https://x.com/notifications/mentions');
  await browser.sleep(3000);

  const mentions = await page.evaluate((lastSeenId) => {
    const results = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    for (const article of articles) {
      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = textEl ? textEl.textContent : '';

      // Get author info
      const userLinks = article.querySelectorAll('a[href^="/"]');
      let authorUsername = '';
      let authorName = '';
      for (const link of userLinks) {
        const href = link.getAttribute('href');
        if (href && href.match(/^\/[a-zA-Z0-9_]+$/) && !href.includes('/status/')) {
          authorUsername = href.substring(1);
          authorName = link.textContent || authorUsername;
          break;
        }
      }

      // Get tweet link for the ID
      const statusLink = article.querySelector('a[href*="/status/"]');
      const tweetUrl = statusLink ? statusLink.href : '';
      const tweetId = tweetUrl.match(/\/status\/(\d+)/)?.[1] || '';

      // Get timestamp
      const timeEl = article.querySelector('time');
      const createdAt = timeEl ? timeEl.getAttribute('datetime') : '';

      if (text && authorUsername) {
        results.push({
          id: tweetId,
          text,
          authorUsername,
          authorName,
          createdAt,
          url: tweetUrl
        });
      }
    }

    return results;
  }, lastSeenId);

  // Filter out mentions we already processed (by ID comparison)
  if (lastSeenId) {
    const lastBig = BigInt(lastSeenId);
    return mentions.filter(m => m.id && BigInt(m.id) > lastBig);
  }

  await browser.saveCookies();
  return mentions;
}

/**
 * Reply to a tweet (alias for replyToTweet).
 */
async function reply(tweetId, text) {
  return replyToTweet(tweetId, text);
}

/**
 * Like a tweet by navigating to it and clicking the heart.
 */
async function likeTweet(tweetIdOrUrl) {
  const page = await browser.getPage();
  const url = tweetIdOrUrl.startsWith('http') ? tweetIdOrUrl :
    `https://x.com/i/status/${tweetIdOrUrl}`;

  await browser.goto(url);
  await browser.sleep(2000);

  try {
    const likeButton = await page.waitForSelector('[data-testid="like"]', { timeout: 5000 });
    await likeButton.click();
    await browser.sleep(1000);
    return true;
  } catch (e) {
    // Already liked or button not found
    return false;
  }
}

/**
 * Follow a user by navigating to their profile.
 */
async function followUser(username) {
  const page = await browser.getPage();
  await browser.goto(`https://x.com/${username}`);
  await browser.sleep(2000);

  try {
    // Look for Follow button (not Following — that means already followed)
    const followButton = await page.evaluate(() => {
      const buttons = document.querySelectorAll('[data-testid$="-follow"]');
      for (const btn of buttons) {
        if (btn.getAttribute('data-testid') === `${btn.getAttribute('data-testid')}` &&
            !btn.textContent.includes('Following')) {
          return true;
        }
      }
      return false;
    });

    if (followButton) {
      const btn = await page.$('[data-testid$="-follow"]');
      if (btn) {
        await btn.click();
        await browser.sleep(1000);
        return true;
      }
    }
    return false; // Already following
  } catch (e) {
    return false;
  }
}

/**
 * Search tweets by navigating to X search.
 * Returns array of { text, authorUsername, tweetUrl, metrics }.
 */
async function searchTweets(query, maxResults = 10) {
  const page = await browser.getPage();
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(query)}&f=live`;

  await browser.goto(searchUrl);
  await browser.sleep(3000);

  const tweets = await page.evaluate((max) => {
    const results = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    for (const article of articles) {
      if (results.length >= max) break;

      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = textEl ? textEl.textContent : '';
      if (!text) continue;

      // Author
      const userLinks = article.querySelectorAll('a[href^="/"]');
      let authorUsername = '';
      for (const link of userLinks) {
        const href = link.getAttribute('href');
        if (href && href.match(/^\/[a-zA-Z0-9_]+$/) && !href.includes('/status/')) {
          authorUsername = href.substring(1);
          break;
        }
      }

      // Tweet URL
      const statusLink = article.querySelector('a[href*="/status/"]');
      const tweetUrl = statusLink ? statusLink.href : '';
      const tweetId = tweetUrl.match(/\/status\/(\d+)/)?.[1] || '';

      // Metrics (approximate from displayed numbers)
      const metricsEls = article.querySelectorAll('[data-testid$="count"]');
      const metrics = {};

      results.push({
        id: tweetId,
        text,
        authorUsername,
        url: tweetUrl,
        metrics
      });
    }

    return results;
  }, maxResults);

  return tweets;
}

/**
 * Get followers from the followers page.
 */
async function getFollowers(maxResults = 50) {
  const page = await browser.getPage();
  await browser.goto(`https://x.com/${BOT_USERNAME}/followers`);
  await browser.sleep(3000);

  const followers = await page.evaluate((max) => {
    const results = [];
    const cells = document.querySelectorAll('[data-testid="UserCell"]');

    for (const cell of cells) {
      if (results.length >= max) break;

      const links = cell.querySelectorAll('a[href^="/"]');
      let username = '';
      let name = '';
      for (const link of links) {
        const href = link.getAttribute('href');
        if (href && href.match(/^\/[a-zA-Z0-9_]+$/)) {
          username = href.substring(1);
          name = link.textContent || username;
          break;
        }
      }

      if (username) {
        results.push({ username, name });
      }
    }

    return results;
  }, maxResults);

  return followers;
}

/**
 * Split long text into tweet-sized chunks for threading.
 */
function splitForThread(text, maxLen = 275) {
  if (text.length <= maxLen) return [text];

  const tweets = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      tweets.push(remaining);
      break;
    }

    let breakPoint = maxLen;
    const periodIdx = remaining.lastIndexOf('. ', maxLen);
    const newlineIdx = remaining.lastIndexOf('\n', maxLen);

    if (periodIdx > maxLen * 0.5) breakPoint = periodIdx + 1;
    else if (newlineIdx > maxLen * 0.5) breakPoint = newlineIdx;

    const chunk = remaining.substring(0, breakPoint).trim();
    tweets.push(chunk);
    remaining = remaining.substring(breakPoint).trim();
  }

  if (tweets.length > 2) {
    return tweets.map((t, i) => `${i + 1}/${tweets.length} ${t}`);
  }

  return tweets;
}

/**
 * Check if browser is ready and logged in.
 */
async function isConfigured() {
  try {
    return await browser.isLoggedIn();
  } catch (e) {
    return false;
  }
}


/**
 * Repost (retweet) a tweet by navigating to it and clicking the Repost button.
 * @param {string} tweetUrl - Full URL of the tweet to repost
 */
async function retweetPost(tweetUrl) {
  const page = await browser.getPage();
  await browser.goto(tweetUrl);
  await browser.sleep(2500);

  const retweetBtn = await page.$('[data-testid="retweet"]');
  if (!retweetBtn) {
    throw new Error('Repost button not found on: ' + tweetUrl);
  }
  await retweetBtn.click();
  await browser.sleep(1200);

  const confirmBtn = await page.$('[data-testid="retweetConfirm"]');
  if (!confirmBtn) {
    throw new Error('Repost confirm button not found');
  }
  await confirmBtn.click();
  await browser.sleep(1500);

  console.log('  Reposted: ' + tweetUrl);
  return true;
}

// Wrap browser-using functions with lock to prevent concurrent Chrome navigation
module.exports = {
  postTweet: (...args) => withLock(() => postTweet(...args)),
  postThread: (...args) => withLock(() => postThread(...args)),
  getMentions: (...args) => withLock(() => getMentions(...args)),
  reply: (...args) => withLock(() => reply(...args)),
  replyToTweet: (...args) => withLock(() => replyToTweet(...args)),
  splitForThread,
  isConfigured,
  searchTweets: (...args) => withLock(() => searchTweets(...args)),
  likeTweet: (...args) => withLock(() => likeTweet(...args)),
  followUser: (...args) => withLock(() => followUser(...args)),
  getFollowers: (...args) => withLock(() => getFollowers(...args)),
  retweetPost: (...args) => withLock(() => retweetPost(...args)),
  attachImage,
  BOT_USERNAME
};
