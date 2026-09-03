/**
 * Signal shaping.
 *
 * Real telemetry is not `base + noise`. It has a daily rhythm (a warehouse warms in the
 * afternoon and machines idle at night), it drifts (a random walk that persists rather
 * than resetting each sample), and it occasionally spikes. Faults then have to be
 * *distinguishable* from all of that — which is the whole point of the anomaly detection
 * we're demoing, so the baseline has to be genuinely non-trivial.
 */

import { gaussian, clamp } from './rng.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A continuous gauge: mean-reverting random walk + diurnal component + Gaussian noise.
 *
 * `reversion` pulls the walk back toward `base` so it wanders without escaping — an
 * unbounded walk would eventually cross any threshold on its own and produce alerts the
 * demo cannot explain.
 */
export class Gauge {
  constructor({ base, drift = 0, noise = 0, diurnal = 0, diurnalPeakHour = 15, reversion = 0.02, min, max, precision = 2 }) {
    this.base = base;
    this.walk = 0;
    this.drift = drift;
    this.noise = noise;
    this.diurnal = diurnal;
    this.diurnalPeakHour = diurnalPeakHour;
    this.reversion = reversion;
    this.min = min;
    this.max = max;
    this.precision = precision;
    this.offset = 0; // fault injection adds here, so faults compose with the baseline
  }

  /** Diurnal term: peaks at `diurnalPeakHour` local-ish time, zero amplitude if unset. */
  diurnalAt(tsMs) {
    if (!this.diurnal) return 0;
    const hours = ((tsMs % DAY_MS) / DAY_MS) * 24;
    const phase = ((hours - this.diurnalPeakHour) / 24) * 2 * Math.PI;
    return this.diurnal * Math.cos(phase);
  }

  next(rand, tsMs) {
    this.walk += this.drift + gaussian(rand) * this.noise * 0.35;
    this.walk -= this.walk * this.reversion;
    const raw = this.base + this.walk + this.diurnalAt(tsMs) + this.offset + gaussian(rand) * this.noise;
    const value = clamp(raw, this.min, this.max);
    return round(value, this.precision);
  }
}

/**
 * A monotonic counter (odometry, energy, cycle counts).
 * Counters that reset or go backwards break rate-of-change rules, so this one only
 * ever increases.
 */
export class Counter {
  constructor({ start = 0, perSecond = 0, jitter = 0, precision = 1 }) {
    this.value = start;
    this.perSecond = perSecond;
    this.jitter = jitter;
    this.precision = precision;
    this.rateScale = 1; // faults scale the rate rather than jumping the value
  }

  next(rand, _tsMs, dtSeconds = 1) {
    const rate = this.perSecond * this.rateScale * (1 + gaussian(rand) * this.jitter);
    this.value += Math.max(0, rate * dtSeconds);
    return round(this.value, this.precision);
  }
}

/**
 * A two-state duty-cycle signal (compressor on/off, e-stop engaged/clear).
 *
 * Modelled as dwell times rather than a per-sample coin flip: a coin flip produces
 * physically impossible 1-sample chatter, and "short cycling" — one of our fault
 * scenarios — is precisely a *dwell time* anomaly, so dwell has to be the primitive.
 */
export class DutyState {
  constructor({ onSeconds, offSeconds, jitter = 0.25, startOn = false }) {
    this.onSeconds = onSeconds;
    this.offSeconds = offSeconds;
    this.jitter = jitter;
    this.on = startOn;
    this.remaining = startOn ? onSeconds : offSeconds;
    this.transitions = 0;
  }

  targetDwell(rand) {
    const nominal = this.on ? this.onSeconds : this.offSeconds;
    return Math.max(2, nominal * (1 + gaussian(rand) * this.jitter));
  }

  next(rand, _tsMs, dtSeconds = 1) {
    this.remaining -= dtSeconds;
    if (this.remaining <= 0) {
      this.on = !this.on;
      this.transitions += 1;
      this.remaining = this.targetDwell(rand);
    }
    return this.on ? 1 : 0;
  }
}

/** An enum-ish categorical state that mostly stays put. */
export class ModeState {
  constructor({ modes, weights, dwellSeconds = 300 }) {
    this.modes = modes;
    this.weights = weights || modes.map(() => 1);
    this.dwellSeconds = dwellSeconds;
    this.current = modes[0];
    this.remaining = dwellSeconds;
    this.forced = null;
  }

  next(rand, _tsMs, dtSeconds = 1) {
    if (this.forced) return this.forced;
    this.remaining -= dtSeconds;
    if (this.remaining <= 0) {
      const total = this.weights.reduce((a, b) => a + b, 0);
      let r = rand() * total;
      for (let i = 0; i < this.modes.length; i += 1) {
        r -= this.weights[i];
        if (r <= 0) {
          this.current = this.modes[i];
          break;
        }
      }
      this.remaining = this.dwellSeconds * (0.5 + rand());
    }
    return this.current;
  }
}

/**
 * A slowly depleting-and-recharging reservoir (an AMR battery).
 * Discharges while working, recharges on the dock. `capacityFade` is what the
 * predictive-maintenance scenario degrades — the pack still charges to "100%" but the
 * usable window shrinks, which is exactly the failure mode a threshold alert misses.
 */
export class Battery {
  /**
   * `rand` is required, not optional. Seeding the starting charge from Math.random()
   * would make every run begin with the fleet at a different state of charge, which
   * defeats the reproducibility the whole simulator exists to provide.
   */
  constructor({ rand, dischargePctPerHour, chargePctPerHour, low = 22, full = 96 }) {
    if (typeof rand !== 'function') {
      throw new TypeError('Battery requires a seeded `rand` function for reproducibility');
    }
    this.pct = 45 + rand() * 45;
    this.dischargePctPerHour = dischargePctPerHour;
    this.chargePctPerHour = chargePctPerHour;
    this.low = low;
    this.full = full;
    this.charging = false;
    this.capacityFade = 0; // 0..1, fraction of usable capacity lost
    this.dockCycles = 0;
    this.drainMultiplier = 1;
  }

  next(_rand, _tsMs, dtSeconds = 1) {
    const hours = dtSeconds / 3600;
    if (this.charging) {
      this.pct += this.chargePctPerHour * hours;
      const ceiling = this.full * (1 - this.capacityFade * 0.35);
      if (this.pct >= ceiling) {
        this.pct = ceiling;
        this.charging = false;
      }
    } else {
      const rate = this.dischargePctPerHour * this.drainMultiplier * (1 + this.capacityFade);
      this.pct -= rate * hours;
      if (this.pct <= this.low) {
        this.charging = true;
        this.dockCycles += 1;
      }
    }
    this.pct = Math.max(0, Math.min(100, this.pct));
    return round(this.pct, 1);
  }
}

export function round(value, precision = 2) {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** precision;
  return Math.round(value * f) / f;
}
