/**
 * Render the narration, check it against the picture, and mux it onto the demo video.
 *
 * The video is already cut, so this does NOT lay the voice down as one continuous take.
 * Each line is rendered separately and placed at its segment's absolute start time with
 * `adelay`, so the voice stays locked to the cut it describes even when a line comes in
 * short. A continuous take drifts: one line running half a second long pushes every
 * later line off its picture, and the error accumulates to the end of the reel.
 *
 * Every line is measured with ffmpeg after rendering, never estimated. Speaking rate on
 * this voice swings from about 2.0 to 2.9 words/sec depending on how many numerals and
 * technical words a line carries, so a word budget alone does not tell you whether a line
 * fits. Overruns are reported per line, with the amount, so the fix is a rewrite of the
 * offending line rather than a guess at the whole script.
 *
 * Usage:
 * Defaults read media/narration.json and media/nerve-demo.mp4 and write
 * media/nerve-demo-narrated.mp4, so the whole step is:
 *
 *   node scripts/narrate-demo.mjs
 *
 * Overridable: --lines --video --out --rate --voice --dry-run --force
 *
 * Requires ffmpeg-static (a devDependency) and Windows SAPI, which ships with the OS.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

/* ------------------------------------------------------------------ segments */

// The cut list of the finished reel, from scripts/trim-demo.mjs. `start` is where the
// segment begins in the muxed video; `dur` is how long the picture stays there, which is
// the hard ceiling on the line that describes it.
const SEGMENTS = [
  { n: 1, name: 'overview', start: 0.0, dur: 6.5 },
  { n: 2, name: 'fleet', start: 6.5, dur: 5.5 },
  { n: 3, name: 'incidents', start: 12.0, dur: 7.6 },
  { n: 4, name: 'incident-detail', start: 19.6, dur: 14.6 },
  { n: 5, name: 'device-detail', start: 34.2, dur: 10.0 },
  { n: 6, name: 'ask', start: 44.2, dur: 12.6 },
  { n: 7, name: 'rules', start: 56.8, dur: 4.6 },
];

// Start each line a beat after its cut lands. Speaking the instant the picture changes
// reads as rushed, and it also gives the ear a moment to register the new screen.
const LEAD_IN = 0.35;

// A line may run this far past its own segment before it is called an overrun. A small
// bleed into the next screen sounds natural — the eye is still settling — but anything
// more and the voice is describing the wrong picture.
const BLEED_ALLOWANCE = 0.6;

/* -------------------------------------------------------------------- config */

function flag(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CFG = {
  lines: path.resolve(String(flag('lines', path.join(ROOT, 'media', 'narration.json')))),
  video: path.resolve(String(flag('video', path.join(ROOT, 'media', 'nerve-demo.mp4')))),
  out: path.resolve(String(flag('out', path.join(ROOT, 'media', 'nerve-demo-narrated.mp4')))),
  rate: Number(flag('rate', 0)),
  voice: String(flag('voice', 'Microsoft David Desktop')),
  dryRun: Boolean(flag('dry-run', false)),
  // Intermediates go outside the tree: they are a rendering artefact of one voice at one
  // rate, reproducible from narration.json, and 22 kHz WAV does not belong in git.
  wav: path.join(os.tmpdir(), 'nerve-voice'),
};

const run = (args, opts = {}) =>
  execFileSync(ffmpegPath, ['-y', '-hide_banner', ...args], { stdio: ['ignore', 'ignore', 'pipe'], ...opts });

/**
 * Duration in seconds, by decoding the file and reading how far it got.
 *
 * Uses `-progress pipe:1` rather than scraping the human-readable `time=` banner.
 * ffmpeg writes that banner to STDERR, and execFileSync only hands back stderr when the
 * process FAILS — a successful decode returned an empty string and every duration came
 * out NaN, which then propagated into the filter graph as `afade=d=NaN`. `-progress`
 * writes machine-readable key=value lines to stdout, where a successful run can read them.
 */
function duration(file) {
  const parse = (s) => {
    const last = s.match(/out_time=([0-9:.]+)/g)?.pop()?.slice(9);
    if (!last) return NaN;
    const [h, m, sec] = last.split(':').map(Number);
    return h * 3600 + m * 60 + sec;
  };
  const args = ['-hide_banner', '-i', file, '-f', 'null', '-progress', 'pipe:1', '-'];
  try {
    return parse(execFileSync(ffmpegPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (e) {
    return parse(String(e.stdout || ''));
  }
}

/* ------------------------------------------------------------------- render */

const lines = JSON.parse(fs.readFileSync(CFG.lines, 'utf8'));
const bySeg = new Map(lines.map((l) => [Number(l.segment), l]));

const missing = SEGMENTS.filter((s) => !bySeg.has(s.n));
if (missing.length) {
  console.error(`No narration for segment(s): ${missing.map((s) => s.n).join(', ')}`);
  process.exit(1);
}

fs.rmSync(CFG.wav, { recursive: true, force: true });
fs.mkdirSync(CFG.wav, { recursive: true });

console.log(`rendering ${lines.length} lines  voice="${CFG.voice}"  rate=${CFG.rate}`);
execFileSync(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'tts.ps1'),
   '-LinesJson', CFG.lines, '-OutDir', CFG.wav, '-Voice', CFG.voice, '-Rate', String(CFG.rate)],
  { stdio: ['ignore', 'inherit', 'inherit'] }
);

/* ---------------------------------------------------------------- fit report */

console.log('\nfit against the picture:');
const report = [];
let worst = 0;

for (const seg of SEGMENTS) {
  const wav = path.join(CFG.wav, `seg${String(seg.n).padStart(2, '0')}.wav`);
  const spoken = duration(wav);
  const line = bySeg.get(seg.n);
  // Count the spoken form: a respelling can change the syllable count, and the picture
  // cares about seconds, not about the words in the script of record.
  const words = String(line.speak || line.text).trim().split(/\s+/).length;
  // The line starts LEAD_IN after the cut, so the room available is the segment minus
  // that lead, plus whatever bleed into the next screen is tolerable.
  const room = seg.dur - LEAD_IN + BLEED_ALLOWANCE;
  const over = spoken - room;
  worst = Math.max(worst, over);
  report.push({ seg, wav, spoken, words, room, over });

  const verdict = over > 0 ? `OVER by ${over.toFixed(2)}s` : `fits, ${(-over).toFixed(2)}s spare`;
  console.log(
    `  seg${seg.n} ${seg.name.padEnd(16)} ${spoken.toFixed(2)}s spoken / ${room.toFixed(2)}s room ` +
      `· ${words}w @ ${(words / spoken).toFixed(2)} w/s · ${verdict}`
  );
}

// Overlap is the real failure, and it is not the same test as the per-segment fit: a
// line may sit inside its own bleed allowance and STILL be talking when the next line
// starts, because the next line begins LEAD_IN after its cut rather than at it. Two
// synthesised voices over each other is the one artefact a listener cannot parse.
for (let i = 0; i < report.length - 1; i += 1) {
  const cur = report[i];
  const next = report[i + 1];
  const endsAt = cur.seg.start + LEAD_IN + cur.spoken;
  const nextStarts = next.seg.start + LEAD_IN;
  if (endsAt > nextStarts) {
    cur.over = Math.max(cur.over, endsAt - nextStarts);
    console.log(
      `  ! seg${cur.seg.n} still speaking ${(endsAt - nextStarts).toFixed(2)}s after seg${next.seg.n} begins`
    );
  }
}

const overruns = report.filter((r) => r.over > 0);
if (overruns.length) {
  console.log(`\n${overruns.length} line(s) overrun. Cut words from:`);
  for (const r of overruns) {
    const cut = Math.ceil(r.over * (r.words / r.spoken));
    console.log(`  seg${r.seg.n}: drop ~${cut} word(s) — "${bySeg.get(r.seg.n).text}"`);
  }
  if (!flag('force', false)) {
    console.log('\nNot muxing. Rewrite the lines above, or pass --force to mux anyway.');
    process.exit(2);
  }
}

if (CFG.dryRun) {
  console.log('\n--dry-run: stopping before the mux.');
  process.exit(0);
}

/* ---------------------------------------------------------------------- mux */

if (!CFG.video || !fs.existsSync(CFG.video)) {
  console.error(`--video not found: ${CFG.video}`);
  process.exit(1);
}

const videoDur = duration(CFG.video);
console.log(`\nmuxing onto ${path.basename(CFG.video)} (${videoDur.toFixed(2)}s)`);

// One filter chain: clean up each line, delay it to its cut, then sum them onto a silent
// bed the length of the video.
//
// The per-line chain is doing real work, not decoration. This voice is a 22 kHz formant
// synth: highpass clears the low-frequency rumble it puts under every vowel, the
// de-essing lowpass takes the edge off its sibilants, and compression evens out the
// line-to-line level swing so a quiet line is not lost under a loud one. The short fades
// exist because SAPI starts and ends a file abruptly, which clicks.
const inputs = ['-f', 'lavfi', '-t', String(videoDur), '-i', 'anullsrc=r=48000:cl=stereo'];
const chains = [];
const mixLabels = ['[bed]'];

report.forEach((r, i) => {
  inputs.push('-i', r.wav);
  const delayMs = Math.round((r.seg.start + LEAD_IN) * 1000);
  chains.push(
    `[${i + 1}:a]highpass=f=95,lowpass=f=7800,` +
      `acompressor=threshold=0.09:ratio=3:attack=12:release=220:makeup=2,` +
      `afade=t=in:st=0:d=0.05,afade=t=out:st=${Math.max(0, r.spoken - 0.08).toFixed(3)}:d=0.08,` +
      `aresample=48000,adelay=${delayMs}|${delayMs}[v${i}]`
  );
  mixLabels.push(`[v${i}]`);
});

chains.push(`[0:a]aresample=48000[bed]`);
// normalize=0 keeps amix from ducking every line by 1/N as inputs pile up; the bed is
// silence, so summing straight and normalising once at the end is correct.
chains.push(
  `${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:dropout_transition=0[mixed]`
);
// A single loudness pass at the end, so the result lands near broadcast level instead of
// wherever this voice happened to sit.
chains.push(`[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[out]`);

run([
  ...inputs,
  '-i', CFG.video,
  '-filter_complex', chains.join(';'),
  '-map', `${report.length + 1}:v`,
  '-map', '[out]',
  '-c:v', 'copy',
  '-c:a', 'aac',
  '-b:a', '160k',
  '-ar', '48000',
  '-ac', '2',
  '-shortest',
  '-movflags', '+faststart',
  CFG.out,
]);

const size = fs.statSync(CFG.out).size;
console.log(
  `\nwrote ${path.basename(CFG.out)}  ${(size / 1024 / 1024).toFixed(2)} MB  ${duration(CFG.out).toFixed(2)}s`
);
