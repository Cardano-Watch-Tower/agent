# Architecture — CardanoWatchers Agent

## System Overview

A headless Chrome-based X (Twitter) bot that monitors Cardano blockchain activity,
posts whale alerts, responds to mentions with on-chain investigations, and tracks
follow-up promises. Runs on Oracle Cloud (Linux).

```
index.js (orchestrator)
    |
    +-- browser.js (Chrome session manager) --> Chrome (headless)
    |       |
    +-- poster.js (post/reply/like/search) -----+
    +-- brain.js (xAI Grok API)
    +-- investigator.js (Blockfrost API)
    +-- followups.js (promise tracking)
    +-- engager.js (community engagement)
    +-- analyst.js (error patterns + circuit breaker)
    +-- messenger.js (email/notification service)
    +-- watcher.js (Blockfrost chain poller)
```

## File Map

### Core Runtime
| File | Purpose |
|------|---------|
| `src/index.js` | Main orchestrator. Runs 10 parallel loops |
| `src/browser.js` | Puppeteer Chrome session manager. Singleton, persistent profile, lock recovery, login with cooldown, auto re-login (ensureLoggedIn) |
| `src/poster.js` | X interactions: post, reply, like, follow, search, mentions, threads. All functions protected by ensureLoggedIn() |
| `src/brain.js` | LLM via xAI Grok. Tweet drafts, replies, investigation responses, thoughts |
| `src/investigator.js` | Blockfrost API. Addresses, transactions, stake keys, DReps |
| `src/followups.js` | Promise detection + delivery queue |
| `src/engager.js` | Community engagement. Search, like, follow, reply with value |
| `src/analyst.js` | Error pattern detection and X safety circuit breaker |
| `src/messenger.js` | Notification service. Email alerts, escalations, hourly status |
| `src/watcher.js` | Blockfrost chain poller. Whale transactions (>5M ADA) |
| `src/detective.js` | Investigation engine for user-requested on-chain lookups |
| `src/repo-monitor.js` | GitHub repo watcher |
| `src/login.js` | Standalone login utility. Auto or manual, saves cookies |

### Data Files (Runtime, Gitignored)
| File | Purpose |
|------|---------|
| `.env` | Credentials: X_USERNAME (email), X_PASSWORD, BOT_HANDLE, API keys |
| `.cookies.json` | X session cookies (persisted across restarts) |
| `.chrome-profile/` | Chrome profile directory |
| `followups.json` | Follow-up queue |
| `daily-stats.json` | Block count, alert count, engagement counts |
| `screenshots/` | Debug screenshots from failed operations |

## Loop Architecture

index.js runs 10 concurrent loops:

1. Chain Watch - polls Blockfrost every 20s, detects >5M ADA transactions
2. Mention Watch - checks X notifications every 2 min, routes to investigator or brain
3. Daily Digest - posts daily summary at configured time
4. Follow-Up Processor - processes queued investigation promises every 2 min
5. Community Engagement - searches Cardano tweets every 30 min. Caps: 3-5 replies, 5-10 follows, 5-10 reposts/day
6. Repo Monitor - tracks GitHub repos for commits/releases
7. Original Thoughts - 3-5 tweets/day (every 3 hours). Watchdog observations
8. Help Reminders - 5/week. Reminds community CardanoWatchers is available
9. Messenger - hourly status reports and escalation delivery
10. Analyst - error pattern monitoring, circuit breaker enforcement

## Safety Systems

### Global Tweet Rate Limiter (poster.js)
- 5-minute minimum gap between tweets
- 15 tweets/day hard cap
- Thread continuations exempt - entire thread counts as 1 tweet
- Daily counter resets at midnight UTC

### Circuit Breaker (analyst.js)
- 2 X-interaction errors = 5-minute freeze on ALL X loops
- After freeze, strikes reset and loops resume
- Same error 5+ times in 6 hours triggers email alert

### Auto Re-Login (browser.js - ensureLoggedIn)
- Called before every X interaction
- If session valid, returns immediately
- If expired: Cycle 1 (2 attempts), 2 min wait, Cycle 2 (2 attempts)
- After 4 total failures: permanent stop, emails owner, never retries until restart
- Uses email-based login (X_USERNAME = email in .env)

### Thread Reply Chaining (poster.js + index.js)
- Each chunk replies to the previous chunk (proper thread)
- 30 seconds between chunks
- Numbered automatically by splitForThread()
- Brain prompt instructs Grok NOT to add its own numbering or @mentions

### Engagement Caps (engager.js)
- Daily randomized targets within ranges
- Caps persist to daily-stats.json to survive restarts

## Key Design Decisions

1. No X API - pure browser automation. No dev account, no OAuth, no tier fees.
2. Persistent Chrome profile - cookies survive restarts. Auto re-login as fallback.
3. Cookie origin matters - cookies from local IP may expire on datacenter IP. Login from server when possible.
4. waitUntil load for replies - X tweet detail pages never reach networkidle2.
5. 2-minute login cooldown - prevents account blocks from repeated login attempts.
6. Follow-up as separate loop - decoupled from mention processing.
7. Thread continuations bypass rate limiter - one logical post, 30s spacing.
