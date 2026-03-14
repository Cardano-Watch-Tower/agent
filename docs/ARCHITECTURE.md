# Architecture — CardanoWatchers Agent

## System Overview

A headless Chrome-based X (Twitter) bot that monitors Cardano blockchain activity,
posts whale alerts, responds to mentions with on-chain investigations, and tracks
follow-up promises.

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  index.js   │────▶│  browser.js  │────▶│  Chrome      │
│  orchestrator│    │  session mgr │     │  (headless)  │
└──────┬──────┘     └──────────────┘     └──────────────┘
       │                                        │
       ├── poster.js ───── post/reply/like ─────┘
       ├── brain.js ────── xAI Grok API
       ├── investigator.js ── Blockfrost API
       ├── followups.js ──── promise tracking
       └── engager.js ────── community engagement
```

## File Map

### Core Runtime
| File | Purpose |
|------|---------|
| `src/index.js` | Main orchestrator. Runs parallel loops: chain watch, mention watch, daily digest, follow-up processor, community engagement, repo monitor |
| `src/browser.js` | Puppeteer Chrome session manager. Singleton pattern, persistent profile, lock recovery, login with cooldown |
| `src/poster.js` | X interactions: post tweets, reply, like, follow, search, get mentions, thread posting |
| `src/brain.js` | LLM integration via xAI Grok. Generates tweet drafts, casual replies, follow-up analysis |
| `src/investigator.js` | Blockfrost API queries. Traces addresses, transactions, stake keys, delegation chains |
| `src/followups.js` | Promise detection + delivery queue. Detects when bot promises to investigate, queues the work, delivers results |
| `src/engager.js` | Community engagement. Searches for relevant tweets, likes, follows, replies with value |
| `src/login.js` | Standalone login utility. Auto or manual login, saves cookies |

### Utility Scripts
| File | Purpose |
|------|---------|
| `headful-login.js` | Opens visible Chrome for manual X login. Use when auto-login fails or session expires |
| `post-corrected-thread.js` | Posts a specific thread (genesis analysis). Template for future thread posting |
| `continue-thread.js` | Continues a partially-posted thread (finds tweet 1, posts remaining replies) |
| `delete-and-repost.js` | Deletes old tweets from profile then posts replacement thread |

### Data Files (Runtime, Gitignored)
| File | Purpose |
|------|---------|
| `.env` | Credentials: X_USERNAME, X_PASSWORD, BLOCKFROST_KEY, XAI_API_KEY, etc |
| `.cookies.json` | X session cookies (persisted across restarts) |
| `.chrome-profile/` | Full Chrome profile directory (cookies, localStorage, sessions) |
| `followups.json` | Pending/completed follow-up queue |
| `daily-stats.json` | Block count, alert count for daily digest |
| `screenshots/` | Debug screenshots from failed operations |

## Loop Architecture

`index.js` runs these concurrent loops via `Promise.all`:

1. **Chain Watch** (`chainWatchLoop`) — polls Blockfrost for new blocks every 20s.
   Detects large transactions (>100K ADA), generates tweet drafts via Grok.

2. **Mention Watch** (`mentionWatchLoop`) — checks X notifications every 2 min.
   Parses mentions for queries (addresses, tx hashes, stake keys) or casual conversation.
   Routes to `investigator.js` or `brain.js` accordingly.

3. **Daily Digest** (`dailyDigestLoop`) — posts daily summary at configured time.

4. **Follow-Up Processor** (`followUpLoop`) — every 2 min, checks for pending promises.
   Investigates the queued query, formats a result, replies to the original user.

5. **Community Engagement** (`communityEngagementLoop`) — searches for $ADA/Cardano
   tweets, likes/replies to build presence. Runs every 30 min.

6. **Repo Monitor** (`repoMonitorLoop`) — tracks GitHub repos for new commits/releases.

## Follow-Up Accountability System

### Flow
```
User mentions bot → Bot replies with promise ("I'll look into it")
                            │
                    detectPromise() matches regex
                            │
                    addFollowUp() queues investigation
                            │
                    followUpLoop() picks it up (2 min cycle)
                            │
                    investigator.js runs the query
                            │
                    brain.js formats the result
                            │
                    poster.js replies to original user
                            │
                    markDelivered() or markFailed()
```

### Promise Detection Patterns
```
i'll look/dig/check/trace/investigate/pull/grab/find/get
let me look/dig/check/trace/investigate/pull/grab/find/get
looking into it/this/that
on it
give me a sec/moment/minute
stand by
checking now/this/that/on
will report/update/get back
brb with
```

### Queue Entry Fields
```json
{
  "id": "unique-id",
  "tweetId": "original tweet to reply to",
  "username": "who we promised",
  "originalText": "what they asked",
  "promiseText": "what we promised (matched pattern)",
  "queryType": "address|tx|stake|null",
  "queryValue": "the hash/address to investigate",
  "status": "pending|processing|delivered|failed",
  "attempts": 0,
  "maxAttempts": 3
}
```

## Browser Session Lifecycle

```
launch() called
    │
    ├── Browser alive? → test with page.title() → return page
    │
    ├── Launch in progress? → await existing promise (singleton dedup)
    │
    └── _doLaunch()
            │
            ├── cleanLockFiles() — pre-clean all 5 lock types
            │
            ├── puppeteer.launch() ─── success → setup page
            │       │
            │       └── "already running" error
            │               │
            │               ├── Detach failed browser listeners
            │               ├── killOrphanedChrome() — taskkill /F /IM chrome.exe
            │               ├── Wait 3 seconds
            │               ├── cleanLockFiles() again
            │               └── puppeteer.launch() retry
            │
            ├── browser.on('disconnected') — identity-checked handler
            │   (only resets if disconnected browser === current active browser)
            │
            ├── page = browser.newPage()
            ├── Stealth: remove webdriver flag, set user agent
            └── loadCookies() from .cookies.json
```

## Key Design Decisions

1. **No X API** — Pure browser automation. No dev account, no OAuth, no tier fees.
   The bot types and clicks like any human user.

2. **Persistent Chrome profile** — Cookies, localStorage, sessions survive restarts.
   Login once (manually or auto), then cookies handle auth.

3. **Nuclear Chrome kill** — `taskkill /F /IM chrome.exe` kills ALL Chrome, not just
   ours. This is intentional — `wmic` commandline matching misses freshly-spawned
   headless Chrome. Trade-off: kills user's personal Chrome too. Acceptable because
   the agent runs on a dedicated machine.

4. **waitUntil: 'load' for replies** — X's tweet detail pages have continuous background
   requests that prevent `networkidle2` from resolving. Using `load` + 5s explicit
   wait for React hydration works reliably.

5. **2-minute login cooldown** — X blocks accounts that attempt too many logins.
   Built into `browser.js` as a hard cooldown between `login()` calls.

6. **Follow-up as separate loop** — Decoupled from mention processing. The mention
   handler queues the promise, the follow-up loop processes it independently. This
   prevents slow investigations from blocking mention processing.
