/**
 * Fault scenarios — reproducible, nameable failures you can inject on demand.
 *
 * A demo that waits for a random anomaly is a demo that fails on stage. Each scenario
 * here is a *physically coherent* fault: it perturbs the generator state the same way the
 * real failure would, so the correlations the AI is asked to explain actually exist in
 * the data rather than being asserted by a fixture.
 *
 * Each scenario declares:
 *   select(device)                  — which devices it applies to
 *   onStart(device, gen, ctx)       — one-shot setup
 *   apply(device, gen, elapsed, ctx)— per-tick perturbation (elapsed = seconds since start)
 *   silence(device, gen, elapsed)   — if true, the device stops reporting entirely
 *
 * `ramp()` matters: a step change is trivially caught by a static threshold, which is
 * the very thing we claim is inadequate. Real degradation ramps, and a ramp is what
 * makes baseline/z-score detection earn its keep.
 */

/** Smooth 0 -> 1 over `seconds`, then holds. */
function ramp(elapsed, seconds) {
  if (seconds <= 0) return 1;
  const t = Math.max(0, Math.min(1, elapsed / seconds));
  return t * t * (3 - 2 * t); // smoothstep
}

export const SCENARIOS = {
  'freezer-door-ajar': {
    label: 'Freezer door left ajar (site-wide correlation)',
    description:
      'A loading-bay door is propped open at one site, so every freezer on that aisle warms together. ' +
      'Individually each is a minor deviation; together they are one incident with one cause — ' +
      'the case for AI correlation over per-device alerts.',
    scope: 'site',
    select: (d) => d.type_code === 'freezer-cc900',
    onStart: (_d, gen) => {
      // The door sticks open rather than cycling.
      gen.door_open.onSeconds = 100000;
      gen.door_open.remaining = 100000;
      gen.door_open.on = true;
    },
    apply: (_d, gen, elapsed) => {
      // Cabinet climbs toward roughly -6 C over ~25 minutes, then plateaus as the
      // compressor fights the load. Not a step — a thermal ramp.
      gen.temp_c.offset = 15 * ramp(elapsed, 1500);
      gen.humidity_pct.offset = 30 * ramp(elapsed, 900);
      gen.power_w.offset = 260 * ramp(elapsed, 600);
    },
  },

  'amr-battery-degradation': {
    label: 'AMR battery capacity fade (predictive maintenance)',
    description:
      'A robot pack loses usable capacity over weeks. It still charges to "100%", so no threshold ' +
      'ever trips — but the interval between docks shortens measurably. This is the predictive ' +
      'case: the failure is in the *trend*, not the value.',
    scope: 'device',
    select: (d) => d.type_code === 'amr-ld250',
    apply: (_d, gen, elapsed) => {
      // Fade accrues over the run; with --speed the run compresses weeks into minutes.
      gen.battery.capacityFade = Math.min(0.45, 0.45 * ramp(elapsed, 3600));
      gen.battery.drainMultiplier = 1 + 0.5 * ramp(elapsed, 3600);
      gen.battery_temp_c.offset = 7 * ramp(elapsed, 2400);
    },
  },

  'gateway-drop': {
    label: 'Edge gateway failure (cascade / dependency correlation)',
    description:
      'A gateway thermally fails and stops forwarding. Every device behind it goes silent at the ' +
      'same instant. Forty "device offline" alerts, one actual fault — the cascade the incident ' +
      'correlator has to collapse.',
    scope: 'site',
    select: (d) => d.type_code === 'gw-edge200',
    apply: (_d, gen, elapsed) => {
      gen.temp_c.offset = 42 * ramp(elapsed, 240);
      gen.cpu_pct.offset = 65 * ramp(elapsed, 180);
      gen.packet_loss_pct.offset = 30 * ramp(elapsed, 200);
      gen.uplink_mbps.offset = -30 * ramp(elapsed, 200);
    },
    // After 5 simulated minutes the gateway — and its dependents — go dark.
    silence: (_d, _gen, elapsed) => elapsed > 300,
    cascades: true, // devices at the same site stop reporting too
  },

  'spindle-bearing-wear': {
    label: 'CNC spindle bearing wear (multi-metric anomaly)',
    description:
      'Vibration RMS and spindle temperature rise together while load stays normal. No single ' +
      'metric leaves its band early, but the *pair* moving in lockstep is unmistakable — the ' +
      'multivariate case a per-metric threshold cannot express.',
    scope: 'device',
    select: (d) => d.type_code === 'cnc-vmc850',
    apply: (_d, gen, elapsed) => {
      gen.vibration_mm_s.offset = 4.2 * ramp(elapsed, 2100);
      gen.spindle_temp_c.offset = 22 * ramp(elapsed, 2400);
      gen.axis_error_um.offset = 14 * ramp(elapsed, 3000);
      gen.spindle_load_pct.offset = 6 * ramp(elapsed, 2400);
    },
  },

  'hvac-short-cycling': {
    label: 'HVAC compressor short-cycling (pattern anomaly)',
    description:
      'The compressor starts and stops every ~90 seconds instead of running 12-minute cycles. ' +
      'Every instantaneous reading is perfectly in range; only the *frequency* is wrong. ' +
      'A threshold on any single value sees nothing.',
    scope: 'device',
    select: (d) => d.type_code === 'hvac-rtu40',
    onStart: (_d, gen) => {
      gen.compressor_on.onSeconds = 85;
      gen.compressor_on.offSeconds = 70;
      gen.compressor_on.jitter = 0.15;
      gen.compressor_on.remaining = 20;
    },
    apply: (_d, gen, elapsed) => {
      gen.suction_pressure_kpa.offset = -70 * ramp(elapsed, 900);
      gen.power_w.offset = 700 * ramp(elapsed, 600);
    },
  },

  'power-brownout': {
    label: 'Site voltage sag (cross-device-type correlation)',
    description:
      'Incoming voltage sags ~11%. The power meter reports it directly; the AMRs charge slower, ' +
      'the CNC throws axis errors, and the freezers draw harder. Four device *types*, one root ' +
      'cause — correlation across classes, which is where per-service dashboards fall down.',
    scope: 'site',
    select: (d) => ['power-pm3000', 'amr-ld250', 'cnc-vmc850', 'freezer-cc900'].includes(d.type_code),
    apply: (d, gen, elapsed) => {
      const r = ramp(elapsed, 420);
      if (d.type_code === 'power-pm3000') {
        gen.voltage_l1_v.offset = -46 * r;
        gen.voltage_l2_v.offset = -44 * r;
        gen.voltage_l3_v.offset = -49 * r;
        gen.thd_pct.offset = 6.5 * r;
        gen.power_factor.offset = -0.06 * r;
      } else if (d.type_code === 'amr-ld250') {
        gen.battery.chargePctPerHour = Math.max(12, gen.battery.chargePctPerHour * (1 - 0.45 * r));
        gen.motor_current_a.offset = 5 * r;
      } else if (d.type_code === 'cnc-vmc850') {
        gen.axis_error_um.offset = 18 * r;
        gen.spindle_rpm.offset = -700 * r;
      } else if (d.type_code === 'freezer-cc900') {
        gen.power_w.offset = 180 * r;
        gen.temp_c.offset = 2.2 * r;
      }
    },
  },

  'amr-wheel-slip': {
    label: 'AMR drive wheel wear (localization degradation)',
    description:
      'A worn drive wheel slips, so odometry drifts and localization confidence decays. The robot ' +
      'keeps working — badly — and eventually mislocalizes. A slow-burn fault that shows why ' +
      'health scoring beats up/down status.',
    scope: 'device',
    select: (d) => d.type_code === 'amr-ld250',
    apply: (_d, gen, elapsed) => {
      const r = ramp(elapsed, 1800);
      gen.wheel_slip_pct.offset = 16 * r;
      gen.localization_conf.offset = -0.28 * r;
      gen.motor_current_a.offset = 7 * r;
      gen.motor_temp_c.offset = 18 * r;
    },
  },

  'gateway-disk-fill': {
    label: 'Gateway disk filling (slow, forecastable exhaustion)',
    description:
      'A log rotation is broken, so disk climbs a fraction of a percent per minute. Nothing is ' +
      'wrong *yet* — the value is the forecast: it hits 100% in N hours. Predictive, not reactive.',
    scope: 'device',
    select: (d) => d.type_code === 'gw-edge200',
    onStart: (_d, gen) => {
      gen.disk_pct.drift = 0.02;
      gen.disk_pct.reversion = 0;
    },
    apply: (_d, gen, elapsed) => {
      gen.mem_pct.offset = 24 * ramp(elapsed, 2400);
    },
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

/**
 * Resolve a scenario spec into the concrete devices it will affect.
 *
 * `scope: 'site'` picks one site and hits every matching device there (that is what makes
 * it a correlated incident rather than N unrelated ones). `scope: 'device'` picks a
 * bounded number of individual devices.
 */
export function resolveTargets(scenario, devices, rand, { count = 1, siteCode = null } = {}) {
  const eligible = devices.filter((d) => scenario.select(d));
  if (eligible.length === 0) return { targets: [], siteCode: null };

  if (scenario.scope === 'site') {
    const sites = [...new Set(eligible.map((d) => d.site_code))];
    const chosen = siteCode && sites.includes(siteCode) ? siteCode : sites[Math.floor(rand() * sites.length) % sites.length];
    return { targets: eligible.filter((d) => d.site_code === chosen), siteCode: chosen };
  }

  const shuffled = [...eligible].sort(() => rand() - 0.5);
  return { targets: shuffled.slice(0, Math.max(1, count)), siteCode: null };
}

export function describeScenarios() {
  return SCENARIO_NAMES.map((name) => {
    const s = SCENARIOS[name];
    return `  ${name.padEnd(26)} ${s.label}\n${' '.repeat(28)}${s.description.replace(/\s+/g, ' ')}`;
  }).join('\n\n');
}
