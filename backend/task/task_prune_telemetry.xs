// Retention is what makes flat-rate honest: telemetry is rows in Postgres, so the only thing keeping the bill flat is dropping the raw rows once the rollups have absorbed them. 14 days raw, forever in 5-minute buckets.
task task_prune_telemetry {
  description = "Daily at 03:00 UTC: deletes raw telemetry older than 14 days (rollups are kept), plus ai_insight and nl_query_log rows older than 90 days, in bounded chunks so one run can never lock the table for an unpredictable length of time."
  active = true

  stack {
    // Rows per chunk. Small enough that each bulk delete is a short transaction, large enough that ten chunks clear a day's ingest for a demo-sized fleet.
    var $chunk_size {
      value = 2000
    }

    // Chunks per table per run. This is the whole bound: worst case 20,000 rows per table per day, and anything beyond that is reported rather than silently attempted.
    var $rounds {
      value = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    }

    // Raw telemetry retention. 14 days is the window in which anyone actually looks at per-reading detail; past that the 5-minute rollups are the record.
    var $telemetry_cutoff {
      value = ("now"|to_ms) - 1209600000
    }

    // AI and NL-query history retention. 90 days, because these rows are the product's own audit trail of what the model was asked and what it answered, and they are tiny compared to telemetry.
    var $insight_cutoff {
      value = ("now"|to_ms) - 7776000000
    }

    // Rows actually removed, accumulated from the bulk-delete counts.
    var $telemetry_deleted {
      value = 0
    }

    // Set when a table is fully drained, so the remaining rounds cost nothing. XanoScript has no loop break, so the flag is the break.
    var $telemetry_done {
      value = false
    }

    // Chunks that ran, which together with $telemetry_done says whether the run hit its own ceiling.
    var $telemetry_rounds {
      value = 0
    }

    foreach ($rounds) {
      each as $round {
        conditional {
          if ($telemetry_done == false) {
            // Read the oldest chunk's timestamps first, then delete by an upper bound on ts. This is what makes the chunk *bounded*: a bare `where ts < cutoff` bulk delete is one unbounded statement, and there is no LIMIT to attach to it.
            db.query telemetry {
              where = $db.telemetry.ts < $telemetry_cutoff
              sort = {telemetry.ts: "asc"}
              return = {type: "list", paging: {page: 1, per_page: $chunk_size}}
              output = ["items.ts"]
            } as $batch

            var $rows {
              value = $batch.items|safe_array
            }

            conditional {
              if (($rows|count) == 0) {
                var.update $telemetry_done {
                  value = true
                }
              }
              else {
                math.add $telemetry_rounds {
                  value = 1
                }

                // The ts of the last row in the ascending chunk. Deleting up to and including it removes this chunk (plus any rows sharing that exact timestamp, which is why the count below comes from the delete and not from the read).
                var $chunk_end {
                  value = ($rows|last)|get:"ts"
                }

                // Both predicates: the cutoff is the retention rule, the chunk end is the bound. Dropping either would make this either unbounded or wrong.
                db.bulk.delete telemetry {
                  where = $db.telemetry.ts < $telemetry_cutoff && $db.telemetry.ts <= $chunk_end
                } as $deleted

                math.add $telemetry_deleted {
                  value = $deleted|to_int
                }

                // A short chunk means the table is drained, so stop early instead of issuing nine more empty queries.
                conditional {
                  if (($rows|count) < $chunk_size) {
                    var.update $telemetry_done {
                      value = true
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Same chunking for ai_insight, keyed on created_at.
    var $insights_deleted {
      value = 0
    }

    var $insights_done {
      value = false
    }

    foreach ($rounds) {
      each as $round {
        conditional {
          if ($insights_done == false) {
            db.query ai_insight {
              where = $db.ai_insight.created_at < $insight_cutoff
              sort = {ai_insight.created_at: "asc"}
              return = {type: "list", paging: {page: 1, per_page: $chunk_size}}
              output = ["items.created_at"]
            } as $insight_batch

            var $insight_rows {
              value = $insight_batch.items|safe_array
            }

            conditional {
              if (($insight_rows|count) == 0) {
                var.update $insights_done {
                  value = true
                }
              }
              else {
                var $insight_chunk_end {
                  value = ($insight_rows|last)|get:"created_at"
                }

                db.bulk.delete ai_insight {
                  where = $db.ai_insight.created_at < $insight_cutoff && $db.ai_insight.created_at <= $insight_chunk_end
                } as $insight_deleted_count

                math.add $insights_deleted {
                  value = $insight_deleted_count|to_int
                }

                conditional {
                  if (($insight_rows|count) < $chunk_size) {
                    var.update $insights_done {
                      value = true
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // And for nl_query_log, which is both the "recent questions" UI and the evidence that the NL-to-query compiler works - so it gets the same 90 days, not 14.
    var $queries_deleted {
      value = 0
    }

    var $queries_done {
      value = false
    }

    foreach ($rounds) {
      each as $round {
        conditional {
          if ($queries_done == false) {
            db.query nl_query_log {
              where = $db.nl_query_log.created_at < $insight_cutoff
              sort = {nl_query_log.created_at: "asc"}
              return = {type: "list", paging: {page: 1, per_page: $chunk_size}}
              output = ["items.created_at"]
            } as $query_batch

            var $query_rows {
              value = $query_batch.items|safe_array
            }

            conditional {
              if (($query_rows|count) == 0) {
                var.update $queries_done {
                  value = true
                }
              }
              else {
                var $query_chunk_end {
                  value = ($query_rows|last)|get:"created_at"
                }

                db.bulk.delete nl_query_log {
                  where = $db.nl_query_log.created_at < $insight_cutoff && $db.nl_query_log.created_at <= $query_chunk_end
                } as $query_deleted_count

                math.add $queries_deleted {
                  value = $query_deleted_count|to_int
                }

                conditional {
                  if (($query_rows|count) < $chunk_size) {
                    var.update $queries_done {
                      value = true
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // "Did this run finish the job" is the only question worth asking of a pruner, and these three flags answer it.
    var $hit_ceiling {
      value = ($telemetry_done == false) || ($insights_done == false) || ($queries_done == false)
    }

    debug.log {
      value = "task_prune_telemetry: deleted " ~ ($telemetry_deleted|to_text) ~ " telemetry row(s) in " ~ ($telemetry_rounds|to_text) ~ " chunk(s), " ~ ($insights_deleted|to_text) ~ " ai_insight row(s), " ~ ($queries_deleted|to_text) ~ " nl_query_log row(s). Hit per-run ceiling: " ~ ($hit_ceiling|to_text) ~ "."
    }

    // Deletion is the one operation nobody can reconstruct afterwards, so it is audited even on a no-op run: the absence of a row would be indistinguishable from the task never having fired.
    function.run "Nerve/fn_audit" {
      input = {
        action     : "retention.prune"
        entity_type: "telemetry"
        detail     : {
          telemetry_deleted    : $telemetry_deleted
          telemetry_chunks     : $telemetry_rounds
          telemetry_cutoff_ms  : $telemetry_cutoff
          telemetry_retention_days: 14
          insights_deleted     : $insights_deleted
          queries_deleted      : $queries_deleted
          insight_cutoff_ms    : $insight_cutoff
          insight_retention_days: 90
          chunk_size           : $chunk_size
          max_chunks_per_table : $rounds|count
          hit_run_ceiling      : $hit_ceiling
        }
        source     : "task"
      }
    } as $audit
  }

  schedule = [{starts_on: 2026-09-03 03:00:00+0000, freq: 86400}]
  tags = ["nerve"]
}
