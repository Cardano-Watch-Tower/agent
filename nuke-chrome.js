// Kill ALL chrome.exe processes, then delete lock
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

try {
  const r = execFileSync('wmic', [
    'process', 'where', "name='chrome.exe'",
    'get', 'processid', '/format:csv'
  ], { encoding: 'utf8' });

  const pids = r.split('\n')
    .map(l => l.trim().split(',').pop())
    .filter(p => p && p !== 'ProcessId' && /^\d+$/.test(p));

  console.log(`Found ${pids.length} Chrome processes`);

  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/F', '/PID', pid]);
    } catch (e) { /* already dead */ }
  }
  console.log('All Chrome killed');
} catch (e) {
  console.log('No Chrome processes found');
}

// Wait a moment for file handles to release
setTimeout(() => {
  const lockPath = path.join(__dirname, '.chrome-profile', 'lockfile');
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
      console.log('Deleted lockfile');
    } else {
      console.log('No lockfile (already clean)');
    }
  } catch (e) {
    console.log('Lock delete failed:', e.message);
  }

  const singletonPath = path.join(__dirname, '.chrome-profile', 'SingletonLock');
  try {
    if (fs.existsSync(singletonPath)) {
      fs.unlinkSync(singletonPath);
      console.log('Deleted SingletonLock');
    }
  } catch (e) { /* ok */ }

  console.log('Done - ready to launch');
}, 2000);
