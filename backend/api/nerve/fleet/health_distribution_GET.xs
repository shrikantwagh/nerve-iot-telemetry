// Feeds the Overview histogram. Answers "is my fleet bimodal or uniformly mediocre?", which a single average hides completely - a fleet averaging 80 with everything at 80 is healthy, and one averaging 80 because half is at 100 and half at 60 is not.
query "fleet/health-distribution" verb=GET {
  api_group = "Nerve"
  auth = "user"

  input {
  }

  stack {
    // Types are a small reference table and the category breakdown needs their category, so one read builds the lookup for the whole scan below.
    db.query device_type {
      output = ["id", "code", "name", "category"]
      return = {type: "list"}
    } as $device_types

    // device_type_id -> category, keyed as text because object paths are text.
    var $type_categories {
      value = {}
    }

    foreach ($device_types) {
      each as $device_type {
        var $type_key {
          value = $device_type.id|to_text
        }

        var.update $type_categories {
          value = $type_categories|set:$type_key:$device_type.category
        }
      }
    }

    // Ten fixed buckets, pre-seeded so an empty bucket renders as a zero-height bar rather than collapsing the x-axis. Keys are the bucket index as text.
    var $bucket_counts {
      value = {"0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 0, "9": 0}
    }

    // Pre-seeded with every device_type.category enum value so the breakdown's shape does not change as categories come and go from the fleet.
    var $category_counts {
      value = {robot: 0, refrigeration: 0, hvac: 0, machine_tool: 0, power: 0, gateway: 0, other: 0}
    }

    // Numerators for each category's average.
    var $category_health {
      value = {robot: 0, refrigeration: 0, hvac: 0, machine_tool: 0, power: 0, gateway: 0, other: 0}
    }

    // Per-category "needs attention" count, same 60 threshold the Overview tile uses.
    var $category_below_60 {
      value = {robot: 0, refrigeration: 0, hvac: 0, machine_tool: 0, power: 0, gateway: 0, other: 0}
    }

    // Histogramming has no SQL equivalent available here (db.direct_query is plan-gated), so the table is scanned once, projected to three columns, and every bar is folded out of that pass.
    db.query device {
      output = ["id", "health_score", "device_type_id"]
      return = {type: "list"}
    } as $devices

    foreach ($devices) {
      each as $device {
        // A null score lands in the 0-9 bucket deliberately: it is an unknown, and burying unknowns in the healthy end of the chart is how a fleet looks fine while it is not.
        var $score {
          value = $device.health_score|first_notnull:0
        }

        // floor returns a decimal, so it is narrowed to an int before being used as an object key - "9" and "9.0" are different paths.
        var $bucket_index {
          value = (($score / 10)|floor)|to_int
        }

        // 100 would otherwise floor to bucket 10, which does not exist. The top bucket is deliberately 90-100 (eleven values wide) rather than adding an eleventh bar holding only perfect scores.
        conditional {
          if ($bucket_index > 9) {
            var.update $bucket_index {
              value = 9
            }
          }
          elseif ($bucket_index < 0) {
            var.update $bucket_index {
              value = 0
            }
          }
        }

        var $bucket_key {
          value = $bucket_index|to_text
        }

        var $next_bucket {
          value = ($bucket_counts|get:$bucket_key|first_notnull:0) + 1
        }

        var.update $bucket_counts {
          value = $bucket_counts|set:$bucket_key:$next_bucket
        }

        // A device whose type was deleted still exists and still has a score, so it is attributed to "other" rather than dropped from the breakdown.
        var $type_key {
          value = $device.device_type_id|to_text
        }

        var $category {
          value = $type_categories|get:$type_key|first_notempty:"other"
        }

        var $next_cat_count {
          value = ($category_counts|get:$category|first_notnull:0) + 1
        }

        var.update $category_counts {
          value = $category_counts|set:$category:$next_cat_count
        }

        var $next_cat_health {
          value = ($category_health|get:$category|first_notnull:0) + $score
        }

        var.update $category_health {
          value = $category_health|set:$category:$next_cat_health
        }

        conditional {
          if ($score < 60) {
            var $next_cat_below {
              value = ($category_below_60|get:$category|first_notnull:0) + 1
            }

            var.update $category_below_60 {
              value = $category_below_60|set:$category:$next_cat_below
            }
          }
        }
      }
    }

    // Written as an explicit literal rather than |range so the bar order is fixed in the source and cannot drift with a filter's semantics.
    var $bucket_indexes {
      value = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    }

    // Emitted as an ordered array, not the map, because a chart needs a guaranteed left-to-right order and object key order is not a contract.
    var $buckets {
      value = []
    }

    foreach ($bucket_indexes) {
      each as $bucket_i {
        var $key {
          value = $bucket_i|to_text
        }

        var $lower {
          value = $bucket_i * 10
        }

        // The top bucket is inclusive of 100; every other bucket ends nine above its floor.
        var $upper {
          value = $lower + 9
        }

        conditional {
          if ($bucket_i == 9) {
            var.update $upper {
              value = 100
            }
          }
        }

        var $count {
          value = $bucket_counts|get:$key|first_notnull:0
        }

        // Label is built server-side so the chart's axis text and the bucket maths can never disagree.
        var $label {
          value = ($lower|to_text) ~ "-" ~ ($upper|to_text)
        }

        array.push $buckets {
          value = {
            index: $bucket_i
            label: $label
            min  : $lower
            max  : $upper
            count: $count
          }
        }
      }
    }

    // Same reasoning as the bucket order: a fixed category order keeps the legend stable between requests.
    var $category_order {
      value = ["robot", "refrigeration", "hvac", "machine_tool", "power", "gateway", "other"]
    }

    var $by_category {
      value = []
    }

    foreach ($category_order) {
      each as $cat {
        var $cat_count {
          value = $category_counts|get:$cat|first_notnull:0
        }

        var $cat_health {
          value = $category_health|get:$cat|first_notnull:0
        }

        var $cat_below {
          value = $category_below_60|get:$cat|first_notnull:0
        }

        var $cat_avg {
          value = 0
        }

        conditional {
          if ($cat_count > 0) {
            var.update $cat_avg {
              value = ($cat_health / $cat_count)|round:1
            }
          }
        }

        array.push $by_category {
          value = {
            category        : $cat
            device_count    : $cat_count
            avg_health_score: $cat_avg
            below_health_60 : $cat_below
          }
        }
      }
    }
  }

  response = {
    generated_at : "now"
    total_devices: $devices|count
    bucket_size  : 10
    buckets      : $buckets
    by_category  : $by_category
  }
  tags = ["nerve"]
  guid = "XIS1xdFwUbCcKPaFgYOArtnbNB4"
}
