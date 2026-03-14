// Cleanup: kill agent processes + delete Chrome lock
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Kill agent node processes
try {
  const r = execFileSync('wmic', [
    'process', 'where',
    "commandline like '%CardanoWatchTower%index.js%'",
    'get', 'processid', '/format:csv'
  ], { encoding: 'utf8' });

  const pids = r.split('\n')
    .map(l => l.trim().split(',').pop())
    .filter(p => p && p !== 'ProcessId' && /^\d+$/.test(p));

  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/F', '/PID', pid]);
      console.log('Killed agent PID:', pid);
    } catch (e) {
      console.log('Already dead:', pid);
    }
  }
  if (pids.length === 0) console.log('No agent processes found');
} catch (e) {
  console.log('No agent processes to kill');
}

// Delete Chrome lock file
const lockPath = path.join(__dirname, '.chrome-profile', 'lockfile');
try {
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath);
    console.log('Deleted lockfile');
  } else {
    console.log('No lockfile found');
  }
} catch (e) {
  console.log('Lockfile delete failed:', e.message, '(Chrome processes may still be running)');
}

// Also check SingletonLock
const singletonPath = path.join(__dirname, '.chrome-profile', 'SingletonLock');
try {
  if (fs.existsSync(singletonPath)) {
    fs.unlinkSync(singletonPath);
    console.log('Deleted SingletonLock');
  }
} catch (e) { /* ignore */ }

console.log('Cleanup done');
