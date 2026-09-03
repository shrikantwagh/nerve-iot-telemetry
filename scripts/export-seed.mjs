#!/usr/bin/env node
/**
 * Export the simulator's device catalog to `backend/seed/catalog.json`.
 *
 * The catalog is the single source of truth for site codes, device type codes and each
 * type's `metric_schema`. Three consumers depend on those codes matching exactly:
 *
 *   - the simulator, which self-registers devices by `device_type_code` + `site_code`
 *   - `POST /admin/seed`, which creates the sites and device types
 *   - the frontend, which renders charts from `metric_schema`
 *
 * If they drift, device registration fails with "unknown device type" and the cause is
 * non-obvious. Generating the seed data from the same file the simulator imports makes
 * that drift impossible rather than merely unlikely.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICE_TYPES, SITES } from '../simulator/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'backend', 'seed');
const OUT_FILE = path.join(OUT_DIR, 'catalog.json');

// Strip the generator-only fields; only the declarative half belongs in the backend.
const payload = {
  _generated_by: 'scripts/export-seed.mjs from simulator/catalog.js - do not hand-edit',
  sites: SITES.map((s) => ({
    code: s.code,
    name: s.name,
    timezone: s.timezone,
    region: s.region,
    address: s.address,
    lat: s.lat,
    lng: s.lng,
  })),
  device_types: DEVICE_TYPES.map((t) => ({
    code: t.code,
    name: t.name,
    category: t.category,
    manufacturer: t.manufacturer,
    model: t.model,
    icon: t.icon,
    offline_after_seconds: t.offline_after_seconds,
    metric_schema: t.metric_schema,
  })),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);

const metricCount = payload.device_types.reduce((n, t) => n + (t.metric_schema?.length ?? 0), 0);
console.log(
  `Wrote ${path.relative(ROOT, OUT_FILE)} - ${payload.sites.length} sites, ` +
    `${payload.device_types.length} device types, ${metricCount} metric definitions.`
);
console.log('Site codes:        ' + payload.sites.map((s) => s.code).join(', '));
console.log('Device type codes: ' + payload.device_types.map((t) => t.code).join(', '));
