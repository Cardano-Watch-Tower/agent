require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');

const files = [
  { html: 'emurgo-circular.html', png: 'emurgo-circular.png' },
  { html: 'governance-breakdown.html', png: 'governance-breakdown.png' }
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  for (const file of files) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const htmlPath = path.resolve(__dirname, 'data', file.html);
    await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 1000));

    const container = await page.$('.container');
    const box = await container.boundingBox();

    const outPath = path.resolve(__dirname, 'data', file.png);
    await page.screenshot({
      path: outPath,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height }
    });

    console.log(`Rendered ${file.png}: ${box.width} x ${box.height}`);
    await page.close();
  }

  await browser.close();
  console.log('All done.');
})();
