/**
 * Record a ~2-minute screen capture of the running Nerve app.
 *
 * Records one SEGMENT PER SCREEN rather than a single continuous take, then concatenates
 * them. That is not stylistic: the instance is on Xano's Free plan (10 requests per 20
 * seconds, instance-wide), so a single take would contain ~22 seconds of dead air per
 * page while the rate-limit window cleared. Each segment navigates and settles with the
 * recorder OFF, then records only the part worth watching — which is also how a real
 * demo video gets cut.
 *
 * Scrolling is eased in small steps rather than jumped, because a hard jump reads as a
 * glitch on video and makes charts impossible to follow. The eased glides overrun their
 * nominal durations by roughly a fifth (setTimeout granularity over 60 steps), so this
 * deliberately records LONG and leaves the exact cut to trim-demo.mjs.
 *
 * Device detail shows Mill 02 (id 18) specifically: it is degraded with two open alerts,
 * unlike the healthy gateway an earlier cut used, which made the strongest chart in the
 * product look like a flat line. Note that the chart window is roughly three hours, so
 * the excursion that opened the incident has usually aged out of it -- the charts show
 * the metric against its declared operating range, and the open alerts sit below them.
 * Do not narrate this segment as though the spike is visible; it generally is not.
 *
 * No CHROME_PATH is needed: puppeteer installs and resolves its own Chrome. Point
 * CHROME_PATH at a system browser only if you have a reason to, and expect it to fail
 * when that browser updates past the build this puppeteer supports.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import ffmpegPath from 'ffmpeg-static';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// Segment webm files are a rendering intermediate, reproducible by re-running this
// script, and far too large for git -- so they live outside the tree.
const OUT = path.join(os.tmpdir(), 'nerve-demo-segments');
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

  // 1. OVERVIEW — target 11s. Hold on the KPI row, then walk down to the health histogram.
  console.log('\n1. overview');
  await warm('#/', 9000);
  await record(page, 'overview', async () => {
    await sleep(2600);
    const h = await pageHeight(page);
    await glide(page, 0, Math.min(760, h), 3000);
    await sleep(1500);
    await glide(page, Math.min(760, h), Math.min(1800, h), 3000);
    await sleep(1200);
  });

  // 2. FLEET — target 10s. The grid, then narrow it with a filter so the video shows the
  // grid actually responding rather than a static table.
  console.log('2. fleet');
  await warm('#/fleet', 8000);
  await record(page, 'fleet', async () => {
    await sleep(1800);
    await glide(page, 0, 620, 2600);
    await sleep(1200);
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
    await sleep(3200);
  });

  // 3. INCIDENTS — target 11s. Five correlated clusters, each naming its own site.
  console.log('3. incidents');
  await warm('#/incidents', 8000);
  await record(page, 'incidents', async () => {
    await sleep(3200);
    await glide(page, 0, 300, 2600);
    await sleep(2400);
    await glide(page, 300, 620, 2400);
    await sleep(1800);
  });

  // 4. INCIDENT DETAIL — target 22s, the longest segment in the reel. Root cause,
  // confidence, evidence, runbook, affected devices, member alerts, firing chart. This is
  // the difference between "a dashboard" and "it told me what was wrong".
  console.log('4. incident detail');
  await warm('#/incidents/4', 11000);
  await record(page, 'incident-detail', async () => {
    await sleep(3000);
    await glide(page, 0, 460, 3000);
    await sleep(2600);
    await glide(page, 460, 980, 3000);
    await sleep(2400);
    await glide(page, 980, 1560, 3000);
    await sleep(2200);
    await glide(page, 1560, 2150, 2800);
    await sleep(1400);
  });

  // 5. ALERTS — target 10s. The raw queue underneath the incidents, with its filters.
  console.log('5. alerts');
  await warm('#/alerts', 8000);
  await record(page, 'alerts', async () => {
    await sleep(2200);
    await glide(page, 0, 600, 2800);
    await sleep(1600);
    await glide(page, 600, 1200, 2600);
    await sleep(1200);
  });

  // 6. DEVICE DETAIL — target 16s. Mill 02: degraded, two firing alerts, so the charts
  // carry a real excursion against the shaded nominal band.
  console.log('6. device detail (Mill 02)');
  await warm('#/devices/18', 13000);
  await record(page, 'device-detail', async () => {
    await sleep(2600);
    await glide(page, 0, 520, 2800);
    await sleep(2200);
    await glide(page, 520, 1150, 3000);
    await sleep(2200);
    await glide(page, 1150, 1800, 2800);
    await sleep(1400);
  });

  // 7. ASK — target 16s. Typed live, because typing is most of what makes it believable,
  // then the query plan is revealed — the trust argument.
  console.log('7. ask');
  await warm('#/ask', 5000);
  await record(page, 'ask', async () => {
    await sleep(1400);
    await page.evaluate(() => document.getElementById('nerve-ask')?.focus());
    await page.keyboard.type('How many alerts fired by severity yesterday?', { delay: 45 });
    await sleep(900);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^ask$/i.test(x.innerText.trim()));
      b?.click();
    });
    await sleep(5000);
    await glide(page, 0, 480, 2400);
    await sleep(1400);
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
    await sleep(1600);
    await glide(page, 480, 980, 2000);
    await sleep(1800);
  });

  // 8. RULES — target 13s. Fill the natural-language composer to show the affordance, then
  // the rules table reading each saved rule back as a sentence.
  //
  // Deliberately NOT submitting: composing calls the model, and this account has no
  // Anthropic credits, so a click would record an error state or a deterministic
  // fallback. Showing the input filled is honest; staging a fabricated success is not.
  console.log('8. rules');
  await warm('#/rules', 7000);
  await record(page, 'rules', async () => {
    await sleep(1600);
    await page.evaluate(() => {
      const chip = [...document.querySelectorAll('button')].find((b) =>
        /sigma above its own baseline/i.test(b.innerText || '')
      );
      chip?.click();
    });
    await sleep(2200);
    await glide(page, 0, 620, 2800);
    await sleep(1800);
    await glide(page, 620, 1350, 2800);
    await sleep(1400);
  });

  // 9. ADMIN — target 9s. Ingest keys, device types and the AI activity log: the parts
  // that show this is an operated system, not a set of screens.
  console.log('9. admin');
  await warm('#/admin', 8000);
  await record(page, 'admin', async () => {
    await sleep(2000);
    await glide(page, 0, 640, 2800);
    await sleep(1600);
    await glide(page, 640, 1300, 2400);
    await sleep(1000);
  });

  fs.writeFileSync(path.join(OUT, 'segments.json'), JSON.stringify(segments, null, 2));
  console.log(`\n${segments.length} segments in ${OUT}`);
} finally {
  await browser.close();
}

/* ---------------------------------------------------------------- stitching */

console.log('\nstitching with ffmpeg (untrimmed — run trim-demo.mjs for the exact cut)');
const listFile = path.join(OUT, 'concat.txt');
fs.writeFileSync(
  listFile,
  segments.map((s) => `file '${s.split(String.fromCharCode(92)).join('/')}'`).join('\n')
);

const mp4 = path.join(OUT, 'nerve-demo-raw.mp4');
execFileSync(
  ffmpegPath,
  [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    // Re-encode rather than stream-copy: the segments are VP8/VP9 webm and the target is
    // H.264. yuv420p + faststart is what makes it play everywhere.
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

// Read the duration from the LAST `out_time` progress line: the screencast webm segments
// carry no duration in their headers, so a concat of them reports `Duration: N/A`, and
// ffmpeg writes its human-readable banner to stderr where a successful run cannot read it.
let dur = 'unknown';
try {
  const probe = execFileSync(
    ffmpegPath,
    ['-hide_banner', '-i', mp4, '-f', 'null', '-progress', 'pipe:1', '-'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  dur = probe.match(/out_time=([0-9:.]+)/g)?.pop()?.slice(9) ?? dur;
} catch (e) {
  dur = String(e.stdout || '').match(/out_time=([0-9:.]+)/g)?.pop()?.slice(9) ?? dur;
}

console.log(
  `\nwrote ${path.basename(mp4)}  ${(fs.statSync(mp4).size / 1024 / 1024).toFixed(2)} MB  duration ${dur}`
);
console.log('\nNext: node scripts/trim-demo.mjs   (cuts to the ~2-minute target)');
