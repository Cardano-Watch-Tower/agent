/**
 * POSTER — Browser-based X posting for CardanoWatchTower
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
 */
const browser = require('./browser');

const BOT_USERNAME = process.env.X_USERNAME || 'CardanoWT';

// === Posting ===

/**
 * Post a single tweet via browser.
 * Navigates to compose, types, clicks post.
 * Returns the tweet URL or null.
 */
async function postTweet(text, replyToId = null) {
  const page = await browser.getPage();

  if (replyToId) {
    // Navigate to the tweet and reply
    return await replyToTweet(replyToId, text);
  }

  // Navigate to home (compose box is there)
  await browser.goto('https://x.com/home');
  await browser.sleep(2000);

  // Click the compose area
  try {
    const composeSelector = '[data-testid="tweetTextarea_0"]';
    await page.waitForSelector(composeSelector, { timeout: 10000 });
    await page.click(composeSelector);
    await browser.sleep(500);

    // Type the tweet with human-like delays
    await page.keyboard.type(text, { delay: 20 + Math.random() * 30 });
    await browser.sleep(1000);

    // Click the post button
    const postButton = await page.waitForSelector('[data-testid="tweetButtonInline"]', { timeout: 5000 });
    await postButton.click();
    await browser.sleep(3000);

    // Save cookies after posting
    await browser.saveCookies();

    console.log(`✓ Posted tweet: ${text.substring(0, 80)}...`);
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
 * background requests prevent idle). Use domcontentloaded + explicit waits
 * for the React content to hydrate.
 */
async function replyToTweet(tweetId, text) {
  const page = await browser.getPage();

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
      // Reply box not visible — try clicking the reply icon on the tweet to open it
      console.log('  Reply box not visible — clicking reply icon...');
      const replyIcon = await page.$('[data-testid="reply"]');
      if (replyIcon) {
        await replyIcon.click();
        await browser.sleep(2000);
      }
    }

    // Now wait for the textarea (either inline or in modal)
    await page.waitForSelector(replySelector, { timeout: 15000 });
    await page.click(replySelector);
    await browser.sleep(500);

    // Type reply
    await page.keyboard.type(text, { delay: 20 + Math.random() * 30 });
    await browser.sleep(1000);

    // Click reply/post button — could be inline or in a modal
    let postButton = await page.$('[data-testid="tweetButtonInline"]');
    if (!postButton) {
      postButton = await page.$('[data-testid="tweetButton"]');
    }
    if (postButton) {
      await postButton.click();
    } else {
      throw new Error('Could not find post/reply button');
    }

    await browser.sleep(3000);
    await browser.saveCookies();
    console.log(`✓ Replied to ${tweetId}: ${text.substring(0, 80)}...`);
    return true;
  } catch (e) {
    console.error(`✗ Reply failed: ${e.message}`);
    await browser.screenshot('reply-failed');
    throw e;
  }
}

/**
 * Post a thread (array of tweet texts).
 * Posts first tweet, then replies to each in chain.
 */
async function postThread(tweets) {
  if (tweets.length === 0) return [];

  // Post first tweet
  await postTweet(tweets[0]);
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

  for (let i = 1; i < tweets.length; i++) {
    await browser.sleep(2000);
    await replyToTweet(lastTweetUrl, tweets[i]);
    results.push(true);

    // After replying, the new reply should be on our profile
    // For now, continue replying to the same thread URL
    // X shows all replies in the thread view
  }

  return results;
}

/**
 * Get recent mentions by scraping notifications.
 * Returns array of { id, text, authorUsername, authorName }.
 */
async function getMentions(lastSeenText = null) {
  const page = await browser.getPage();

  await browser.goto('https://x.com/notifications/mentions');
  await browser.sleep(3000);

  const mentions = await page.evaluate((lastSeen) => {
    const results = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    for (const article of articles) {
      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = textEl ? textEl.textContent : '';

      // Stop if we hit the last seen mention
      if (lastSeen && text.includes(lastSeen)) break;

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
  }, lastSeenText);

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

module.exports = {
  postTweet,
  postThread,
  getMentions,
  reply,
  splitForThread,
  isConfigured,
  searchTweets,
  likeTweet,
  followUser,
  getFollowers,
  BOT_USERNAME
};
