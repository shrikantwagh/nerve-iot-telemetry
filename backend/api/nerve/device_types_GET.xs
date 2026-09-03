// Device types with how many devices use each. The full metric_schema is returned, because this list feeds both the Admin screen and the chart/rule builders that need to know which metrics a type even has.
query "device-types" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
  }

  stack {
    // Alphabetical by name; this list is a picker before it is a report.
    db.query device_type {
      sort = {device_type.name: "asc"}
      return = {type: "list"}
    } as $device_types

    // One projected scan of the device table beats a count query per type: types are numerous enough that N counts would be N round trips, and the same pass also yields the average health that makes "which type is failing" answerable.
    db.query device {
      output = ["id", "device_type_id", "health_score"]
      return = {type: "list"}
    } as $devices

    var $type_counts {
      value = {}
    }

    var $type_health {
      value = {}
    }

    foreach ($devices) {
      each as $device {
        var $tkey {
          value = $device.device_type_id|to_text
        }

        var $next_count {
          value = ($type_counts|get:$tkey:0) + 1
        }

        var.update $type_counts {
          value = $type_counts|set:$tkey:$next_count
        }

        var $health {
          value = $device.health_score|first_notnull:0
        }

        var $next_health {
          value = ($type_health|get:$tkey:0) + $health
        }

        var.update $type_health {
          value = $type_health|set:$tkey:$next_health
        }
      }
    }

    var $rows {
      value = []
    }

    foreach ($device_types) {
      each as $device_type {
        var $tid {
          value = $device_type.id|to_text
        }

        var $count {
          value = $type_counts|get:$tid:0
        }

        var $health_sum {
          value = $type_health|get:$tid:0
        }

        var $avg_health {
          value = 0
        }

        conditional {
          if ($count > 0) {
            var.update $avg_health {
              value = ($health_sum / $count)|round:1
            }
          }
        }

        // metric_count is surfaced separately so the Admin list can show "8 metrics" without the client counting the schema itself.
        var $metric_count {
          value = ($device_type.metric_schema|first_notnull:[])|count
        }

        array.push $rows {
          value = {
            id                   : $device_type.id
            code                 : $device_type.code
            name                 : $device_type.name
            category             : $device_type.category
            manufacturer         : $device_type.manufacturer
            model                : $device_type.model
            icon                 : $device_type.icon
            offline_after_seconds: $device_type.offline_after_seconds
            metric_schema        : $device_type.metric_schema
            metric_count         : $metric_count
            device_count         : $count
            avg_health_score     : $avg_health
            created_at           : $device_type.created_at
          }
        }
      }
    }
  }

  response = {
    total_types  : $device_types|count
    total_devices: $devices|count
    device_types : $rows
  }
  tags = ["nerve"]
  guid = "KoVzAYZgGtdzfynE7wYLta7RN8s"
}
