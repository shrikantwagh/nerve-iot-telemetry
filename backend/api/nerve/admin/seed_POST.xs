// Bring a cold workspace to the state the demo assumes: the four sites, the six device classes with their metric schemas, and the starter rules that make the fault scenarios actually fire. Idempotent by construction - every write is keyed on a natural code, so running it twice changes nothing and running it after a partial failure finishes the job.
query "admin/seed" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
  }

  stack {
    // Role read fresh from the row, so a demotion takes effect immediately.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role", "demo_account"]
    } as $user

    // Valid token, deleted account.
    precondition ($user != null) {
      error_type = "unauthorized"
      error = "The account for this token no longer exists."
    }

    // Seeding rewrites the reference data the whole fleet keys off, so it is admin-only. Inline rather than via the quick-start enforce_role helper, which only knows admin/member.
    precondition ($user.role == "admin") {
      error_type = "accessdenied"
      error = "Admin role required."
    }

    // The shared demo identity must not be able to reshape the reference data other judges are looking at.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // The four demo sites, verbatim from simulator/catalog.js via backend/seed/catalog.json. The `code` is the join key the simulator self-registers against, so a typo here surfaces as "unknown site_code" at ingest time rather than here.
    var $sites {
      value = [
        {code: "OSA-01", name: "Osaka Distribution Center", timezone: "Asia/Tokyo", region: "APAC", address: "2-1 Nanko-kita, Suminoe-ku, Osaka", lat: 34.6937, lng: 135.5023},
        {code: "MUC-02", name: "Munich Assembly Plant", timezone: "Europe/Berlin", region: "EMEA", address: "Lilienthalallee 40, Munich", lat: 48.1351, lng: 11.582},
        {code: "CHI-03", name: "Chicago Fulfillment Hub", timezone: "America/Chicago", region: "AMER", address: "1400 S Rockwell St, Chicago, IL", lat: 41.8781, lng: -87.6298},
        {code: "SGP-04", name: "Singapore Cold Chain", timezone: "Asia/Singapore", region: "APAC", address: "21 Jurong Port Rd, Singapore", lat: 1.3521, lng: 103.8198}
      ]
    }

    // The six device classes. `metric_schema` is the declaration that makes onboarding one call instead of six console screens: it is what the frontend charts from and what rule authoring offers as metric keys, so it is seeded whole rather than summarised.
    var $device_types {
      value = [
        {
          code: "amr-ld250",
          name: "AMR — Autonomous Mobile Robot",
          category: "robot",
          manufacturer: "OMRON",
          model: "LD-250",
          icon: "robot",
          offline_after_seconds: 120,
          metric_schema: [
            {key: "battery_pct", label: "Battery", unit: "%", kind: "gauge", nominal_min: 25, nominal_max: 100, hard_min: 0, hard_max: 100, precision: 1},
            {key: "battery_temp_c", label: "Battery temp", unit: "°C", kind: "gauge", nominal_min: 10, nominal_max: 45, hard_min: -20, hard_max: 90, precision: 1},
            {key: "motor_temp_c", label: "Motor temp", unit: "°C", kind: "gauge", nominal_min: 20, nominal_max: 75, hard_min: -20, hard_max: 140, precision: 1},
            {key: "motor_current_a", label: "Motor current", unit: "A", kind: "gauge", nominal_min: 0, nominal_max: 24, hard_min: 0, hard_max: 60, precision: 2},
            {key: "wheel_slip_pct", label: "Wheel slip", unit: "%", kind: "gauge", nominal_min: 0, nominal_max: 4, hard_min: 0, hard_max: 100, precision: 2},
            {key: "localization_conf", label: "Localization confidence", unit: "", kind: "gauge", nominal_min: 0.85, nominal_max: 1, hard_min: 0, hard_max: 1, precision: 3},
            {key: "speed_mps", label: "Speed", unit: "m/s", kind: "gauge", nominal_min: 0, nominal_max: 1.8, hard_min: 0, hard_max: 2.5, precision: 2},
            {key: "payload_kg", label: "Payload", unit: "kg", kind: "gauge", nominal_min: 0, nominal_max: 250, hard_min: 0, hard_max: 300, precision: 1},
            {key: "wifi_rssi_dbm", label: "Wi-Fi RSSI", unit: "dBm", kind: "gauge", nominal_min: -70, nominal_max: -40, hard_min: -100, hard_max: 0, precision: 0},
            {key: "estop_engaged", label: "E-stop engaged", unit: "", kind: "state", precision: 0},
            {key: "odometry_km", label: "Odometry", unit: "km", kind: "counter", precision: 3},
            {key: "dock_cycles", label: "Dock cycles", unit: "", kind: "counter", precision: 0}
          ]
        },
        {
          code: "freezer-cc900",
          name: "Cold-Chain Freezer",
          category: "refrigeration",
          manufacturer: "Carrier",
          model: "CC-900",
          icon: "snowflake",
          offline_after_seconds: 300,
          metric_schema: [
            {key: "temp_c", label: "Cabinet temp", unit: "°C", kind: "gauge", nominal_min: -24, nominal_max: -16, hard_min: -40, hard_max: 30, precision: 2},
            {key: "setpoint_c", label: "Setpoint", unit: "°C", kind: "gauge", nominal_min: -24, nominal_max: -16, hard_min: -40, hard_max: 0, precision: 1},
            {key: "evap_temp_c", label: "Evaporator temp", unit: "°C", kind: "gauge", nominal_min: -34, nominal_max: -22, hard_min: -50, hard_max: 20, precision: 1},
            {key: "humidity_pct", label: "Humidity", unit: "%", kind: "gauge", nominal_min: 20, nominal_max: 60, hard_min: 0, hard_max: 100, precision: 1},
            {key: "power_w", label: "Power draw", unit: "W", kind: "gauge", nominal_min: 200, nominal_max: 1400, hard_min: 0, hard_max: 3000, precision: 0},
            {key: "door_open_seconds", label: "Door open (rolling)", unit: "s", kind: "gauge", nominal_min: 0, nominal_max: 60, hard_min: 0, hard_max: 3600, precision: 0},
            {key: "compressor_on", label: "Compressor", unit: "", kind: "state", precision: 0},
            {key: "door_open", label: "Door", unit: "", kind: "state", precision: 0},
            {key: "defrost_cycles", label: "Defrost cycles", unit: "", kind: "counter", precision: 0},
            {key: "energy_kwh", label: "Energy", unit: "kWh", kind: "counter", precision: 2}
          ]
        },
        {
          code: "hvac-rtu40",
          name: "Rooftop HVAC Unit",
          category: "hvac",
          manufacturer: "Daikin",
          model: "RTU-40",
          icon: "wind",
          offline_after_seconds: 300,
          metric_schema: [
            {key: "supply_temp_c", label: "Supply air", unit: "°C", kind: "gauge", nominal_min: 11, nominal_max: 16, hard_min: -10, hard_max: 60, precision: 1},
            {key: "return_temp_c", label: "Return air", unit: "°C", kind: "gauge", nominal_min: 20, nominal_max: 26, hard_min: -10, hard_max: 60, precision: 1},
            {key: "fan_rpm", label: "Fan speed", unit: "rpm", kind: "gauge", nominal_min: 600, nominal_max: 1500, hard_min: 0, hard_max: 2000, precision: 0},
            {key: "suction_pressure_kpa", label: "Suction pressure", unit: "kPa", kind: "gauge", nominal_min: 380, nominal_max: 520, hard_min: 0, hard_max: 1200, precision: 0},
            {key: "filter_dp_pa", label: "Filter Δp", unit: "Pa", kind: "gauge", nominal_min: 40, nominal_max: 220, hard_min: 0, hard_max: 600, precision: 0},
            {key: "power_w", label: "Power draw", unit: "W", kind: "gauge", nominal_min: 400, nominal_max: 7000, hard_min: 0, hard_max: 12000, precision: 0},
            {key: "compressor_on", label: "Compressor", unit: "", kind: "state", precision: 0},
            {key: "compressor_starts", label: "Compressor starts", unit: "", kind: "counter", precision: 0},
            {key: "runtime_hours", label: "Runtime", unit: "h", kind: "counter", precision: 2}
          ]
        },
        {
          code: "cnc-vmc850",
          name: "CNC Vertical Machining Center",
          category: "machine_tool",
          manufacturer: "Mazak",
          model: "VMC-850",
          icon: "cog",
          offline_after_seconds: 180,
          metric_schema: [
            {key: "spindle_rpm", label: "Spindle speed", unit: "rpm", kind: "gauge", nominal_min: 0, nominal_max: 12000, hard_min: 0, hard_max: 15000, precision: 0},
            {key: "spindle_load_pct", label: "Spindle load", unit: "%", kind: "gauge", nominal_min: 0, nominal_max: 85, hard_min: 0, hard_max: 150, precision: 1},
            {key: "spindle_temp_c", label: "Spindle temp", unit: "°C", kind: "gauge", nominal_min: 25, nominal_max: 62, hard_min: 0, hard_max: 120, precision: 1},
            {key: "vibration_mm_s", label: "Vibration (RMS)", unit: "mm/s", kind: "gauge", nominal_min: 0, nominal_max: 2.8, hard_min: 0, hard_max: 25, precision: 3},
            {key: "coolant_temp_c", label: "Coolant temp", unit: "°C", kind: "gauge", nominal_min: 16, nominal_max: 30, hard_min: 0, hard_max: 80, precision: 1},
            {key: "coolant_flow_lpm", label: "Coolant flow", unit: "L/min", kind: "gauge", nominal_min: 8, nominal_max: 20, hard_min: 0, hard_max: 40, precision: 2},
            {key: "axis_error_um", label: "Axis position error", unit: "µm", kind: "gauge", nominal_min: 0, nominal_max: 12, hard_min: 0, hard_max: 200, precision: 1},
            {key: "mode", label: "Mode", unit: "", kind: "state", precision: 0},
            {key: "cycle_count", label: "Cycles", unit: "", kind: "counter", precision: 0},
            {key: "spindle_hours", label: "Spindle hours", unit: "h", kind: "counter", precision: 2}
          ]
        },
        {
          code: "power-pm3000",
          name: "3-Phase Power Meter",
          category: "power",
          manufacturer: "Schneider",
          model: "PM-3000",
          icon: "bolt",
          offline_after_seconds: 180,
          metric_schema: [
            {key: "voltage_l1_v", label: "Voltage L1", unit: "V", kind: "gauge", nominal_min: 396, nominal_max: 424, hard_min: 0, hard_max: 600, precision: 1},
            {key: "voltage_l2_v", label: "Voltage L2", unit: "V", kind: "gauge", nominal_min: 396, nominal_max: 424, hard_min: 0, hard_max: 600, precision: 1},
            {key: "voltage_l3_v", label: "Voltage L3", unit: "V", kind: "gauge", nominal_min: 396, nominal_max: 424, hard_min: 0, hard_max: 600, precision: 1},
            {key: "current_a", label: "Current", unit: "A", kind: "gauge", nominal_min: 5, nominal_max: 180, hard_min: 0, hard_max: 400, precision: 2},
            {key: "power_kw", label: "Active power", unit: "kW", kind: "gauge", nominal_min: 2, nominal_max: 110, hard_min: 0, hard_max: 250, precision: 2},
            {key: "power_factor", label: "Power factor", unit: "", kind: "gauge", nominal_min: 0.9, nominal_max: 1, hard_min: 0, hard_max: 1, precision: 3},
            {key: "frequency_hz", label: "Frequency", unit: "Hz", kind: "gauge", nominal_min: 49.8, nominal_max: 50.2, hard_min: 45, hard_max: 65, precision: 2},
            {key: "thd_pct", label: "Voltage THD", unit: "%", kind: "gauge", nominal_min: 0, nominal_max: 5, hard_min: 0, hard_max: 40, precision: 2},
            {key: "energy_kwh", label: "Energy", unit: "kWh", kind: "counter", precision: 2}
          ]
        },
        {
          code: "gw-edge200",
          name: "Edge Gateway",
          category: "gateway",
          manufacturer: "Advantech",
          model: "EDGE-200",
          icon: "router",
          offline_after_seconds: 90,
          metric_schema: [
            {key: "cpu_pct", label: "CPU", unit: "%", kind: "gauge", nominal_min: 2, nominal_max: 70, hard_min: 0, hard_max: 100, precision: 1},
            {key: "mem_pct", label: "Memory", unit: "%", kind: "gauge", nominal_min: 10, nominal_max: 80, hard_min: 0, hard_max: 100, precision: 1},
            {key: "disk_pct", label: "Disk", unit: "%", kind: "gauge", nominal_min: 10, nominal_max: 85, hard_min: 0, hard_max: 100, precision: 1},
            {key: "temp_c", label: "Board temp", unit: "°C", kind: "gauge", nominal_min: 25, nominal_max: 70, hard_min: -20, hard_max: 105, precision: 1},
            {key: "uplink_mbps", label: "Uplink", unit: "Mbps", kind: "gauge", nominal_min: 1, nominal_max: 90, hard_min: 0, hard_max: 1000, precision: 2},
            {key: "packet_loss_pct", label: "Packet loss", unit: "%", kind: "gauge", nominal_min: 0, nominal_max: 1, hard_min: 0, hard_max: 100, precision: 3},
            {key: "downstream_devices", label: "Downstream devices", unit: "", kind: "gauge", nominal_min: 1, nominal_max: 64, hard_min: 0, hard_max: 256, precision: 0},
            {key: "uptime_hours", label: "Uptime", unit: "h", kind: "counter", precision: 2}
          ]
        }
      ]
    }

    // Starter rules, one per demo fault scenario, so a fresh workspace alerts on the first interesting reading instead of after an afternoon of rule authoring. `natural_language_source` carries the English sentence the rule came from - kept on the row so the rule stays self-documenting and the AI rule composer has worked examples to imitate.
    var $rules {
      value = [
        {name: "Freezer cabinet above -15C", description: "Cold-chain excursion. The product-safety rule the whole refrigeration fleet exists to satisfy.", device_type_code: "freezer-cc900", metric_key: "temp_c", condition: "gt", threshold: -15, threshold_high: null, window_seconds: 600, z_threshold: 3, severity: "critical", cooldown_seconds: 900, natural_language_source: "Page me if any cold-chain freezer sits above -15C for ten minutes."},
        {name: "Freezer door open too long", description: "The usual cause of a temperature excursion, caught before the temperature moves.", device_type_code: "freezer-cc900", metric_key: "door_open_seconds", condition: "gt", threshold: 180, threshold_high: null, window_seconds: 0, z_threshold: 3, severity: "warning", cooldown_seconds: 600, natural_language_source: "Warn me when a freezer door has been open for more than three minutes."},
        {name: "AMR battery critically low", description: "A robot that strands itself mid-aisle blocks the aisle. Fires well before it can.", device_type_code: "amr-ld250", metric_key: "battery_pct", condition: "lt", threshold: 15, threshold_high: null, window_seconds: 0, z_threshold: 3, severity: "critical", cooldown_seconds: 1800, natural_language_source: "Critical alert if any AMR drops below 15 percent battery."},
        {name: "AMR battery temperature high", description: "Cell temperature is the leading indicator of the capacity fade the predictive sweep reports on.", device_type_code: "amr-ld250", metric_key: "battery_temp_c", condition: "gt", threshold: 55, threshold_high: null, window_seconds: 0, z_threshold: 3, severity: "warning", cooldown_seconds: 900, natural_language_source: "Warn me when an AMR battery pack goes above 55C."},
        {name: "CNC spindle vibration anomaly", description: "Baseline-relative, not threshold-based: every machine has its own normal vibration signature, and a fleet-wide number would either miss the quiet machines or cry wolf on the loud ones.", device_type_code: "cnc-vmc850", metric_key: "vibration_mm_s", condition: "anomaly", threshold: null, threshold_high: null, window_seconds: 0, z_threshold: 3, severity: "warning", cooldown_seconds: 1800, natural_language_source: "Tell me when a CNC's vibration stops looking like its own normal."},
        {name: "CNC spindle temperature high", description: "Pairs with the vibration anomaly. Bearing wear shows up as both, and two metrics moving together is what makes the AI's root cause credible.", device_type_code: "cnc-vmc850", metric_key: "spindle_temp_c", condition: "gt", threshold: 70, threshold_high: null, window_seconds: 0, z_threshold: 3, severity: "warning", cooldown_seconds: 900, natural_language_source: "Warn me if a machining centre's spindle runs hotter than 70C."},
        {name: "Edge gateway offline", description: "Owned by task_offline_sweep, not the per-reading rule engine: absence of readings is structurally unobservable from inside a reading. Seeded here so the sweep has a rule row to attribute its alerts to.", device_type_code: "gw-edge200", metric_key: null, condition: "offline", threshold: null, threshold_high: null, window_seconds: 180, z_threshold: 3, severity: "critical", cooldown_seconds: 600, natural_language_source: "Page me the moment an edge gateway stops reporting - everything behind it goes dark with it."},
        {name: "Feeder voltage outside nominal band", description: "Two-sided on purpose. A sag and a swell have different causes and both damage equipment, so one rule watches both edges.", device_type_code: "power-pm3000", metric_key: "voltage_l1_v", condition: "outside_range", threshold: 396, threshold_high: 424, window_seconds: 0, z_threshold: 3, severity: "critical", cooldown_seconds: 600, natural_language_source: "Alert me if L1 voltage leaves the 396 to 424 volt band."},
        {name: "HVAC compressor state flatline", description: "The pattern no static threshold catches: a compressor stuck in one state reads perfectly nominal on every gauge while the space it serves drifts.", device_type_code: "hvac-rtu40", metric_key: "compressor_on", condition: "flatline", threshold: null, threshold_high: null, window_seconds: 1800, z_threshold: 3, severity: "info", cooldown_seconds: 3600, natural_language_source: "Let me know when a rooftop unit's compressor state has not changed in half an hour."}
      ]
    }

    // Counted separately from updates, because "created 0, updated 4" is the proof of idempotency the caller is looking for.
    var $sites_created {
      value = 0
    }

    // Existing rows are refreshed rather than skipped, so a corrected address or lat/lng in the catalog propagates on the next seed.
    var $sites_updated {
      value = 0
    }

    // Same split for device types.
    var $types_created {
      value = 0
    }

    // A metric_schema change in the catalog lands through this path.
    var $types_updated {
      value = 0
    }

    // Rules created on this run.
    var $rules_created {
      value = 0
    }

    // Rules already present, left exactly as they are.
    var $rules_existing {
      value = 0
    }

    // Rules whose device type could not be resolved - only reachable if someone deleted a seeded type by hand.
    var $rules_skipped {
      value = 0
    }

    // Sites first: device types do not depend on them, but devices depend on both, so seeding the tenancy anchor first keeps the order meaningful.
    foreach ($sites) {
      each as $site {
        // `code` is the natural key the simulator registers against, which is what makes this loop idempotent without an id.
        db.get site {
          field_name = "code"
          field_value = $site.code
          output = ["id"]
        } as $existing_site

        // Insert or refresh. db.add_or_edit would collapse these two branches but would also lose the created-versus-existing distinction this endpoint reports, and it is documented against `id` rather than an arbitrary natural key.
        conditional {
          if ($existing_site == null) {
            db.add site {
              data = {
                created_at: "now"
                code      : $site.code
                name      : $site.name
                timezone  : $site.timezone
                region    : $site.region
                address   : $site.address
                lat       : $site.lat
                lng       : $site.lng
              }
            } as $new_site

            var.update $sites_created {
              value = $sites_created + 1
            }
          }
          else {
            // Patch, not edit: `code` is deliberately not in the payload, so a refresh can never repoint the natural key that devices resolve through.
            db.patch site {
              field_name = "id"
              field_value = $existing_site.id
              data = {
                name    : $site.name
                timezone: $site.timezone
                region  : $site.region
                address : $site.address
                lat     : $site.lat
                lng     : $site.lng
              }
            } as $patched_site

            var.update $sites_updated {
              value = $sites_updated + 1
            }
          }
        }
      }
    }

    // Device types must exist before the rules loop, which resolves each rule's target by type code.
    foreach ($device_types) {
      each as $type {
        // Same natural-key lookup as the sites loop.
        db.get device_type {
          field_name = "code"
          field_value = $type.code
          output = ["id"]
        } as $existing_type

        // Insert or refresh, with the same created/updated accounting.
        conditional {
          if ($existing_type == null) {
            db.add device_type {
              data = {
                created_at           : "now"
                code                 : $type.code
                name                 : $type.name
                category             : $type.category
                manufacturer         : $type.manufacturer
                model                : $type.model
                icon                 : $type.icon
                offline_after_seconds: $type.offline_after_seconds
                metric_schema        : $type.metric_schema
              }
            } as $new_type

            var.update $types_created {
              value = $types_created + 1
            }
          }
          else {
            // metric_schema is replaced wholesale. It is a generated declaration, not operator-edited data, so merging would only preserve drift.
            db.patch device_type {
              field_name = "id"
              field_value = $existing_type.id
              data = {
                name                 : $type.name
                category             : $type.category
                manufacturer         : $type.manufacturer
                model                : $type.model
                icon                 : $type.icon
                offline_after_seconds: $type.offline_after_seconds
                metric_schema        : $type.metric_schema
              }
            } as $patched_type

            var.update $types_updated {
              value = $types_updated + 1
            }
          }
        }
      }
    }

    // Rules last, because each one has to resolve its device type to an id.
    foreach ($rules) {
      each as $rule {
        // alert_rule has no natural code column, so `name` is the idempotency key. That is also why the seeded names read as sentences rather than slugs - they are the identity.
        db.get alert_rule {
          field_name = "name"
          field_value = $rule.name
          output = ["id"]
        } as $existing_rule

        // Every seeded rule is scoped to a device class rather than a single device, which is what makes one row cover a growing fleet.
        db.get device_type {
          field_name = "code"
          field_value = $rule.device_type_code
          output = ["id"]
        } as $rule_type

        // Skip before existing before create: a missing type is a data problem worth reporting, and an existing rule is never overwritten because an operator may have retuned it deliberately.
        conditional {
          if ($rule_type == null) {
            var.update $rules_skipped {
              value = $rules_skipped + 1
            }
          }
          elseif ($existing_rule != null) {
            var.update $rules_existing {
              value = $rules_existing + 1
            }
          }
          else {
            db.add alert_rule {
              data = {
                created_at             : "now"
                name                   : $rule.name
                description            : $rule.description
                device_type_id         : $rule_type.id
                metric_key             : $rule.metric_key
                condition              : $rule.condition
                threshold              : $rule.threshold
                threshold_high         : $rule.threshold_high
                window_seconds         : $rule.window_seconds
                z_threshold            : $rule.z_threshold
                severity               : $rule.severity
                enabled                : true
                cooldown_seconds       : $rule.cooldown_seconds
                created_by             : $user.id
                natural_language_source: $rule.natural_language_source
                ai_generated           : false
                fire_count             : 0
              }
            } as $new_rule

            var.update $rules_created {
              value = $rules_created + 1
            }
          }
        }
      }
    }

    // Seeding rewrites shared reference data, so the counts are recorded against the admin who ran it - the one audit row that explains why the fleet's device types changed at 2am.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $user.id
        action     : "admin.seed"
        entity_type: "workspace"
        entity_id  : null
        detail     : {
          sites_created : $sites_created
          sites_updated : $sites_updated
          types_created : $types_created
          types_updated : $types_updated
          rules_created : $rules_created
          rules_existing: $rules_existing
          rules_skipped : $rules_skipped
        }
        source     : "ui"
      }
    } as $audit
  }

  response = {
    sites: {created: $sites_created, existing: $sites_updated}
    device_types: {created: $types_created, existing: $types_updated}
    alert_rules: {created: $rules_created, existing: $rules_existing, skipped: $rules_skipped}
    note: "Idempotent. Sites and device types are refreshed from the catalog on every run; existing alert rules are left untouched so retuned thresholds survive a re-seed."
  }
  tags = ["nerve"]
  guid = "cxjllsZ4lIa7UiuTHbKS6MNpIhM"
}
