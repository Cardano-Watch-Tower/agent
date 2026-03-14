const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DATA_DIR = path.join(__dirname, 'data');

async function main() {
  // 1. Read the timeseries CSV
  const csv = fs.readFileSync(path.join(DATA_DIR, 'whale-reward-timeseries.csv'), 'utf-8');
  const lines = csv.trim().split('\n').slice(1); // skip header

  // Aggregate all whales: per-epoch total rewards
  const epochTotals = new Map(); // epoch -> total reward across all whales
  const topWhaleKey = 'stake1u9f9v0z5zzlldgx58n8tklphu8mf7h4jvp2j2gddluemnssjfnkzz';
  const topWhaleCum = new Map(); // epoch -> cumulative for top whale

  for (const line of lines) {
    const [stake, epoch, reward, cumulative, pool] = line.split(',');
    const ep = parseInt(epoch);
    const rew = parseInt(reward);

    epochTotals.set(ep, (epochTotals.get(ep) || 0) + rew);

    if (stake === topWhaleKey) {
      topWhaleCum.set(ep, parseInt(cumulative));
    }
  }

  // Sort epochs
  const epochs = [...epochTotals.keys()].sort((a, b) => a - b);

  // Build cumulative for ALL whales combined
  let allCum = 0;
  const allWhaleData = [];
  for (const ep of epochs) {
    allCum += epochTotals.get(ep);
    allWhaleData.push({ epoch: ep, cumulative: allCum });
  }

  // Sample every 10th epoch for chart readability (plus first and last)
  const sampled = allWhaleData.filter((d, i) =>
    i === 0 || i === allWhaleData.length - 1 || i % 10 === 0
  );

  const chartLabels = sampled.map(d => 'E' + d.epoch);
  const chartData = sampled.map(d => d.cumulative);

  console.log(`Epochs: ${epochs.length}, Sampled points: ${sampled.length}`);
  console.log(`First: E${epochs[0]}, Last: E${epochs[epochs.length-1]}`);
  console.log(`Total cumulative: ${allCum.toLocaleString()} ADA`);

  // 2. Read the HTML
  let html = fs.readFileSync(path.join(DATA_DIR, 'genesis-flowchart.html'), 'utf-8');

  // 3. Replace the simulated whale rewards chart with real data
  const oldChartBlock = /\/\/ Whale Rewards Chart.*?}\);/s;
  const newChartBlock = `// Whale Rewards Chart - REAL on-chain data from Blockfrost
new Chart(document.getElementById('rewardsChart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(chartLabels)},
    datasets: [{
      label: 'Cumulative Rewards (ADA)',
      data: ${JSON.stringify(chartData)},
      borderColor: '#ff44aa',
      backgroundColor: 'rgba(255,68,170,0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 2,
      pointBackgroundColor: '#ff44aa'
    }]
  },
  options: {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#667788', maxTicksLimit: 10 }, grid: { color: '#1a1a2e' } },
      y: { ticks: { color: '#667788', callback: function(v) { return (v/1e6).toFixed(1) + 'M'; } }, grid: { color: '#1a1a2e' } }
    }
  }
});`;

  html = html.replace(oldChartBlock, newChartBlock);

  // Also update the chart title to reflect all whales
  html = html.replace(
    'Top Whale Cumulative Rewards Over Time',
    'All Tracked Whales: Cumulative Rewards (Real On-Chain Data)'
  );

  // Save updated HTML
  const updatedPath = path.join(DATA_DIR, 'genesis-flowchart-final.html');
  fs.writeFileSync(updatedPath, html);
  console.log(`Updated HTML saved to ${updatedPath}`);

  // 4. Render with Puppeteer
  console.log('Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1600 });
  await page.goto('file://' + updatedPath, { waitUntil: 'networkidle0', timeout: 30000 });

  // Wait for charts to render
  await new Promise(r => setTimeout(r, 2000));

  // Get actual content height
  const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.setViewport({ width: 1200, height: bodyHeight + 60 });
  await new Promise(r => setTimeout(r, 500));

  const screenshotPath = path.join(DATA_DIR, 'genesis-flowchart.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(`Screenshot saved to ${screenshotPath}`);
  const stats = fs.statSync(screenshotPath);
  console.log(`Size: ${(stats.size / 1024).toFixed(0)} KB`);

  await browser.close();
  console.log('Done!');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
