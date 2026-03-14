require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const htmlPath = path.resolve(__dirname, 'data/genesis-disruption.html');
  await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1000));

  const container = await page.$('.container');
  const box = await container.boundingBox();

  await page.screenshot({
    path: path.resolve(__dirname, 'data/genesis-disruption.png'),
    clip: { x: box.x, y: box.y, width: box.width, height: box.height }
  });

  console.log('Rendered:', box.width, 'x', box.height);
  await browser.close();
  console.log('Done.');
})();
