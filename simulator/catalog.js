/**
 * The device catalog — the single source of truth for both the simulator and the
 * backend seed.
 *
 * `metric_schema` here is exactly what lands in the Xano `device_type.metric_schema`
 * json column, which is what makes onboarding one call instead of six console screens:
 * the backend learns a device class's units, nominal bands and hard sensor limits from
 * this declaration, and the frontend renders charts from the same thing. One
 * declaration, three consumers.
 *
 * `scripts/export-seed.mjs` serialises the schema half of this file to
 * `backend/seed/catalog.json` so the two can never drift.
 */

import { Gauge, Counter, DutyState, ModeState, Battery } from './lib/signal.js';
import { randBetween, randInt, pick } from './lib/rng.js';

/** Sites the demo fleet lives in. Spread across timezones so the diurnal curves differ. */
export const SITES = [
  { code: 'OSA-01', name: 'Osaka Distribution Center', timezone: 'Asia/Tokyo', region: 'APAC', lat: 34.6937, lng: 135.5023, address: '2-1 Nanko-kita, Suminoe-ku, Osaka' },
  { code: 'MUC-02', name: 'Munich Assembly Plant', timezone: 'Europe/Berlin', region: 'EMEA', lat: 48.1351, lng: 11.582, address: 'Lilienthalallee 40, Munich' },
  { code: 'CHI-03', name: 'Chicago Fulfillment Hub', timezone: 'America/Chicago', region: 'AMER', lat: 41.8781, lng: -87.6298, address: '1400 S Rockwell St, Chicago, IL' },
  { code: 'SGP-04', name: 'Singapore Cold Chain', timezone: 'Asia/Singapore', region: 'APAC', lat: 1.3521, lng: 103.8198, address: '21 Jurong Port Rd, Singapore' },
];

/**
 * `kind` drives how the frontend charts a metric and how rules may target it:
 *   gauge   — continuous, chartable as a line, supports thresholds and anomaly rules
 *   counter — monotonic; only rate-of-change rules make sense
 *   state   — binary/enumerated; flatline and duty-cycle rules make sense, thresholds don't
 */
export const DEVICE_TYPES = [
  {
    code: 'amr-ld250',
    name: 'AMR — Autonomous Mobile Robot',
    category: 'robot',
    manufacturer: 'OMRON',
    model: 'LD-250',
    icon: 'robot',
    offline_after_seconds: 120,
    metric_schema: [
      { key: 'battery_pct', label: 'Battery', unit: '%', kind: 'gauge', nominal_min: 25, nominal_max: 100, hard_min: 0, hard_max: 100, precision: 1 },
      { key: 'battery_temp_c', label: 'Battery temp', unit: '°C', kind: 'gauge', nominal_min: 10, nominal_max: 45, hard_min: -20, hard_max: 90, precision: 1 },
      { key: 'motor_temp_c', label: 'Motor temp', unit: '°C', kind: 'gauge', nominal_min: 20, nominal_max: 75, hard_min: -20, hard_max: 140, precision: 1 },
      { key: 'motor_current_a', label: 'Motor current', unit: 'A', kind: 'gauge', nominal_min: 0, nominal_max: 24, hard_min: 0, hard_max: 60, precision: 2 },
      { key: 'wheel_slip_pct', label: 'Wheel slip', unit: '%', kind: 'gauge', nominal_min: 0, nominal_max: 4, hard_min: 0, hard_max: 100, precision: 2 },
      { key: 'localization_conf', label: 'Localization confidence', unit: '', kind: 'gauge', nominal_min: 0.85, nominal_max: 1, hard_min: 0, hard_max: 1, precision: 3 },
      { key: 'speed_mps', label: 'Speed', unit: 'm/s', kind: 'gauge', nominal_min: 0, nominal_max: 1.8, hard_min: 0, hard_max: 2.5, precision: 2 },
      { key: 'payload_kg', label: 'Payload', unit: 'kg', kind: 'gauge', nominal_min: 0, nominal_max: 250, hard_min: 0, hard_max: 300, precision: 1 },
      { key: 'wifi_rssi_dbm', label: 'Wi-Fi RSSI', unit: 'dBm', kind: 'gauge', nominal_min: -70, nominal_max: -40, hard_min: -100, hard_max: 0, precision: 0 },
      { key: 'estop_engaged', label: 'E-stop engaged', unit: '', kind: 'state', precision: 0 },
      { key: 'odometry_km', label: 'Odometry', unit: 'km', kind: 'counter', precision: 3 },
      { key: 'dock_cycles', label: 'Dock cycles', unit: '', kind: 'counter', precision: 0 },
    ],
  },
  {
    code: 'freezer-cc900',
    name: 'Cold-Chain Freezer',
    category: 'refrigeration',
    manufacturer: 'Carrier',
    model: 'CC-900',
    icon: 'snowflake',
    offline_after_seconds: 300,
    metric_schema: [
      { key: 'temp_c', label: 'Cabinet temp', unit: '°C', kind: 'gauge', nominal_min: -24, nominal_max: -16, hard_min: -40, hard_max: 30, precision: 2 },
      { key: 'setpoint_c', label: 'Setpoint', unit: '°C', kind: 'gauge', nominal_min: -24, nominal_max: -16, hard_min: -40, hard_max: 0, precision: 1 },
      { key: 'evap_temp_c', label: 'Evaporator temp', unit: '°C', kind: 'gauge', nominal_min: -34, nominal_max: -22, hard_min: -50, hard_max: 20, precision: 1 },
      { key: 'humidity_pct', label: 'Humidity', unit: '%', kind: 'gauge', nominal_min: 20, nominal_max: 60, hard_min: 0, hard_max: 100, precision: 1 },
      { key: 'power_w', label: 'Power draw', unit: 'W', kind: 'gauge', nominal_min: 200, nominal_max: 1400, hard_min: 0, hard_max: 3000, precision: 0 },
      { key: 'door_open_seconds', label: 'Door open (rolling)', unit: 's', kind: 'gauge', nominal_min: 0, nominal_max: 60, hard_min: 0, hard_max: 3600, precision: 0 },
      { key: 'compressor_on', label: 'Compressor', unit: '', kind: 'state', precision: 0 },
      { key: 'door_open', label: 'Door', unit: '', kind: 'state', precision: 0 },
      { key: 'defrost_cycles', label: 'Defrost cycles', unit: '', kind: 'counter', precision: 0 },
      { key: 'energy_kwh', label: 'Energy', unit: 'kWh', kind: 'counter', precision: 2 },
    ],
  },
  {
    code: 'hvac-rtu40',
    name: 'Rooftop HVAC Unit',
    category: 'hvac',
    manufacturer: 'Daikin',
    model: 'RTU-40',
    icon: 'wind',
    offline_after_seconds: 300,
    metric_schema: [
      { key: 'supply_temp_c', label: 'Supply air', unit: '°C', kind: 'gauge', nominal_min: 11, nominal_max: 16, hard_min: -10, hard_max: 60, precision: 1 },
      { key: 'return_temp_c', label: 'Return air', unit: '°C', kind: 'gauge', nominal_min: 20, nominal_max: 26, hard_min: -10, hard_max: 60, precision: 1 },
      { key: 'fan_rpm', label: 'Fan speed', unit: 'rpm', kind: 'gauge', nominal_min: 600, nominal_max: 1500, hard_min: 0, hard_max: 2000, precision: 0 },
      { key: 'suction_pressure_kpa', label: 'Suction pressure', unit: 'kPa', kind: 'gauge', nominal_min: 380, nominal_max: 520, hard_min: 0, hard_max: 1200, precision: 0 },
      { key: 'filter_dp_pa', label: 'Filter Δp', unit: 'Pa', kind: 'gauge', nominal_min: 40, nominal_max: 220, hard_min: 0, hard_max: 600, precision: 0 },
      { key: 'power_w', label: 'Power draw', unit: 'W', kind: 'gauge', nominal_min: 400, nominal_max: 7000, hard_min: 0, hard_max: 12000, precision: 0 },
      { key: 'compressor_on', label: 'Compressor', unit: '', kind: 'state', precision: 0 },
      { key: 'compressor_starts', label: 'Compressor starts', unit: '', kind: 'counter', precision: 0 },
      { key: 'runtime_hours', label: 'Runtime', unit: 'h', kind: 'counter', precision: 2 },
    ],
  },
  {
    code: 'cnc-vmc850',
    name: 'CNC Vertical Machining Center',
    category: 'machine_tool',
    manufacturer: 'Mazak',
    model: 'VMC-850',
    icon: 'cog',
    offline_after_seconds: 180,
    metric_schema: [
      { key: 'spindle_rpm', label: 'Spindle speed', unit: 'rpm', kind: 'gauge', nominal_min: 0, nominal_max: 12000, hard_min: 0, hard_max: 15000, precision: 0 },
      { key: 'spindle_load_pct', label: 'Spindle load', unit: '%', kind: 'gauge', nominal_min: 0, nominal_max: 85, hard_min: 0, hard_max: 150, precision: 1 },
      { key: 'spindle_temp_c', label: 'Spindle temp', unit: '°C', kind: 'gauge', nominal_min: 25, nominal_max: 62, hard_min: 0, hard_max: 120, precision: 1 },
      { key: 'vibration_mm_s', label: 'Vibration (RMS)', unit: 'mm/s', kind: 'gauge', nominal_min: 0, nominal_max: 2.8, hard_min: 0, hard_max: 25, precision: 3 },
      { key: 'coolant_temp_c', label: 'Coolant temp', unit: '°C', kind: 'gauge', nominal_min: 16, nominal_max: 30, hard_min: 0, hard_max: 80, precision: 1 },
      { key: 'coolant_flow_lpm', label: 'Coolant flow', unit: 'L/min', kind: 'gauge', nominal_min: 8, nominal_max: 20, hard_min: 0, hard_max: 40, precision: 2 },
      { key: 'axis_error_um', label: 'Axis position error', unit: 'µm', kind: 'gauge', nominal_min: 0, nominal_max: 12, hard_min: 0, hard_max: 200, precision: 1 },
      { key: 'mode', label: 'Mode', unit: '', kind: 'state', precision: 0 },
      { key: 'cycle_count', label: 'Cycles', unit: '', kind: 'counter', precision: 0 },
      { key: 'spindle_hours', label: 'Spindle hours', unit: 'h', kind: 'counter', precision: 2 },
    ],
  },
  {
    code: 'power-pm3000',
    name: '3-Phase Power Meter',
    category: 'power',
    manufacturer: 'Schneider',
    model: 'PM-3000',
    icon: 'bolt',
    offline_after_seconds: 180,
    metric_schema: [
      { key: 'voltage_l1_v', label: 'Voltage L1', unit: 'V', kind: 'gauge', nominal_min: 396, nominal_max: 424, hard_min: 0, hard_max: 600, precision: 1 },
      { key: 'voltage_l2_v', label: 'Voltage L2', unit: 'V', kind: 'gauge', nominal_min: 396, nominal_max: 424, hard_min: 0, hard_max: 600, precision: 1 },
      { key: 'voltage_l3_v', label: 'Voltage L3', unit: 'V', kind: 'gauge', nominal_min: 396, nominal_max: 424, hard_min: 0, hard_max: 600, precision: 1 },
      { key: 'current_a', label: 'Current', unit: 'A', kind: 'gauge', nominal_min: 5, nominal_max: 180, hard_min: 0, hard_max: 400, precision: 2 },
      { key: 'power_kw', label: 'Active power', unit: 'kW', kind: 'gauge', nominal_min: 2, nominal_max: 110, hard_min: 0, hard_max: 250, precision: 2 },
      { key: 'power_factor', label: 'Power factor', unit: '', kind: 'gauge', nominal_min: 0.9, nominal_max: 1, hard_min: 0, hard_max: 1, precision: 3 },
      { key: 'frequency_hz', label: 'Frequency', unit: 'Hz', kind: 'gauge', nominal_min: 49.8, nominal_max: 50.2, hard_min: 45, hard_max: 65, precision: 2 },
      { key: 'thd_pct', label: 'Voltage THD', unit: '%', kind: 'gauge', nominal_min: 0, nominal_max: 5, hard_min: 0, hard_max: 40, precision: 2 },
      { key: 'energy_kwh', label: 'Energy', unit: 'kWh', kind: 'counter', precision: 2 },
    ],
  },
  {
    code: 'gw-edge200',
    name: 'Edge Gateway',
    category: 'gateway',
    manufacturer: 'Advantech',
    model: 'EDGE-200',
    icon: 'router',
    offline_after_seconds: 90,
    metric_schema: [
      { key: 'cpu_pct', label: 'CPU', unit: '%', kind: 'gauge', nominal_min: 2, nominal_max: 70, hard_min: 0, hard_max: 100, precision: 1 },
      { key: 'mem_pct', label: 'Memory', unit: '%', kind: 'gauge', nominal_min: 10, nominal_max: 80, hard_min: 0, hard_max: 100, precision: 1 },
      { key: 'disk_pct', label: 'Disk', unit: '%', kind: 'gauge', nominal_min: 10, nominal_max: 85, hard_min: 0, hard_max: 100, precision: 1 },
      { key: 'temp_c', label: 'Board temp', unit: '°C', kind: 'gauge', nominal_min: 25, nominal_max: 70, hard_min: -20, hard_max: 105, precision: 1 },
      { key: 'uplink_mbps', label: 'Uplink', unit: 'Mbps', kind: 'gauge', nominal_min: 1, nominal_max: 90, hard_min: 0, hard_max: 1000, precision: 2 },
      { key: 'packet_loss_pct', label: 'Packet loss', unit: '%', kind: 'gauge', nominal_min: 0, nominal_max: 1, hard_min: 0, hard_max: 100, precision: 3 },
      { key: 'downstream_devices', label: 'Downstream devices', unit: '', kind: 'gauge', nominal_min: 1, nominal_max: 64, hard_min: 0, hard_max: 256, precision: 0 },
      { key: 'uptime_hours', label: 'Uptime', unit: 'h', kind: 'counter', precision: 2 },
    ],
  },
];

export const DEVICE_TYPES_BY_CODE = Object.fromEntries(DEVICE_TYPES.map((t) => [t.code, t]));

/**
 * Build the stateful generator set for one device.
 *
 * Each device gets its *own* generator objects — sharing them would make every freezer
 * report identical numbers, which defeats the point of per-device baselines.
 */
export function buildGenerators(typeCode, rand) {
  switch (typeCode) {
    case 'amr-ld250': {
      const battery = new Battery({ rand, dischargePctPerHour: randBetween(rand, 9, 14), chargePctPerHour: randBetween(rand, 42, 55) });
      return {
        battery,
        battery_pct: battery,
        battery_temp_c: new Gauge({ base: randBetween(rand, 26, 32), noise: 0.5, diurnal: 1.5, min: -20, max: 90, precision: 1 }),
        motor_temp_c: new Gauge({ base: randBetween(rand, 44, 54), noise: 2.2, diurnal: 3, min: -20, max: 140, precision: 1 }),
        motor_current_a: new Gauge({ base: randBetween(rand, 8, 13), noise: 2.6, min: 0, max: 60, precision: 2 }),
        wheel_slip_pct: new Gauge({ base: randBetween(rand, 0.6, 1.6), noise: 0.4, min: 0, max: 100, precision: 2 }),
        localization_conf: new Gauge({ base: randBetween(rand, 0.94, 0.985), noise: 0.012, min: 0, max: 1, precision: 3 }),
        speed_mps: new Gauge({ base: randBetween(rand, 0.9, 1.35), noise: 0.28, min: 0, max: 2.5, precision: 2 }),
        payload_kg: new Gauge({ base: randBetween(rand, 60, 150), noise: 22, min: 0, max: 300, precision: 1 }),
        wifi_rssi_dbm: new Gauge({ base: randBetween(rand, -62, -48), noise: 3.5, min: -100, max: 0, precision: 0 }),
        estop_engaged: new DutyState({ onSeconds: 25, offSeconds: 5400, jitter: 0.6 }),
        odometry_km: new Counter({ start: randBetween(rand, 400, 9000), perSecond: 0.00032, jitter: 0.2, precision: 3 }),
      };
    }
    case 'freezer-cc900': {
      const setpoint = -Math.round(randBetween(rand, 18, 22));
      return {
        setpointValue: setpoint,
        temp_c: new Gauge({ base: setpoint + randBetween(rand, -0.6, 0.6), noise: 0.35, diurnal: 0.4, min: -40, max: 30, precision: 2 }),
        evap_temp_c: new Gauge({ base: setpoint - randBetween(rand, 6, 9), noise: 0.7, min: -50, max: 20, precision: 1 }),
        humidity_pct: new Gauge({ base: randBetween(rand, 30, 45), noise: 2.5, min: 0, max: 100, precision: 1 }),
        power_w: new Gauge({ base: randBetween(rand, 700, 950), noise: 90, diurnal: 120, min: 0, max: 3000, precision: 0 }),
        compressor_on: new DutyState({ onSeconds: randBetween(rand, 420, 600), offSeconds: randBetween(rand, 700, 1000), startOn: rand() > 0.5 }),
        door_open: new DutyState({ onSeconds: 22, offSeconds: randBetween(rand, 1500, 3200), jitter: 0.7 }),
        defrost_cycles: new Counter({ start: randInt(rand, 40, 900), perSecond: 1 / 21600, precision: 0 }),
        energy_kwh: new Counter({ start: randBetween(rand, 900, 24000), perSecond: 0.00023, jitter: 0.1, precision: 2 }),
      };
    }
    case 'hvac-rtu40':
      return {
        supply_temp_c: new Gauge({ base: randBetween(rand, 12.5, 14.5), noise: 0.5, min: -10, max: 60, precision: 1 }),
        return_temp_c: new Gauge({ base: randBetween(rand, 22, 24.5), noise: 0.6, diurnal: 1.8, min: -10, max: 60, precision: 1 }),
        fan_rpm: new Gauge({ base: randBetween(rand, 900, 1200), noise: 45, diurnal: 180, min: 0, max: 2000, precision: 0 }),
        suction_pressure_kpa: new Gauge({ base: randBetween(rand, 430, 470), noise: 14, min: 0, max: 1200, precision: 0 }),
        filter_dp_pa: new Gauge({ base: randBetween(rand, 70, 150), drift: 0.004, noise: 6, reversion: 0.0004, min: 0, max: 600, precision: 0 }),
        power_w: new Gauge({ base: randBetween(rand, 3200, 4600), noise: 320, diurnal: 1400, min: 0, max: 12000, precision: 0 }),
        compressor_on: new DutyState({ onSeconds: randBetween(rand, 700, 1100), offSeconds: randBetween(rand, 500, 900), startOn: rand() > 0.5 }),
        runtime_hours: new Counter({ start: randBetween(rand, 2000, 31000), perSecond: 1 / 3600, precision: 2 }),
      };
    case 'cnc-vmc850':
      return {
        mode: new ModeState({ modes: ['running', 'idle', 'setup', 'alarm'], weights: [70, 20, 9, 1], dwellSeconds: 900 }),
        spindle_rpm: new Gauge({ base: randBetween(rand, 6500, 9200), noise: 420, min: 0, max: 15000, precision: 0 }),
        spindle_load_pct: new Gauge({ base: randBetween(rand, 42, 62), noise: 9, min: 0, max: 150, precision: 1 }),
        spindle_temp_c: new Gauge({ base: randBetween(rand, 38, 48), noise: 1.6, diurnal: 2.5, min: 0, max: 120, precision: 1 }),
        vibration_mm_s: new Gauge({ base: randBetween(rand, 0.7, 1.5), noise: 0.16, reversion: 0.01, min: 0, max: 25, precision: 3 }),
        coolant_temp_c: new Gauge({ base: randBetween(rand, 20, 25), noise: 0.9, diurnal: 2, min: 0, max: 80, precision: 1 }),
        coolant_flow_lpm: new Gauge({ base: randBetween(rand, 12, 16), noise: 0.8, min: 0, max: 40, precision: 2 }),
        axis_error_um: new Gauge({ base: randBetween(rand, 2.5, 6), noise: 1.1, min: 0, max: 200, precision: 1 }),
        cycle_count: new Counter({ start: randInt(rand, 5000, 240000), perSecond: 1 / 220, jitter: 0.25, precision: 0 }),
        spindle_hours: new Counter({ start: randBetween(rand, 1200, 26000), perSecond: 1 / 3600, precision: 2 }),
      };
    case 'power-pm3000': {
      const nominal = randBetween(rand, 408, 416);
      return {
        nominalVoltage: nominal,
        voltage_l1_v: new Gauge({ base: nominal, noise: 1.6, min: 0, max: 600, precision: 1 }),
        voltage_l2_v: new Gauge({ base: nominal + randBetween(rand, -1.5, 1.5), noise: 1.6, min: 0, max: 600, precision: 1 }),
        voltage_l3_v: new Gauge({ base: nominal + randBetween(rand, -1.5, 1.5), noise: 1.6, min: 0, max: 600, precision: 1 }),
        // Floored well above zero: a live feeder always carries base load, and a meter
        // reading 0 A while reporting 410 V is a physically impossible pair that would
        // make the whole dataset suspect. The floor also keeps the derived power_kw
        // (sqrt(3) * V * I * pf) away from a bogus zero.
        current_a: new Gauge({ base: randBetween(rand, 48, 95), noise: 7, diurnal: 18, min: 3, max: 400, precision: 2 }),
        power_factor: new Gauge({ base: randBetween(rand, 0.93, 0.975), noise: 0.012, min: 0, max: 1, precision: 3 }),
        frequency_hz: new Gauge({ base: 50, noise: 0.03, min: 45, max: 65, precision: 2 }),
        thd_pct: new Gauge({ base: randBetween(rand, 1.6, 3.2), noise: 0.4, min: 0, max: 40, precision: 2 }),
        energy_kwh: new Counter({ start: randBetween(rand, 40000, 900000), perSecond: 0.014, jitter: 0.15, precision: 2 }),
      };
    }
    case 'gw-edge200':
      return {
        // Noise is kept well below the base for every metric here. At a 5-second sample
        // interval, real sensor noise is small and the visible variation comes from the
        // walk and the diurnal term — noise large enough to clamp a gauge at its floor
        // (a gateway reporting 0% CPU between two healthy samples) reads as obviously
        // synthetic, and worse, it manufactures anomalies the AI is then asked to explain.
        cpu_pct: new Gauge({ base: randBetween(rand, 16, 30), noise: 2.4, diurnal: 6, min: 0.5, max: 100, precision: 1 }),
        mem_pct: new Gauge({ base: randBetween(rand, 38, 58), noise: 1.6, drift: 0.0008, reversion: 0.0008, min: 1, max: 100, precision: 1 }),
        disk_pct: new Gauge({ base: randBetween(rand, 30, 58), noise: 0.3, drift: 0.0004, reversion: 0.0002, min: 1, max: 100, precision: 1 }),
        temp_c: new Gauge({ base: randBetween(rand, 44, 54), noise: 1.1, diurnal: 4, min: -20, max: 105, precision: 1 }),
        uplink_mbps: new Gauge({ base: randBetween(rand, 14, 40), noise: 3, diurnal: 8, min: 0.4, max: 1000, precision: 2 }),
        packet_loss_pct: new Gauge({ base: randBetween(rand, 0.02, 0.25), noise: 0.06, min: 0, max: 100, precision: 3 }),
        uptime_hours: new Counter({ start: randBetween(rand, 20, 4000), perSecond: 1 / 3600, precision: 2 }),
      };
    default:
      throw new Error(`Unknown device type code: ${typeCode}`);
  }
}

/**
 * Produce one reading. Returns a flat `{metricKey: value}` object — exactly the
 * `metrics` json the ingest endpoint stores.
 *
 * The derived/cross-metric relationships live here rather than in the generators,
 * because they are what make the data *physically plausible*: a freezer's power tracks
 * its compressor, an idle CNC's spindle drops to zero, an AMR on the dock draws no motor
 * current. Independent per-metric noise would look obviously synthetic, and worse, would
 * make the AI's root-cause reasoning meaningless because nothing would correlate.
 */
export function sample(typeCode, gen, rand, tsMs, dtSeconds) {
  switch (typeCode) {
    case 'amr-ld250': {
      const batteryPct = gen.battery.next(rand, tsMs, dtSeconds);
      const charging = gen.battery.charging;
      const estop = gen.estop_engaged.next(rand, tsMs, dtSeconds);
      const moving = !charging && !estop;
      const speed = moving ? gen.speed_mps.next(rand, tsMs) : 0;
      const current = moving ? gen.motor_current_a.next(rand, tsMs) : 0.4;
      // Motor temp follows load, so a stalled robot cools and a hauling one heats.
      const motorTemp = gen.motor_temp_c.next(rand, tsMs) + (moving ? current * 0.55 : -6);
      if (moving) gen.odometry_km.rateScale = speed / 1.2;
      else gen.odometry_km.rateScale = 0;
      return {
        battery_pct: batteryPct,
        battery_temp_c: gen.battery_temp_c.next(rand, tsMs) + (charging ? 5.5 : 0),
        motor_temp_c: Math.round(motorTemp * 10) / 10,
        motor_current_a: current,
        wheel_slip_pct: moving ? gen.wheel_slip_pct.next(rand, tsMs) : 0,
        localization_conf: gen.localization_conf.next(rand, tsMs),
        speed_mps: speed,
        payload_kg: moving ? gen.payload_kg.next(rand, tsMs) : 0,
        wifi_rssi_dbm: gen.wifi_rssi_dbm.next(rand, tsMs),
        estop_engaged: estop,
        odometry_km: gen.odometry_km.next(rand, tsMs, dtSeconds),
        dock_cycles: gen.battery.dockCycles,
      };
    }
    case 'freezer-cc900': {
      const doorOpen = gen.door_open.next(rand, tsMs, dtSeconds);
      const compressor = gen.compressor_on.next(rand, tsMs, dtSeconds);
      // An open door pushes cabinet temp up; the compressor pulls it down.
      gen.temp_c.offset += (doorOpen ? 0.16 : 0) - (compressor ? 0.05 : -0.03);
      gen.temp_c.offset = Math.max(-1.5, Math.min(14, gen.temp_c.offset));
      const temp = gen.temp_c.next(rand, tsMs);
      gen.energy_kwh.rateScale = compressor ? 1.9 : 0.35;
      return {
        temp_c: temp,
        setpoint_c: gen.setpointValue,
        evap_temp_c: gen.evap_temp_c.next(rand, tsMs) + (compressor ? -2.5 : 3),
        humidity_pct: gen.humidity_pct.next(rand, tsMs) + (doorOpen ? 14 : 0),
        power_w: Math.round(gen.power_w.next(rand, tsMs) * (compressor ? 1 : 0.18)),
        door_open_seconds: doorOpen ? Math.round(gen.door_open.targetDwell(rand) - gen.door_open.remaining) : 0,
        compressor_on: compressor,
        door_open: doorOpen,
        defrost_cycles: gen.defrost_cycles.next(rand, tsMs, dtSeconds),
        energy_kwh: gen.energy_kwh.next(rand, tsMs, dtSeconds),
      };
    }
    case 'hvac-rtu40': {
      const compressor = gen.compressor_on.next(rand, tsMs, dtSeconds);
      gen.runtime_hours.rateScale = compressor ? 1 : 0.15;
      const supply = gen.supply_temp_c.next(rand, tsMs) + (compressor ? 0 : 6.5);
      return {
        supply_temp_c: Math.round(supply * 10) / 10,
        return_temp_c: gen.return_temp_c.next(rand, tsMs),
        fan_rpm: gen.fan_rpm.next(rand, tsMs),
        suction_pressure_kpa: gen.suction_pressure_kpa.next(rand, tsMs) + (compressor ? -35 : 40),
        filter_dp_pa: gen.filter_dp_pa.next(rand, tsMs),
        power_w: Math.round(gen.power_w.next(rand, tsMs) * (compressor ? 1 : 0.22)),
        compressor_on: compressor,
        compressor_starts: gen.compressor_on.transitions,
        runtime_hours: gen.runtime_hours.next(rand, tsMs, dtSeconds),
      };
    }
    case 'cnc-vmc850': {
      const mode = gen.mode.next(rand, tsMs, dtSeconds);
      const running = mode === 'running';
      gen.cycle_count.rateScale = running ? 1 : 0;
      gen.spindle_hours.rateScale = running ? 1 : 0;
      const load = running ? gen.spindle_load_pct.next(rand, tsMs) : 0;
      return {
        spindle_rpm: running ? gen.spindle_rpm.next(rand, tsMs) : 0,
        spindle_load_pct: load,
        // Spindle temp tracks cumulative load, which is why bearing wear shows up as
        // vibration *and* temp together — the pair is what makes the AI's story credible.
        spindle_temp_c: Math.round((gen.spindle_temp_c.next(rand, tsMs) + load * 0.12) * 10) / 10,
        vibration_mm_s: running ? gen.vibration_mm_s.next(rand, tsMs) : Math.max(0, gen.vibration_mm_s.offset * 0.2),
        coolant_temp_c: gen.coolant_temp_c.next(rand, tsMs),
        coolant_flow_lpm: running ? gen.coolant_flow_lpm.next(rand, tsMs) : 0,
        axis_error_um: gen.axis_error_um.next(rand, tsMs),
        mode,
        cycle_count: gen.cycle_count.next(rand, tsMs, dtSeconds),
        spindle_hours: gen.spindle_hours.next(rand, tsMs, dtSeconds),
      };
    }
    case 'power-pm3000': {
      const current = gen.current_a.next(rand, tsMs);
      const v1 = gen.voltage_l1_v.next(rand, tsMs);
      const v2 = gen.voltage_l2_v.next(rand, tsMs);
      const v3 = gen.voltage_l3_v.next(rand, tsMs);
      const pf = gen.power_factor.next(rand, tsMs);
      const vAvg = (v1 + v2 + v3) / 3;
      // Real 3-phase power, so a voltage sag genuinely shows up as a power dip.
      const powerKw = Math.round(((Math.sqrt(3) * vAvg * current * pf) / 1000) * 100) / 100;
      gen.energy_kwh.rateScale = powerKw / 60;
      return {
        voltage_l1_v: v1,
        voltage_l2_v: v2,
        voltage_l3_v: v3,
        current_a: current,
        power_kw: powerKw,
        power_factor: pf,
        frequency_hz: gen.frequency_hz.next(rand, tsMs),
        thd_pct: gen.thd_pct.next(rand, tsMs),
        energy_kwh: gen.energy_kwh.next(rand, tsMs, dtSeconds),
      };
    }
    case 'gw-edge200':
      return {
        cpu_pct: gen.cpu_pct.next(rand, tsMs),
        mem_pct: gen.mem_pct.next(rand, tsMs),
        disk_pct: gen.disk_pct.next(rand, tsMs),
        temp_c: gen.temp_c.next(rand, tsMs),
        uplink_mbps: gen.uplink_mbps.next(rand, tsMs),
        packet_loss_pct: gen.packet_loss_pct.next(rand, tsMs),
        downstream_devices: gen.downstreamCount ?? 0,
        uptime_hours: gen.uptime_hours.next(rand, tsMs, dtSeconds),
      };
    default:
      throw new Error(`Unknown device type code: ${typeCode}`);
  }
}

/** Human-ish device names, so the fleet grid doesn't read as `device-0001`. */
export const NAME_PARTS = {
  robot: ['Hauler', 'Runner', 'Mover', 'Carrier', 'Shuttle', 'Porter'],
  refrigeration: ['Freezer', 'ColdCell', 'Chiller', 'DeepFreeze'],
  hvac: ['RTU', 'AirHandler', 'Rooftop'],
  machine_tool: ['Mill', 'Machining Cell', 'VMC'],
  power: ['Main Feed', 'Panel', 'Submeter'],
  gateway: ['Gateway', 'Edge Node', 'Concentrator'],
};

export function deviceNameFor(category, index, rand) {
  const parts = NAME_PARTS[category] || ['Device'];
  return `${pick(rand, parts)} ${String(index).padStart(2, '0')}`;
}
