/**
 * Trim + stitch the recorded segments into a ~60s reel.
 *
 * The eased glides overrun their nominal durations (setTimeout granularity over 60
 * steps), so the raw segments total 80s. Rather than re-record — a 4-minute cycle,
 * because each segment has to wait out the Free-plan rate-limit window before it can
 * load a page cleanly — trim here. Every segment ends on a static hold, so cutting the
 * tail costs nothing.
 *
 * The one exception is `ask`, which contains 4.5s of dead air while the backend answers.
 * That gets a two-piece cut instead: the seam lands inside the wait, so on playback the
 * answer simply appears — which is what a hand-cut demo would do anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

const V = path.resolve('video');
const TMP = path.join(V, 'trim');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// [file, keep-seconds] or [file, [inA,outA], [inB,outB]] for a two-piece cut.
const PLAN = [
  ['01-overview.webm', 6.5],
  ['02-fleet.webm', 5.5],
  ['03-incidents.webm', 7.6],
  ['04-incident-detail.webm', 14.6], // the pitch — trimmed least
  ['05-device-detail.webm', 10.0],
  ['06-ask.webm', [0, 4.0], [7.0, 15.6]], // seam inside the answer wait
  ['07-rules.webm', 4.6],
];

const ENC = ['-c:v','libx264','-preset','slow','-crf','20','-pix_fmt','yuv420p','-r','30','-vf','scale=1440:900:flags=lanczos','-an'];
const run = (args) => execFileSync(ffmpegPath, ['-y','-hide_banner', ...args], { stdio: ['ignore','ignore','pipe'] });

const pieces = [];
for (const [file, ...spec] of PLAN) {
  const src = path.join(V, file);
  const base = file.replace(/\.webm$/, '');
  if (typeof spec[0] === 'number') {
    const out = path.join(TMP, `${base}.mp4`);
    run(['-i', src, '-t', String(spec[0]), ...ENC, out]);
    pieces.push(out);
    console.log(`  ${base}  -> ${spec[0]}s`);
  } else {
    spec.forEach(([from, to], i) => {
      const out = path.join(TMP, `${base}-${i}.mp4`);
      // -ss AFTER -i: decode-accurate, which matters on screencast webm (sparse keyframes).
      run(['-i', src, '-ss', String(from), '-to', String(to), ...ENC, out]);
      pieces.push(out);
      console.log(`  ${base}  -> ${from}..${to}s`);
    });
  }
}

const list = path.join(TMP, 'concat.txt');
fs.writeFileSync(list, pieces.map((p) => `file '${p.split(String.fromCharCode(92)).join('/')}'`).join('\n'));

const mp4 = path.join(V, 'nerve-demo.mp4');
run(['-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart', mp4]);

let dur = '?';
try { run(['-i', mp4, '-f','null','-']); } catch (e) {
  dur = String(e.stderr || '').match(/time=([0-9:.]+)/g)?.pop()?.slice(5) ?? '?';
}
console.log(`\nnerve-demo.mp4  ${(fs.statSync(mp4).size/1024/1024).toFixed(2)} MB  ${dur}`);
