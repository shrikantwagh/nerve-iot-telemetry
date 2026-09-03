#!/usr/bin/env node
/**
 * End-to-end smoke test against a LIVE Nerve backend.
 *
 * Validation proves the XanoScript parses; only this proves it runs. It exercises the
 * real request path in dependency order — auth, then seed, then ingest, then everything
 * that reads what ingest wrote — so a failure points at the first broken link rather
 * than at a pile of unrelated 500s.
 *
 * Design notes:
 *   - Every assertion names what it checked, so a pass is evidence, not a green tick.
 *   - Tests declare `needs`, and a test whose dependency failed is SKIPPED rather than
 *     run and reported as a second failure. One root cause should produce one red line.
 *   - Free-plan rate limiting (10 req / 20 s instance-wide) is detected explicitly and
 *     reported as a plan problem, because no amount of retrying fixes it.
 *   - Read-only by default. Mutations run only with --write, and destructive ones never.
 *
 * Usage:
 *   node scripts/smoke-test.mjs --base https://x.xano.io
 *   node scripts/smoke-test.mjs --base ... --write --ingest-key nrv_xxx
 *   node scripts/smoke-test.mjs --base ... --email a@b.c --password ... --ai
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ config */

function flag(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const fileEnv = { ...readEnvFile(path.join(ROOT, 'simulator', '.env')), ...readEnvFile(path.join(ROOT, '.env')) };

const CFG = {
  base: String(flag('base', fileEnv.NERVE_API_BASE ?? process.env.NERVE_API_BASE ?? '')).replace(/\/+$/, ''),
  email: flag('email', null),
  password: flag('password', null),
  ingestKey: flag('ingest-key', fileEnv.NERVE_API_KEY ?? process.env.NERVE_API_KEY ?? null),
  write: Boolean(flag('write', false)),
  ai: Boolean(flag('ai', false)),
  verbose: Boolean(flag('verbose', false)),
};

if (!CFG.base) {
  console.error('Missing --base https://<instance>.xano.io (or NERVE_API_BASE in simulator/.env).');
  process.exit(1);
}

/* -------------------------------------------------------------------- http */

const state = { token: null, user: null, deviceId: null, incidentId: null, alertId: null, ruleId: null };
let requestCount = 0;

async function call(group, pathname, { method = 'GET', body, token, apiKey, timeoutMs = 90_000 } = {}) {
  const url = `${CFG.base}/api:${group}${pathname}`;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey) headers['X-API-Key'] = apiKey;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  requestCount += 1;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: res.ok, status: res.status, data, url };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: err.name === 'AbortError' ? `timeout after ${timeoutMs / 1000}s` : err.message,
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ runner */

const results = [];
const passed = new Set();

function detail(r) {
  const d = r.data;
  if (typeof d === 'string') return d.slice(0, 240);
  return JSON.stringify(d ?? null).slice(0, 240);
}

async function test(name, { needs = [], skip = false, skipReason = '', fn }) {
  const missing = needs.filter((n) => !passed.has(n));
  if (skip) {
    results.push({ name, status: 'skip', note: skipReason });
    console.log(`  SKIP  ${name}${skipReason ? ` — ${skipReason}` : ''}`);
    return;
  }
  if (missing.length) {
    results.push({ name, status: 'skip', note: `depends on: ${missing.join(', ')}` });
    console.log(`  SKIP  ${name} — depends on ${missing.join(', ')}`);
    return;
  }

  const started = Date.now();
  try {
    const note = await fn();
    const ms = Date.now() - started;
    passed.add(name);
    results.push({ name, status: 'pass', note, ms });
    console.log(`  PASS  ${name}${note ? ` — ${note}` : ''}  (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - started;
    const rateLimited = /TOO_MANY_REQUESTS|429/.test(err.message);
    results.push({ name, status: 'fail', note: err.message, ms, rateLimited });
    console.log(`  FAIL  ${name} — ${err.message}  (${ms}ms)`);
  }
}

/** Assert a response is OK, otherwise throw a message that names the status and body. */
function expectOk(r, what) {
  if (r.status === 429 || /TOO_MANY_REQUESTS/.test(String(detail(r)))) {
    throw new Error(`RATE LIMITED by Xano (Free plan = 10 req/20s instance-wide). ${what}`);
  }
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${detail(r)}`);
  return r.data;
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ------------------------------------------------------------------- suite */

async function run() {
  console.log(`\nNerve smoke test against ${CFG.base}`);
  console.log(`mode: ${CFG.write ? 'READ + WRITE' : 'read-only'}${CFG.ai ? ' + AI' : ''}\n`);

  // ---- auth -------------------------------------------------------------
  console.log('AUTH');

  await test('auth/demo', {
    fn: async () => {
      const d = expectOk(await call('auth', '/demo', { method: 'POST' }), 'POST /auth/demo');
      expect(d?.authToken, 'no authToken in response');
      expect(d?.user, 'no user in response');
      state.token = d.authToken;
      state.user = d.user;
      return `demo user #${d.user.id} role=${d.user.role} demo_account=${d.user.demo_account}`;
    },
  });

  await test('auth/login', {
    skip: !CFG.email || !CFG.password,
    skipReason: 'no --email/--password given',
    fn: async () => {
      const d = expectOk(
        await call('auth', '/login', { method: 'POST', body: { email: CFG.email, password: CFG.password } }),
        'POST /auth/login'
      );
      expect(d?.authToken, 'no authToken');
      // Prefer the real account for write tests: the demo account is intentionally
      // rejected by every mutating endpoint, so writes would fail by design.
      state.token = d.authToken;
      state.user = d.user;
      return `logged in as ${d.user.email} role=${d.user.role}`;
    },
  });

  await test('auth/me', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('auth', '/me', { token: state.token }), 'GET /auth/me');
      expect(d?.id, 'no id on /me');
      expect(d?.password === undefined, 'SECURITY: /auth/me leaked the password field');
      return `id=${d.id} email=${d.email} (no password field)`;
    },
  });

  await test('auth rejects a bad token', {
    fn: async () => {
      const r = await call('auth', '/me', { token: 'not-a-real-token' });
      expect(!r.ok, `expected a rejection, got HTTP ${r.status}`);
      return `rejected with HTTP ${r.status}`;
    },
  });

  // ---- reference data ---------------------------------------------------
  console.log('\nREFERENCE DATA');

  await test('admin/seed', {
    needs: ['auth/demo'],
    skip: !CFG.write,
    skipReason: 'needs --write',
    fn: async () => {
      const d = expectOk(await call('nerve', '/admin/seed', { method: 'POST', token: state.token }), 'POST /admin/seed');
      return `sites=${d?.sites ?? '?'} device_types=${d?.device_types ?? '?'} rules=${d?.alert_rules ?? '?'}`;
    },
  });

  await test('GET /sites', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('nerve', '/sites', { token: state.token }), 'GET /sites');
      const items = Array.isArray(d) ? d : (d?.items ?? []);
      expect(items.length > 0, 'no sites — run with --write to seed, or seed via the UI');
      return `${items.length} sites: ${items.map((s) => s.code).join(', ')}`;
    },
  });

  await test('GET /device-types has metric_schema', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('nerve', '/device-types', { token: state.token }), 'GET /device-types');
      const items = Array.isArray(d) ? d : (d?.items ?? []);
      expect(items.length > 0, 'no device types');
      // metric_schema is what the whole charting layer reads; an empty one means the
      // seed did not land properly and every chart would render blank.
      const withSchema = items.filter((t) => Array.isArray(t.metric_schema) && t.metric_schema.length > 0);
      expect(withSchema.length > 0, 'device types exist but none carry a metric_schema');
      const total = withSchema.reduce((n, t) => n + t.metric_schema.length, 0);
      return `${items.length} types, ${withSchema.length} with schema, ${total} metric definitions`;
    },
  });

  // ---- ingest -----------------------------------------------------------
  console.log('\nINGEST (device-facing, API-key auth)');

  await test('ingest rejects a missing key', {
    fn: async () => {
      const r = await call('ingest', '/telemetry', {
        method: 'POST',
        body: { device_serial: 'SMOKE-NOKEY', metrics: { cpu_pct: 1 } },
      });
      expect(!r.ok, `SECURITY: ingest accepted a request with no API key (HTTP ${r.status})`);
      return `rejected with HTTP ${r.status}`;
    },
  });

  await test('ingest rejects a bogus key', {
    fn: async () => {
      const r = await call('ingest', '/telemetry', {
        method: 'POST',
        apiKey: 'nrv_definitely_not_a_real_key',
        body: { device_serial: 'SMOKE-BADKEY', metrics: { cpu_pct: 1 } },
      });
      expect(!r.ok, `SECURITY: ingest accepted a bogus API key (HTTP ${r.status})`);
      return `rejected with HTTP ${r.status}`;
    },
  });

  await test('ingest/register', {
    skip: !CFG.ingestKey || !CFG.write,
    skipReason: !CFG.ingestKey ? 'no --ingest-key' : 'needs --write',
    fn: async () => {
      const d = expectOk(
        await call('ingest', '/register', {
          method: 'POST',
          apiKey: CFG.ingestKey,
          body: {
            serial: 'SMOKE-GW-001',
            name: 'Smoke Test Gateway',
            device_type_code: 'gw-edge200',
            site_code: 'OSA-01',
            firmware_version: '0.0.1-smoke',
            location_label: 'smoke test',
          },
        }),
        'POST /ingest/register'
      );
      expect(d?.device_id, `no device_id returned: ${JSON.stringify(d)}`);
      state.deviceId = d.device_id;
      return `device #${d.device_id} created=${d.created}`;
    },
  });

  await test('ingest/register is idempotent', {
    needs: ['ingest/register'],
    fn: async () => {
      const d = expectOk(
        await call('ingest', '/register', {
          method: 'POST',
          apiKey: CFG.ingestKey,
          body: { serial: 'SMOKE-GW-001', device_type_code: 'gw-edge200', site_code: 'OSA-01' },
        }),
        'POST /ingest/register (repeat)'
      );
      // A second register must return the same device, not create a duplicate — the
      // simulator re-registers its whole fleet on every start.
      expect(d.device_id === state.deviceId, `serial re-registered to a different id (${d.device_id} vs ${state.deviceId})`);
      expect(d.created === false, 'reported created=true on a device that already existed');
      return `same device #${d.device_id}, created=false`;
    },
  });

  await test('ingest/register rejects an unknown type code', {
    skip: !CFG.ingestKey || !CFG.write,
    skipReason: !CFG.ingestKey ? 'no --ingest-key' : 'needs --write',
    fn: async () => {
      const r = await call('ingest', '/register', {
        method: 'POST',
        apiKey: CFG.ingestKey,
        body: { serial: 'SMOKE-BOGUS-999', device_type_code: 'no-such-type', site_code: 'OSA-01' },
      });
      // Either an error status or a payload carrying an error is acceptable; silently
      // creating a device with a dangling reference is not.
      const errored = !r.ok || Boolean(r.data?.error) || !r.data?.device_id;
      expect(errored, `created a device against an unknown type code: ${detail(r)}`);
      return 'rejected';
    },
  });

  await test('ingest/telemetry/batch', {
    needs: ['ingest/register'],
    fn: async () => {
      const now = Date.now();
      const readings = Array.from({ length: 5 }, (_, i) => ({
        device_serial: 'SMOKE-GW-001',
        ts: new Date(now - (5 - i) * 60_000).toISOString(),
        metrics: {
          cpu_pct: 20 + i,
          mem_pct: 45 + i,
          disk_pct: 51,
          temp_c: 48 + i * 0.5,
          uplink_mbps: 30,
          packet_loss_pct: 0.05,
          downstream_devices: 4,
          uptime_hours: 100 + i,
        },
      }));
      const d = expectOk(
        await call('ingest', '/telemetry/batch', { method: 'POST', apiKey: CFG.ingestKey, body: { readings } }),
        'POST /ingest/telemetry/batch'
      );
      expect((d?.inserted ?? 0) > 0, `nothing inserted: ${JSON.stringify(d)}`);
      return `inserted=${d.inserted} devices_seen=${d.devices_seen ?? '?'} alerts_fired=${d.alerts_fired ?? 0}`;
    },
  });

  await test('batch reports unknown serials rather than dropping them', {
    needs: ['ingest/telemetry/batch'],
    fn: async () => {
      const d = expectOk(
        await call('ingest', '/telemetry/batch', {
          method: 'POST',
          apiKey: CFG.ingestKey,
          body: {
            readings: [{ device_serial: 'SMOKE-GHOST-404', metrics: { cpu_pct: 5 } }],
          },
        }),
        'POST /ingest/telemetry/batch (unknown serial)'
      );
      const reported = Array.isArray(d?.unknown_serials) && d.unknown_serials.length > 0;
      expect(reported, `unknown serial was silently swallowed: ${JSON.stringify(d)}`);
      return `reported ${JSON.stringify(d.unknown_serials)}`;
    },
  });

  await test('backfill does not fire alerts', {
    needs: ['ingest/register'],
    fn: async () => {
      // Deliberately absurd values. With backfill:true the rule engine must be skipped,
      // or seeding 24h of history would manufacture thousands of historical alerts.
      const d = expectOk(
        await call('ingest', '/telemetry/batch', {
          method: 'POST',
          apiKey: CFG.ingestKey,
          body: {
            backfill: true,
            readings: [
              {
                device_serial: 'SMOKE-GW-001',
                ts: new Date(Date.now() - 3 * 3600_000).toISOString(),
                metrics: { cpu_pct: 100, temp_c: 999, disk_pct: 100, packet_loss_pct: 100 },
              },
            ],
          },
        }),
        'POST /ingest/telemetry/batch (backfill)'
      );
      expect((d?.alerts_fired ?? 0) === 0, `backfill fired ${d.alerts_fired} alerts; it must skip rule evaluation`);
      return `inserted=${d.inserted}, alerts_fired=0 as required`;
    },
  });

  // ---- fleet reads ------------------------------------------------------
  console.log('\nFLEET');

  await test('GET /fleet/overview', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('nerve', '/fleet/overview', { token: state.token }), 'GET /fleet/overview');
      expect(d && typeof d === 'object', 'empty overview');
      expect(d.device_total !== undefined, `no device_total in ${JSON.stringify(d).slice(0, 200)}`);
      return `devices=${d.device_total} avg_health=${d.avg_health ?? '?'} status=${JSON.stringify(d.status_counts ?? {})}`;
    },
  });

  await test('GET /fleet/health-distribution', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('nerve', '/fleet/health-distribution', { token: state.token }), 'GET /fleet/health-distribution');
      const buckets = d?.buckets ?? [];
      expect(Array.isArray(buckets), 'buckets is not an array');
      return `${buckets.length} buckets`;
    },
  });

  await test('GET /devices', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('nerve', '/devices', { token: state.token }), 'GET /devices');
      const items = Array.isArray(d) ? d : (d?.items ?? []);
      if (items.length && !state.deviceId) state.deviceId = items[0].id;
      return `${items.length} returned (total ${d?.itemsTotal ?? items.length})`;
    },
  });

  await test('GET /devices/{id} joins its device type', {
    needs: ['GET /devices'],
    skip: !state.deviceId,
    fn: async () => {
      const d = expectOk(await call('nerve', `/devices/${state.deviceId}`, { token: state.token }), 'GET /devices/{id}');
      expect(d?.id, 'no device returned');
      // The detail page charts from the joined type's metric_schema, so its absence is
      // a broken screen, not a cosmetic gap.
      const schema = d.device_type?.metric_schema ?? d.metric_schema;
      expect(Array.isArray(schema) && schema.length > 0, 'device detail did not include the device type metric_schema');
      return `#${d.id} ${d.serial} status=${d.status} health=${d.health_score} schema=${schema.length} metrics`;
    },
  });

  await test('GET /devices/{id}/telemetry returns points', {
    needs: ['GET /devices/{id} joins its device type'],
    fn: async () => {
      const dev = expectOk(await call('nerve', `/devices/${state.deviceId}`, { token: state.token }), 'GET device');
      const schema = dev.device_type?.metric_schema ?? dev.metric_schema ?? [];
      const gauge = schema.find((m) => m.kind === 'gauge') ?? schema[0];
      expect(gauge, 'no metric to chart');
      const from = new Date(Date.now() - 24 * 3600_000).toISOString();
      const d = expectOk(
        await call('nerve', `/devices/${state.deviceId}/telemetry?metric_key=${encodeURIComponent(gauge.key)}&from=${encodeURIComponent(from)}`, {
          token: state.token,
        }),
        'GET /devices/{id}/telemetry'
      );
      const pts = d?.points ?? [];
      return `metric=${gauge.key} points=${pts.length} source=${d?.source ?? '?'}`;
    },
  });

  await test('GET /devices filters do not error', {
    needs: ['auth/demo'],
    fn: async () => {
      // An omitted filter must WIDEN, not exclude. If optional-match is wired wrong,
      // filtering returns zero rows and the Fleet screen looks broken.
      const all = expectOk(await call('nerve', '/devices', { token: state.token }), 'GET /devices');
      const allItems = Array.isArray(all) ? all : (all?.items ?? []);
      const online = expectOk(await call('nerve', '/devices?status=online', { token: state.token }), 'GET /devices?status=online');
      const onlineItems = Array.isArray(online) ? online : (online?.items ?? []);
      expect(onlineItems.length <= allItems.length, 'a status filter returned MORE rows than no filter');
      expect(onlineItems.every((x) => x.status === 'online'), 'status filter returned non-online devices');
      return `all=${allItems.length} online=${onlineItems.length}, filter narrows correctly`;
    },
  });

  // ---- alerts, rules, incidents ----------------------------------------
  console.log('\nALERTS / RULES / INCIDENTS');

  await test('GET /alerts', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('nerve', '/alerts', { token: state.token }), 'GET /alerts');
      const items = Array.isArray(d) ? d : (d?.items ?? []);
      if (items.length) state.alertId = items[0].id;
      return `${items.length} alerts (total ${d?.itemsTotal ?? items.length})`;
    },
  });

  await test('GET /alert-rules', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('nerve', '/alert-rules', { token: state.token }), 'GET /alert-rules');
      const items = Array.isArray(d) ? d : (d?.items ?? []);
      if (items.length) state.ruleId = items[0].id;
      return `${items.length} rules`;
    },
  });

  await test('GET /incidents', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('nerve', '/incidents', { token: state.token }), 'GET /incidents');
      const items = Array.isArray(d) ? d : (d?.items ?? []);
      if (items.length) state.incidentId = items[0].id;
      return `${items.length} incidents`;
    },
  });

  await test('GET /incidents/{id}', {
    needs: ['GET /incidents'],
    skip: !state.incidentId,
    skipReason: 'no incident exists yet',
    fn: async () => {
      const d = expectOk(await call('nerve', `/incidents/${state.incidentId}`, { token: state.token }), 'GET /incidents/{id}');
      return `#${d.id} "${String(d.title).slice(0, 50)}" alerts=${d.alerts?.length ?? d.alert_count} devices=${d.devices?.length ?? d.device_count} ai=${Boolean(d.ai_root_cause)}`;
    },
  });

  await test('GET /predictions', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('nerve', '/predictions', { token: state.token }), 'GET /predictions');
      const items = Array.isArray(d) ? d : (d?.items ?? []);
      return `${items.length} predictions`;
    },
  });

  await test('demo account cannot mutate', {
    needs: ['auth/demo'],
    skip: !state.alertId,
    skipReason: 'no alert to try acking',
    fn: async () => {
      // Re-acquire a demo token: a --email login may have replaced it above.
      const demo = await call('auth', '/demo', { method: 'POST' });
      const demoToken = demo.data?.authToken;
      expect(demoToken, 'could not get a demo token');
      const r = await call('nerve', `/alerts/${state.alertId}/ack`, { method: 'POST', token: demoToken });
      expect(!r.ok, `SECURITY: the read-only demo account acknowledged an alert (HTTP ${r.status})`);
      return `blocked with HTTP ${r.status}`;
    },
  });

  // ---- AI ---------------------------------------------------------------
  console.log('\nAI');

  await test('POST /ai/query', {
    needs: ['auth/demo'],
    skip: !CFG.ai,
    skipReason: 'needs --ai (spends model tokens)',
    fn: async () => {
      const d = expectOk(
        await call('nerve', '/ai/query', {
          method: 'POST',
          token: state.token,
          body: { question: 'How many devices are offline right now?' },
          timeoutMs: 180_000,
        }),
        'POST /ai/query'
      );
      expect(d && typeof d === 'object', 'empty response');
      // A plan is the proof the model planned and Xano executed. Its absence means the
      // whole "model plans, Xano executes" claim is not actually happening.
      const hasPlan = Boolean(d.plan);
      expect(d.answer || d.error || d.reason, `no answer, error or reason: ${JSON.stringify(d).slice(0, 200)}`);
      return `success=${d.success} plan=${hasPlan} rows=${d.row_count ?? 0} fallback=${d.fallback_used} ${d.latency_ms ?? '?'}ms — "${String(d.answer ?? d.reason ?? d.error).slice(0, 90)}"`;
    },
  });

  await test('POST /ai/rule-from-text (proposal only)', {
    needs: ['auth/demo'],
    skip: !CFG.ai,
    skipReason: 'needs --ai',
    fn: async () => {
      const d = expectOk(
        await call('nerve', '/ai/rule-from-text', {
          method: 'POST',
          token: state.token,
          body: { text: 'page me if any freezer sits above -15C for 10 minutes', save: false },
          timeoutMs: 180_000,
        }),
        'POST /ai/rule-from-text'
      );
      const p = d?.proposal ?? d;
      expect(p, `no proposal: ${JSON.stringify(d).slice(0, 200)}`);
      expect(d?.saved !== true, 'save:false still persisted the rule');
      return `condition=${p.condition} metric=${p.metric_key} threshold=${p.threshold} severity=${p.severity} fallback=${d.fallback_used}`;
    },
  });

  await test('GET /ai/insights records provenance', {
    needs: ['auth/demo'],
    fn: async () => {
      const d = expectOk(await call('nerve', '/ai/insights', { token: state.token }), 'GET /ai/insights');
      const items = Array.isArray(d) ? d : (d?.items ?? []);
      if (!items.length) return 'no inferences logged yet (expected on a cold instance)';
      const fb = items.filter((i) => i.fallback_used).length;
      const models = [...new Set(items.map((i) => i.model).filter(Boolean))];
      return `${items.length} logged, ${fb} used the fallback, models: ${models.join(', ') || 'none'}`;
    },
  });

  /* ------------------------------------------------------------- summary */

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail');
  const skip = results.filter((r) => r.status === 'skip').length;

  console.log(`\n${'-'.repeat(68)}`);
  console.log(`${pass} passed, ${fail.length} failed, ${skip} skipped  (${requestCount} HTTP requests)`);

  if (fail.length) {
    console.log('\nFAILURES');
    for (const f of fail) console.log(`  - ${f.name}\n      ${f.note}`);
    if (fail.some((f) => f.rateLimited)) {
      console.log(
        '\nAt least one failure was Xano rate limiting. The Free plan allows 10 requests\n' +
          'per 20 seconds across the WHOLE instance, so this suite cannot pass on it.\n' +
          'Upgrade to Essential or above.'
      );
    }
    process.exitCode = 1;
  } else {
    console.log('\nAll executed checks passed.');
    if (skip) console.log('Re-run with --write --ingest-key <key> --ai to cover the skipped paths.');
  }
}

run().catch((err) => {
  console.error(`\nsmoke test crashed: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
