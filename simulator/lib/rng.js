/**
 * Seeded pseudo-random number generation.
 *
 * The simulator has to be *reproducible*: a demo that shows a different fleet every
 * run is a demo you cannot rehearse. Every device derives its own stream from
 * `hash(seed + serial)`, so device A's numbers never shift when you add device B.
 */

/** mulberry32 — small, fast, good enough distribution for telemetry shaping. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, so a serial maps to a stable 32-bit stream id. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A named random stream: same (seed, name) always yields the same sequence. */
export function streamFor(seed, name) {
  return mulberry32((hashString(name) ^ (seed >>> 0)) >>> 0);
}

/**
 * Box-Muller. Returns a standard normal sample from a uniform generator.
 * Telemetry noise is Gaussian, not uniform — using `rand()` directly for noise is
 * the tell of a fake dataset, because it never produces the occasional far tail.
 */
export function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Clamp with a little headroom so hard sensor limits read as saturation, not noise. */
export function clamp(value, min, max) {
  if (min !== undefined && min !== null && value < min) return min;
  if (max !== undefined && max !== null && value > max) return max;
  return value;
}

export function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

export function randBetween(rand, min, max) {
  return min + rand() * (max - min);
}

export function randInt(rand, min, max) {
  return Math.floor(randBetween(rand, min, max + 1));
}
