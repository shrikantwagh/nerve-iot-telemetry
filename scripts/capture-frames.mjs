/**
 * Capture real frames of the running Nerve app for a demo reel.
 *
 * Drives a headless Chrome against the local dev server, which is pointed at the LIVE
 * Xano backend — so every number on screen is real data that came through the real ingest
 * pipeline, not a fixture.
 *
 * The pacing is the awkward part: the instance is on Xano's Free plan (10 requests per
 * 20 seconds, instance-wide) and each screen fires several API calls plus a poll. So this
 * waits out a window between screens rather than racing and capturing half-loaded
 * skeletons.
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const OUT = path.resolve('frames');
const BASE = 'http://localhost:5273';
const EMAIL = 'admin@nerve.app';
const PASSWORD = 'Nrv-Adm1n-2026';

// One rate-limit window plus slack. Not politeness — without it the screens render
// error states instead of data.
const WINDOW_MS = 22_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const shots = [];

async function shoot(page, name, label) {
  const file = path.join(OUT, `${String(shots.length + 1).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  const kb = Math.round(fs.statSync(file).size / 1024);
  shots.push({ file, name, label });
  console.log(`  captured ${path.basename(file)}  (${kb} KB)  ${label}`);
}

/** True when the page is showing real content rather than a skeleton or an error. */
async function pageHealth(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    return {
      rateLimited: /rate limited|10 requests per 20/i.test(text),
      errored: /Something went wrong|Could not reach/i.test(text),
      chars: text.length,
    };
  });
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  // Dark mode reads better in a reel, and it is the theme the palette was validated
  // against most recently.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`    [page error] ${m.text().slice(0, 140)}`);
  });

  console.log('1. login');
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('input[type="email"]', { timeout: 20_000 });
  await page.type('input[type="email"]', EMAIL, { delay: 15 });
  await page.type('input[type="password"]', PASSWORD, { delay: 15 });
  await shoot(page, 'login', 'sign-in, dark');

  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForFunction(() => !document.querySelector('input[type="password"]'), { timeout: 60_000 }),
  ]);

  const screens = [
    { hash: '#/', name: 'overview', label: 'fleet overview - live totals', settle: 9000 },
    { hash: '#/fleet', name: 'fleet', label: 'device grid, filters, live status', settle: 8000 },
    { hash: '#/incidents', name: 'incidents', label: 'incidents - alerts correlated into clusters', settle: 8000 },
    // The single most important frame in the set: it is the difference between showing a
    // red graph and saying what is wrong. Longest settle because the detail endpoint
    // assembles alerts, devices, the analysis and the timeline in one request.
    {
      hash: '#/incidents/4',
      name: 'incident-detail',
      label: 'incident detail - root cause, evidence, runbook',
      settle: 13000,
    },
    { hash: '#/devices/2', name: 'device-detail', label: 'device detail - real telemetry charts', settle: 12000 },
    { hash: '#/rules', name: 'rules', label: 'rules + natural-language composer', settle: 7000 },
    { hash: '#/admin', name: 'admin', label: 'admin - keys, types, AI activity', settle: 8000 },
  ];

  for (const s of screens) {
    console.log(`\n${shots.length + 1}. ${s.name}  (waiting out the rate-limit window first)`);
    await sleep(WINDOW_MS);
    await page.goto(`${BASE}/${s.hash}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await sleep(s.settle);
    const h = await pageHealth(page);
    if (h.rateLimited) console.log('    ! rate limited - frame will show the throttle notice');
    if (h.errored) console.log('    ! an error state is visible on this screen');
    await shoot(page, s.name, s.label);
  }

  // The Ask console is the headline feature, so it gets a real question typed and run
  // rather than an empty-state frame.
  console.log(`\n${shots.length + 1}. ask (typing a live question)`);
  await sleep(WINDOW_MS);
  await page.goto(`${BASE}/#/ask`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await sleep(4000);
  const asked = await page
    .evaluate(() => {
      const el =
        document.getElementById('nerve-ask') ||
        document.querySelector('textarea') ||
        [...document.querySelectorAll('input')].find((i) =>
          /freezer|ask|question/i.test(`${i.placeholder} ${i.getAttribute('aria-label') || ''}`)
        );
      if (!el) return false;
      el.focus();
      return true;
    })
    .catch(() => false);

  if (asked) {
    await page.keyboard.type('How many devices are offline right now?', { delay: 22 });
    await shoot(page, 'ask-typed', 'Ask console - question typed');
    // Submit via the visible primary button rather than Enter, which a textarea eats.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /^ask$/i.test(b.innerText.trim()));
      if (btn) btn.click();
    });
    await sleep(14000);
    await shoot(page, 'ask-answered', 'Ask console - answer, plan and provenance');
  } else {
    console.log('    ! could not find the Ask input; capturing the screen as-is');
    await shoot(page, 'ask', 'Ask console');
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(shots, null, 2));
  console.log(`\n${shots.length} frames written to ${OUT}`);
} finally {
  await browser.close();
}
