# Process Management — CardanoWatchTower Agent

## Quick Reference: Kill Everything and Restart

```powershell
# 1. Kill agent + all Chrome (guaranteed clean slate)
powershell -Command "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue; Stop-Process -Name node -Force -ErrorAction SilentlyContinue"

# 2. Wait for OS to release file handles (CRITICAL on Windows)
ping -n 6 127.0.0.1 >nul

# 3. Clean Chrome lock files
node -e "const fs=require('fs'),p=require('path'),d=p.join('C:\\Users\\thisc\\Documents\\Projects\\CardanoWatchTower\\watchers\\agent','.chrome-profile');['lockfile','SingletonLock','SingletonCookie','SingletonSocket','DevToolsActivePort'].forEach(f=>{const fp=p.join(d,f);try{if(fs.existsSync(fp)){fs.unlinkSync(fp);console.log('Deleted:',f)}}catch(e){console.log('Skip:',f,e.code)}})"

# 4. Start agent
cd C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent
node src/index.js
```

**WARNING:** Step 1 kills ALL node and chrome. If nullifAi bridge or other processes
are running, kill selectively instead (see Selective Kill below).

---

## Exact Paths

| What | Path |
|------|------|
| Agent entry | `C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\src\index.js` |
| Browser manager | `C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\src\browser.js` |
| Chrome profile | `C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\.chrome-profile\` |
| Cookies | `C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\.cookies.json` |
| Screenshots | `C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\screenshots\` |
| Follow-ups queue | `C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\followups.json` |
| Environment | `C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\.env` |

---

## Selective Kill (Preserve Other Processes)

### Find agent processes
```powershell
powershell "Get-WmiObject Win32_Process -Filter 'name=''node.exe''' | Select-Object ProcessId,CommandLine | Format-List"
```

Look for `src/index.js` — that's the agent. Other processes:
- `nullifai-bridge.js` — nullifAi (DON'T KILL)
- `desktopcommandermcp` — Claude Code MCP (DON'T KILL)
- `neighborhood-scan.js` — scan script (kill if needed)

### Kill specific PIDs
```powershell
powershell -Command "Stop-Process -Id <PID1>,<PID2> -Force"
```

### Kill Chrome only (leaves Node alone)
```powershell
taskkill /F /IM chrome.exe
```

---

## Chrome Lock File Problem (Windows-Specific)

### The Bug
Puppeteer on Windows checks for `lockfile` existence after Chrome crashes.
Chrome creates `lockfile` during startup, then crashes. Puppeteer sees the fresh
lockfile and thinks "already running" — even though it was created by the process
that just crashed. This causes `puppeteer.launch()` to throw.

### Lock files Chrome uses (ALL must be cleaned)
```
.chrome-profile/lockfile
.chrome-profile/SingletonLock
.chrome-profile/SingletonCookie
.chrome-profile/SingletonSocket
.chrome-profile/DevToolsActivePort
```

### The Fix (built into browser.js)
`browser.js` has a 3-layer defense:
1. **Pre-clean**: `cleanLockFiles()` runs BEFORE `puppeteer.launch()`
2. **Retry**: If launch fails with "already running" or "lock", it:
   - Detaches the failed browser's event handlers
   - Runs `killOrphanedChrome()` (nuclear `taskkill /F /IM chrome.exe`)
   - Waits 3 seconds for OS file handle release
   - Cleans ALL 5 lock files again
   - Retries `puppeteer.launch()`
3. **Identity-checked disconnect handler**: Only resets state if the browser that
   disconnected is still the active one (prevents stale handlers from nuking retries)

### Manual lock cleanup (when all else fails)
```powershell
# Kill everything
taskkill /F /IM chrome.exe
ping -n 6 127.0.0.1 >nul

# Delete locks manually
Remove-Item "C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\.chrome-profile\lockfile" -Force -ErrorAction SilentlyContinue
Remove-Item "C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\.chrome-profile\SingletonLock" -Force -ErrorAction SilentlyContinue
Remove-Item "C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\.chrome-profile\SingletonCookie" -Force -ErrorAction SilentlyContinue
Remove-Item "C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\.chrome-profile\SingletonSocket" -Force -ErrorAction SilentlyContinue
Remove-Item "C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent\.chrome-profile\DevToolsActivePort" -Force -ErrorAction SilentlyContinue
```

### EBUSY lockfile (file still held by OS)
If `lockfile` returns EBUSY after killing Chrome:
1. Wait longer — `ping -n 10 127.0.0.1 >nul` (10 seconds)
2. Check if Chrome respawned — some apps (Google Drive, background updater) relaunch Chrome
3. Kill again and immediately launch the agent — `browser.js` will handle the retry internally

---

## X Login Recovery

### Session still valid (most common)
The agent uses persistent cookies in `.cookies.json` and a Chrome profile in
`.chrome-profile/`. If the agent restarts, it usually auto-restores the session.

### Session expired — manual login needed
```bash
cd C:\Users\thisc\Documents\Projects\CardanoWatchTower\watchers\agent
node headful-login.js
```
This opens a visible Chrome window with the agent's profile. Log in manually at
x.com, then press Ctrl+C. Cookies are saved on exit.

### Session expired — auto login
The agent has credentials in `.env` (`X_USERNAME`, `X_PASSWORD`). The `login()`
function in `browser.js` has a 2-minute cooldown between attempts to prevent
X from blocking the account.

**CRITICAL:** If X blocks due to too many login attempts, you must verify the
account manually. Don't hammer retries.

### Login credentials
Stored in `.env` (gitignored at both `watchers/` and `watchers/agent/` levels).
NEVER commit credentials. NEVER print them to logs.

---

## Verifying Agent Is Running Correctly

### 1. Check process is alive
```powershell
powershell "Get-WmiObject Win32_Process -Filter 'name=''node.exe''' | Select-Object ProcessId,CommandLine | Format-List"
```
Look for `src/index.js` with a PID.

### 2. Check Chrome is alive
```powershell
powershell "Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"
```
Should show 8-12 Chrome processes (headless browser + subprocesses).

### 3. Check startup banner appeared
The agent prints this on successful start:
```
╔══════════════════════════════════════════════╗
║         CARDANO WATCH TOWER  👁️              ║
║         We're watching.                      ║
╠══════════════════════════════════════════════╣
║  Mode: LIVE                                 ║
║  X:    ✓ Logged in (browser)              ║
║  Brain: xAI Grok (direct)                   ║
║  Chain: Cardano mainnet                      ║
║  Follow-ups: 0   pending                      ║
╚══════════════════════════════════════════════╝
```

### 4. Check it's processing blocks
Within ~20 seconds of start, you should see:
```
📦 Block 13133912 | 14 txs
```

### 5. Check mentions are being polled
Within 2 minutes:
```
📬 Mention watch started
```

### 6. Check reply function works
If there are pending mentions, the agent replies. Look for:
```
✓ Replied to <tweet_id>: <text>...
```

If replies fail with "Navigation timeout" or "tweetTextarea_0 failed":
- The reply function uses `waitUntil: 'load'` + 5s hydration wait
- If tweet detail pages still don't render, the session may be degraded
- Fix: kill everything, clean locks, restart. If that fails, manual login via headful-login.js

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Chrome not found" | Chrome not installed or wrong path | Set `CHROME_PATH` in `.env` |
| "already running" on launch | Stale lock files from crash | `browser.js` auto-recovers; if stuck, manual lock cleanup above |
| EBUSY on lockfile | OS still releasing file handles | Wait 10s, or Chrome respawned (kill again) |
| "Navigation timeout" on reply | Tweet detail page won't load in headless | Built-in: uses `load` not `networkidle2`. If persistent, restart agent |
| "tweetTextarea_0 failed" | Reply box not rendering | Falls back to clicking reply icon. If still fails, session may be stale — re-login |
| X blocking login | Too many automated attempts | 2-min cooldown built in. If blocked, manually verify account, then use headful-login.js |
| Duplicate Chrome instances | Multiple agent starts without killing old ones | Kill all node processes running `src/index.js` first |
| Browser disconnected unexpectedly | Chrome crashed mid-operation | Agent auto-recovers on next operation (re-launches Chrome) |
| Follow-ups stuck in "processing" | Agent crashed during follow-up delivery | On restart, stuck entries retry (up to 3 attempts) |
