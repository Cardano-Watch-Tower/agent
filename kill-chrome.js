// Kill orphaned Chrome processes using the agent's profile
const { execFileSync } = require('child_process');

try {
  const r = execFileSync('wmic', [
    'process', 'where',
    "commandline like '%CardanoWatchTower%chrome-profile%'",
    'get', 'processid', '/format:csv'
  ], { encoding: 'utf8' });

  const pids = r.split('\n')
    .map(l => l.trim().split(',').pop())
    .filter(p => p && p !== 'ProcessId' && !isNaN(p));

  if (pids.length === 0) {
    console.log('No orphaned Chrome processes found.');
    process.exit(0);
  }

  console.log(`Found ${pids.length} Chrome processes: ${pids.join(', ')}`);
  const args = ['/F'].concat(pids.flatMap(p => ['/PID', p]));
  execFileSync('taskkill', args, { encoding: 'utf8' });
  console.log('Killed all.');
} catch (e) {
  console.error(e.message);
}
