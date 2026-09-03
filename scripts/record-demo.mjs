/**
 * Record a ~60-second screen capture of the running Nerve app.
 *
 * Records one SEGMENT PER SCREEN rather than a single continuous take, then concatenates
 * them. That is not stylistic: the instance is on Xano's Free plan (10 requests per 20
 * seconds, instance-wide), so a single take would contain ~22 seconds of dead air per
 * page while the rate-limit window cleared. Each segment navigates and settles with the
 * recorder OFF, then records only the part worth watching — which is also how a real
 * demo video gets cut.
 *
 * Scrolling is eased in small steps rather than jumped, because a hard jump reads as a
 * glitch on video and makes charts impossible to follow.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import ffmpegPath from 'ffmpeg-static';

const OUT = path.resolve('video');
const BASE = 'http://localhost:5273';
const EMAIL = 'admin@nerve.app';
const PASSWORD = 'Nrv-Adm1n-2026';
const WINDOW_MS = 22_000;
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

/** Smooth, eased scroll — `steps` frames over `ms`, so the recorder sees motion. */
async function glide(page, fromY, toY, ms, steps = 60) {
  await page.evaluate(
    async (fromY, toY, ms, steps) => {
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const dt = ms / steps;
      for (let i = 0; i <= steps; i += 1) {
        window.scrollTo(0, fromY + (toY - fromY) * ease(i / steps));
        await new Promise((r) => setTimeout(r, dt));
      }
    },
    fromY,
    toY,
    ms,
    steps
  );
}

const pageHeight = (page) => page.evaluate(() => document.documentElement.scrollHeight);

const segments = [];

async function record(page, name, fn) {
  const file = path.join(OUT, `${String(segments.length + 1).padStart(2, '0')}-${name}.webm`);
  const rec = await page.screencast({ path: file, ffmpegPath });
  try {
    await fn();
  } finally {
    await rec.stop();
  }
  const kb = Math.round(fs.statSync(file).size / 1024);
  segments.push(file);
  console.log(`  recorded ${path.basename(file)}  (${kb} KB)`);
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  ],
  defaultViewport: VIEWPORT,
});

try {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  // Motion is the point of a video, so do NOT reduce it.
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ]);

  console.log('signing in (not recorded)');
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('input[type="email"]', { timeout: 20_000 });
  await page.type('input[type="email"]', EMAIL, { delay: 10 });
  await page.type('input[type="password"]', PASSWORD, { delay: 10 });
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForFunction(() => !document.querySelector('input[type="password"]'), { timeout: 60_000 }),
  ]);

  /** Navigate + settle with the recorder off, so no segment contains a loading state. */
  async function warm(hash, settleMs) {
    await sleep(WINDOW_MS);
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await sleep(settleMs);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(400);
  }

  // 1. OVERVIEW — 12s. Hold on the hero, then walk down the page.
  console.log('\n1. overview');
  await warm('#/', 9000);
  await record(page, 'overview', async () => {
    await sleep(1700);
    const h = await pageHeight(page);
    await glide(page, 0, Math.min(900, h), 2900);
    await sleep(700);
    await glide(page, Math.min(900, h), Math.min(1900, h), 2500);
    await sleep(500);
  });

  // 2. FLEET — 10s. The grid, then narrow it with a filter.
  console.log('2. fleet');
  await warm('#/fleet', 8000);
  await record(page, 'fleet', async () => {
    await sleep(1200);
    await glide(page, 0, 620, 2200);
    await sleep(600);
    // Pick a device type, so the video shows the grid actually responding.
    await page.evaluate(() => {
      const sel = [...document.querySelectorAll('select')].find((s) =>
        [...s.options].some((o) => /Cold-Chain Freezer|AMR/i.test(o.text))
      );
      if (!sel) return;
      const opt = [...sel.options].find((o) => /AMR/i.test(o.text));
      if (!opt) return;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(2300);
  });

  // 3. INCIDENTS — 9s. Correlated clusters, which is the whole argument.
  console.log('3. incidents');
  await warm('#/incidents', 8000);
  await record(page, 'incidents', async () => {
    await sleep(2200);
    await glide(page, 0, 560, 3000);
    await sleep(900);
    await glide(page, 560, 1100, 2200);
    await sleep(700);
  });

  // 4. INCIDENT DETAIL — 15s. Root cause, confidence, evidence, remediation. This is the
  // single most important segment in the video: it is the difference between "a
  // dashboard" and "it told me what was wrong".
  console.log('4. incident detail');
  await warm('#/incidents/4', 11000);
  await record(page, 'incident-detail', async () => {
    await sleep(2600);
    await glide(page, 0, 520, 3200);
    await sleep(1800);
    await glide(page, 520, 1150, 3200);
    await sleep(1600);
    await glide(page, 1150, 1750, 2600);
    await sleep(900);
  });

  // 5. DEVICE DETAIL — 16s. The charts with their nominal bands are the strongest frame
  // in the product, so this segment gets the most time.
  console.log('5. device detail');
  await warm('#/devices/2', 13000);
  await record(page, 'device-detail', async () => {
    await sleep(1500);
    await glide(page, 0, 520, 2100);
    await sleep(1400);
    await glide(page, 520, 1150, 2400);
    await sleep(1400);
    await glide(page, 1150, 1800, 2100);
    await sleep(1000);
  });

  // 4. ASK — 16s. Typed live, because typing is most of what makes it believable.
  console.log('6. ask');
  await warm('#/ask', 5000);
  await record(page, 'ask', async () => {
    await sleep(1200);
    await page.evaluate(() => document.getElementById('nerve-ask')?.focus());
    await page.keyboard.type('How many devices are offline right now?', { delay: 45 });
    await sleep(700);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^ask$/i.test(x.innerText.trim()));
      b?.click();
    });
    await sleep(4500);
    await glide(page, 0, 480, 2200);
    await sleep(900);
    // Reveal the validated query plan — the trust argument.
    await page.evaluate(() => {
      const d = [...document.querySelectorAll('details, summary')].find((x) =>
        /how this was answered/i.test(x.innerText || '')
      );
      if (d) {
        const det = d.tagName === 'DETAILS' ? d : d.closest('details');
        if (det) det.open = true;
        else d.click?.();
      }
    });
    await sleep(1200);
    await glide(page, 480, 900, 1800);
    await sleep(1400);
  });

  // 5. RULES — 8s. The natural-language composer and the self-documenting rules table.
  console.log('7. rules');
  await warm('#/rules', 7000);
  await record(page, 'rules', async () => {
    await sleep(1000);
    await glide(page, 0, 560, 1900);
    await sleep(800);
    await glide(page, 560, 1200, 1700);
    await sleep(700);
  });

  fs.writeFileSync(path.join(OUT, 'segments.json'), JSON.stringify(segments, null, 2));
  console.log(`\n${segments.length} segments in ${OUT}`);
} finally {
  await browser.close();
}

/* ---------------------------------------------------------------- stitching */

console.log('\nstitching with ffmpeg');
const listFile = path.join(OUT, 'concat.txt');
fs.writeFileSync(listFile, segments.map((s) => `file '${s.replace(/\\/g, '/')}'`).join('\n'));

const mp4 = path.join(OUT, 'nerve-demo.mp4');
execFileSync(
  ffmpegPath,
  [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    // Re-encode rather than stream-copy: the segments are VP8/VP9 webm and the target is
    // H.264 for YouTube. yuv420p + faststart is what makes it play everywhere.
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-r', '30',
    '-vf', 'scale=1440:900:flags=lanczos',
    mp4,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
);

const size = fs.statSync(mp4).size;
// `ffmpeg -i <file>` with no output is an ERROR exit ("At least one output file must be
// specified") even though it prints the metadata we want, so execFileSync throws on a
// perfectly good encode. Read stderr from the thrown error too.
//
// Read the duration from the LAST `time=` progress line rather than from the `Duration:`
// header: the screencast webm segments carry no duration in their headers, so a concat of
// them reports `Duration: N/A` and the header match comes back empty.
let dur = 'unknown';
try {
  const probe = execFileSync(ffmpegPath, ['-hide_banner', '-i', mp4, '-f', 'null', '-'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  dur = probe.match(/time=([0-9:.]+)/g)?.pop()?.slice(5) ?? dur;
} catch (e) {
  dur = String(e.stderr || '').match(/time=([0-9:.]+)/g)?.pop()?.slice(5) ?? dur;
}

console.log(`\nwrote ${path.basename(mp4)}  ${(size / 1024 / 1024).toFixed(2)} MB  duration ${dur}`);
console.log('\nThis runs ~80s. For the 60-second cut: node scripts/trim-demo.mjs');
