#!/usr/bin/env node
/**
 * Nerve device simulator.
 *
 * Runs a virtual industrial IoT fleet against a live Nerve/Xano backend: builds the
 * fleet, self-registers every device through the public ingest API (the same call a real
 * device makes), then streams batched telemetry — optionally with a named fault scenario
 * injected so a demo is reproducible.
 *
 * Usage:
 *   node index.js --devices 40 --interval 5
 *   node index.js --backfill 24 --devices 40           # seed 24h of history, then exit
 *   node index.js --scenario freezer-door-ajar --site OSA-01
 *   node index.js --list-scenarios
 *   node index.js --dry-run --once                     # print a reading, send nothing
 *
 * Config comes from flags, then .env, then defaults:
 *   NERVE_API_BASE   e.g. https://x8ki-abcd-efgh.n7.xano.io
 *   NERVE_API_KEY    an ingest API key (Admin -> API keys in the UI)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamFor, randBetween, randInt } from './lib/rng.js';
import { SITES, DEVICE_TYPES, DEVICE_TYPES_BY_CODE, buildGenerators, sample, deviceNameFor } from './catalog.js';
import { SCENARIOS, SCENARIO_NAMES, resolveTargets, describeScenarios } from './scenarios.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Minimal .env reader — one less dependency to install at demo time. */
function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const fileEnv = { ...loadEnvFile(path.join(HERE, '.env')), ...loadEnvFile(path.join(HERE, '..', '.env')) };
const env = { ...fileEnv, ...process.env };

const CONFIG = {
  apiBase: (flags['base-url'] || env.NERVE_API_BASE || '').replace(/\/+$/, ''),
  apiKey: flags['api-key'] || env.NERVE_API_KEY || '',
  deviceCount: Number(flags.devices ?? env.NERVE_SIM_DEVICES ?? 36),
  intervalSeconds: Number(flags.interval ?? 5),
  speed: Number(flags.speed ?? 1),
  seed: Number(flags.seed ?? 20260902),
  scenario: typeof flags.scenario === 'string' ? flags.scenario : null,
  scenarioSite: typeof flags.site === 'string' ? flags.site : null,
  scenarioCount: Number(flags['scenario-devices'] ?? 2),
  scenarioDelaySeconds: Number(flags['scenario-delay'] ?? 0),
  backfillHours: flags.backfill ? Number(flags.backfill) : 0,
  backfillStepSeconds: Number(flags['backfill-step'] ?? 60),
  batchSize: Number(flags['batch-size'] ?? 250),
  dryRun: Boolean(flags['dry-run']),
  once: Boolean(flags.once),
  verbose: Boolean(flags.verbose),
  skipRegister: Boolean(flags['skip-register']),
};

// ---------------------------------------------------------------------------
// Fleet construction
// ---------------------------------------------------------------------------

/**
 * A plausible fleet mix. Gateways are deliberately few — one per site — because the
 * cascade scenario depends on many devices sitting behind a single gateway.
 */
const TYPE_MIX = [
  { code: 'amr-ld250', weight: 8 },
  { code: 'freezer-cc900', weight: 7 },
  { code: 'hvac-rtu40', weight: 4 },
  { code: 'cnc-vmc850', weight: 4 },
  { code: 'power-pm3000', weight: 2 },
];

function buildFleet(count, seed) {
  const rand = streamFor(seed, 'fleet-layout');
  const devices = [];
  const perCategoryIndex = {};

  // One gateway per site first, so every site has something to cascade from.
  for (const site of SITES) {
    const serial = `GW-${site.code}-01`;
    perCategoryIndex.gateway = (perCategoryIndex.gateway || 0) + 1;
    devices.push({
      serial,
      name: `${site.code} Gateway`,
      type_code: 'gw-edge200',
      site_code: site.code,
      location_label: 'Main comms cabinet',
      firmware_version: `2.${randInt(rand, 4, 9)}.${randInt(rand, 0, 5)}`,
      tags: ['infrastructure', 'gateway'],
      is_gateway: true,
    });
  }

  const totalWeight = TYPE_MIX.reduce((a, t) => a + t.weight, 0);
  const remaining = Math.max(0, count - devices.length);

  for (let i = 0; i < remaining; i += 1) {
    // Round-robin sites so no site is starved; weighted type pick within the site.
    const site = SITES[i % SITES.length];
    let r = rand() * totalWeight;
    let typeCode = TYPE_MIX[0].code;
    for (const t of TYPE_MIX) {
      r -= t.weight;
      if (r <= 0) {
        typeCode = t.code;
        break;
      }
    }
    const type = DEVICE_TYPES_BY_CODE[typeCode];
    perCategoryIndex[type.category] = (perCategoryIndex[type.category] || 0) + 1;
    const idx = perCategoryIndex[type.category];
    devices.push({
      serial: `${typeCode.split('-')[0].toUpperCase()}-${site.code}-${String(idx).padStart(3, '0')}`,
      name: `${deviceNameFor(type.category, idx, rand)}`,
      type_code: typeCode,
      site_code: site.code,
      location_label: locationFor(type.category, rand),
      firmware_version: `${randInt(rand, 1, 4)}.${randInt(rand, 0, 12)}.${randInt(rand, 0, 9)}`,
      tags: tagsFor(type.category, site.code),
      is_gateway: false,
    });
  }

  // Attach generator state per device from its own seeded stream.
  for (const d of devices) {
    d.rand = streamFor(seed, `dev:${d.serial}`);
    d.gen = buildGenerators(d.type_code, d.rand);
    d.scenarios = [];
    d.silencedFrom = null;
  }

  // Gateways report how many devices sit behind them.
  for (const gw of devices.filter((d) => d.is_gateway)) {
    gw.gen.downstreamCount = devices.filter((d) => d.site_code === gw.site_code && !d.is_gateway).length;
  }

  return devices;
}

function locationFor(category, rand) {
  const map = {
    robot: ['Aisle A', 'Aisle B', 'Aisle C', 'Dock 1', 'Dock 2', 'Staging'],
    refrigeration: ['Cold Room 1', 'Cold Room 2', 'Loading Bay', 'Aisle F'],
    hvac: ['Roof North', 'Roof South', 'Roof East'],
    machine_tool: ['Cell 1', 'Cell 2', 'Cell 3', 'Tool Room'],
    power: ['MSB Room', 'Panel A', 'Panel B'],
    gateway: ['Main comms cabinet'],
  };
  const opts = map[category] || ['Floor'];
  return opts[Math.floor(rand() * opts.length) % opts.length];
}

function tagsFor(category, siteCode) {
  const base = { robot: ['amr', 'material-handling'], refrigeration: ['cold-chain', 'compliance'], hvac: ['facilities'], machine_tool: ['production', 'oee'], power: ['energy'], gateway: ['infrastructure'] };
  return [...(base[category] || []), siteCode.slice(0, 3).toLowerCase()];
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class IngestClient {
  constructor({ apiBase, apiKey, dryRun, verbose }) {
    this.apiBase = apiBase;
    this.apiKey = apiKey;
    this.dryRun = dryRun;
    this.verbose = verbose;
    this.sent = 0;
    this.failed = 0;
  }

  async post(pathname, body) {
    if (this.dryRun) {
      if (this.verbose) console.log(`[dry-run] POST ${pathname}`, JSON.stringify(body).slice(0, 400));
      return { ok: true, dryRun: true };
    }
    const url = `${this.apiBase}/api:nerve-ingest${pathname}`;
    // Retry with backoff: a demo should survive a cold-start or a brief 5xx.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          // Bearer, not a custom header: Xano does not surface custom request headers
          // through $env.$http_headers on the deployed instance (x-api-key and three
          // spellings of it all 401), while the bearer path uses a documented built-in.
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        if (res.ok) return text ? JSON.parse(text) : {};
        // 4xx other than 429 will not fix itself — fail fast and say why.
        if (res.status !== 429 && res.status < 500) {
          throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 400)}`);
        }
        if (attempt === 3) throw new Error(`HTTP ${res.status} ${pathname} after retries: ${text.slice(0, 200)}`);
      } catch (err) {
        if (attempt === 3) throw err;
      }
      await sleep(400 * 2 ** attempt);
    }
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Scenario wiring
// ---------------------------------------------------------------------------

function applyScenario(devices, name, opts) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    throw new Error(`Unknown scenario '${name}'. Known: ${SCENARIO_NAMES.join(', ')}`);
  }
  const rand = streamFor(CONFIG.seed, `scenario:${name}`);
  const { targets, siteCode } = resolveTargets(scenario, devices, rand, opts);
  if (targets.length === 0) {
    console.warn(`! Scenario '${name}' matched no devices in this fleet.`);
    return { scenario, targets: [], siteCode: null };
  }
  for (const d of targets) {
    d.scenarios.push({ name, scenario, startedAt: null });
  }
  // A gateway failure takes its whole site with it — that is the cascade being demoed.
  if (scenario.cascades && siteCode) {
    for (const d of devices) {
      if (d.site_code === siteCode && !targets.includes(d)) {
        d.cascadeFrom = { siteCode, afterSeconds: 300 };
      }
    }
  }
  return { scenario, targets, siteCode };
}

/** Produce one reading for one device at simulated time `tsMs`, or null if silent. */
function readingFor(device, tsMs, dtSeconds, simElapsed) {
  for (const active of device.scenarios) {
    if (active.startedAt === null) {
      if (simElapsed < CONFIG.scenarioDelaySeconds) continue;
      active.startedAt = simElapsed;
      if (active.scenario.onStart) active.scenario.onStart(device, device.gen, {});
    }
    const elapsed = simElapsed - active.startedAt;
    if (active.scenario.silence && active.scenario.silence(device, device.gen, elapsed)) return null;
    active.scenario.apply(device, device.gen, elapsed, {});
  }
  if (device.cascadeFrom && simElapsed - CONFIG.scenarioDelaySeconds > device.cascadeFrom.afterSeconds) return null;

  const metrics = sample(device.type_code, device.gen, device.rand, tsMs, dtSeconds);
  return { device_serial: device.serial, ts: new Date(tsMs).toISOString(), metrics };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function registerFleet(client, devices) {
  console.log(`Registering ${devices.length} devices via POST /api:nerve-ingest/register ...`);
  let created = 0;
  let existing = 0;
  for (const d of devices) {
    const res = await client.post('/register', {
      serial: d.serial,
      name: d.name,
      device_type_code: d.type_code,
      site_code: d.site_code,
      firmware_version: d.firmware_version,
      location_label: d.location_label,
      tags: d.tags,
    });
    if (res?.created) created += 1;
    else existing += 1;
    if (res?.device_id) d.device_id = res.device_id;
  }
  console.log(`  ${created} provisioned, ${existing} already known.`);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runBackfill(client, devices) {
  const hours = CONFIG.backfillHours;
  const step = CONFIG.backfillStepSeconds;
  const totalTicks = Math.floor((hours * 3600) / step);
  const endMs = Date.now();
  const startMs = endMs - hours * 3600 * 1000;

  console.log(`Backfilling ${hours}h of history at ${step}s resolution (${totalTicks} ticks x ${devices.length} devices = ${(totalTicks * devices.length).toLocaleString()} readings)...`);

  let batch = [];
  let sent = 0;
  for (let tick = 0; tick < totalTicks; tick += 1) {
    const tsMs = startMs + tick * step * 1000;
    const simElapsed = tick * step;
    for (const d of devices) {
      const r = readingFor(d, tsMs, step, simElapsed);
      if (r) batch.push(r);
    }
    if (batch.length >= CONFIG.batchSize) {
      await client.post('/telemetry/batch', { readings: batch, backfill: true });
      sent += batch.length;
      batch = [];
      process.stdout.write(`\r  sent ${sent.toLocaleString()} readings (tick ${tick + 1}/${totalTicks})   `);
    }
  }
  if (batch.length) {
    await client.post('/telemetry/batch', { readings: batch, backfill: true });
    sent += batch.length;
  }
  process.stdout.write(`\r  sent ${sent.toLocaleString()} readings across ${totalTicks} ticks.            \n`);
  console.log('Backfill complete.');
}

async function runLive(client, devices) {
  const startedAt = Date.now();
  let tick = 0;
  console.log(`Streaming live telemetry: ${devices.length} devices every ${CONFIG.intervalSeconds}s (speed x${CONFIG.speed}). Ctrl-C to stop.`);

  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
    console.log('\nStopping...');
  });

  while (!stopping) {
    const wallNow = Date.now();
    // Simulated clock advances `speed`x faster than the wall clock, so a scenario that
    // takes an hour of physical degradation can be demoed in minutes.
    const simElapsed = ((wallNow - startedAt) / 1000) * CONFIG.speed;
    const dt = CONFIG.intervalSeconds * CONFIG.speed;

    const batch = [];
    let silent = 0;
    for (const d of devices) {
      const r = readingFor(d, wallNow, dt, simElapsed);
      if (r) batch.push(r);
      else silent += 1;
    }

    let result = null;
    try {
      if (batch.length) result = await client.post('/telemetry/batch', { readings: batch });
      client.sent += batch.length;
    } catch (err) {
      client.failed += 1;
      console.error(`\n! ingest failed: ${err.message}`);
    }

    tick += 1;
    const alerts = result?.alerts_fired ?? 0;
    const line = `tick ${String(tick).padStart(4)} | ${String(batch.length).padStart(3)} readings | ${silent} silent | ${client.sent.toLocaleString()} total` + (alerts ? ` | ${alerts} alerts fired` : '');
    process.stdout.write(`\r${line}   `);

    if (CONFIG.once) {
      console.log('\n--once: stopping after one tick.');
      break;
    }
    await sleep(CONFIG.intervalSeconds * 1000);
  }
  console.log(`\nSent ${client.sent.toLocaleString()} readings, ${client.failed} failed batches.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (flags['list-scenarios']) {
    console.log('\nAvailable fault scenarios:\n');
    console.log(describeScenarios());
    console.log('');
    return;
  }

  if (!CONFIG.dryRun && (!CONFIG.apiBase || !CONFIG.apiKey)) {
    console.error(
      'Missing backend config.\n' +
        '  Set NERVE_API_BASE and NERVE_API_KEY in simulator/.env, or pass\n' +
        '  --base-url https://<instance>.xano.io --api-key <ingest key>\n' +
        '  (or run with --dry-run to see generated readings without sending).'
    );
    process.exitCode = 1;
    return;
  }

  const devices = buildFleet(CONFIG.deviceCount, CONFIG.seed);
  console.log(`Fleet: ${devices.length} devices across ${SITES.length} sites, ${new Set(devices.map((d) => d.type_code)).size} device types (seed ${CONFIG.seed}).`);
  for (const site of SITES) {
    const n = devices.filter((d) => d.site_code === site.code).length;
    console.log(`  ${site.code}  ${site.name.padEnd(30)} ${n} devices`);
  }

  if (CONFIG.scenario) {
    const { scenario, targets, siteCode } = applyScenario(devices, CONFIG.scenario, {
      count: CONFIG.scenarioCount,
      siteCode: CONFIG.scenarioSite,
    });
    if (targets.length) {
      console.log(`\nScenario: ${scenario.label}`);
      console.log(`  ${scenario.description.replace(/\s+/g, ' ')}`);
      console.log(`  Affecting ${targets.length} device(s)${siteCode ? ` at ${siteCode}` : ''}: ${targets.map((t) => t.serial).join(', ')}`);
      if (CONFIG.scenarioDelaySeconds) console.log(`  Starts after ${CONFIG.scenarioDelaySeconds}s of clean baseline.`);
    }
  }
  console.log('');

  const client = new IngestClient(CONFIG);

  if (CONFIG.dryRun) {
    const d = devices[0];
    console.log('[dry-run] sample readings from the first device:\n');
    for (let i = 0; i < 3; i += 1) {
      console.log(JSON.stringify(readingFor(d, Date.now() + i * 5000, 5, i * 5), null, 2));
    }
    if (!CONFIG.once) console.log('\n(pass --once to stop here, or drop --dry-run to stream for real)');
    return;
  }

  if (!CONFIG.skipRegister) await registerFleet(client, devices);

  if (CONFIG.backfillHours > 0) await runBackfill(client, devices);
  else await runLive(client, devices);
}

main().catch((err) => {
  console.error(`\nSimulator failed: ${err.message}`);
  if (CONFIG.verbose) console.error(err.stack);
  process.exitCode = 1;
});
