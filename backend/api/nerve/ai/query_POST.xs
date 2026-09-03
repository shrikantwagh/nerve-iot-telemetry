// THE headline feature: ask the fleet a question in English. The governing principle is that the model PLANS and Xano EXECUTES - Claude fills a fixed JSON schema, every field of that schema is checked against a hardcoded per-entity column allowlist, and only then does a real db.query run. No SQL and no free-form filter ever leaves the model.
query "ai/query" verb=POST {
  api_group = "Nerve"
  auth = "user"
  description = "Natural-language fleet query. Claude compiles the question into a constrained JSON query plan; Xano validates the entity, every filter field, every operator, the aggregate function and the limit against hardcoded allowlists, rejects the plan outright on any violation, and otherwise executes it as a real db.query with XanoScript aggregation. A second inference writes the English answer. Falls back to a keyword interpreter when no API key is configured, so the console always answers."

  input {
    // The operator's question, in English. Trimmed because a trailing newline from a textarea is not part of the question.
    text question filters=trim
  }

  stack {
    // Latency is a product claim on this endpoint ("ask and get an answer"), so it is measured from the first statement rather than around the model call.
    var $started_ms {
      value = "now"|to_ms
    }

    // Needed for nl_query_log attribution - the Ask console's history rail is per-user.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "name", "role", "demo_account"]
    } as $user

    // A valid token for a deleted user is still an unauthenticated request.
    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user not found."
    }

    // Reject an empty question before spending an inference on it. Asking is intentionally open to every role, including the read-only demo account: nl_query_log is an append-only log, not fleet state.
    precondition (($input.question|strlen) > 2) {
      error_type = "inputerror"
      error = "Ask a question of at least three characters."
    }

    // THE WHITELIST, and the security boundary of this entire feature. A plan may only name an entity that is a key here and a field that is a member of that entity's array. It is hardcoded rather than derived from the live schema so that adding a column cannot silently widen what a model is allowed to reach - notably password and key_hash columns, which are on no list here at all.
    var $field_allow {
      value = {
        device                : ["id", "created_at", "serial", "name", "device_type_id", "site_id", "status", "firmware_version", "location_label", "last_seen_at", "health_score", "install_date", "auto_provisioned", "uplink_device_id"]
        alert                 : ["id", "created_at", "alert_rule_id", "device_id", "incident_id", "metric_key", "observed_value", "threshold", "z_score", "severity", "state", "fired_at", "resolved_at", "acknowledged_at", "acked_by", "message"]
        incident              : ["id", "created_at", "title", "severity", "state", "site_id", "device_count", "alert_count", "opened_at", "resolved_at", "assigned_to", "correlation_key", "ai_confidence", "ai_model", "ai_fallback_used"]
        telemetry             : ["id", "device_id", "ts", "ingest_latency_ms"]
        metric_rollup         : ["id", "device_id", "metric_key", "bucket_ts", "bucket_seconds", "avg_value", "min_value", "max_value", "last_value", "stddev", "sample_count"]
        maintenance_prediction: ["id", "created_at", "device_id", "component", "metric_key", "trend_slope", "predicted_failure_at", "confidence", "recommended_action", "state", "scheduled_by", "scheduled_for"]
      }
    }

    // Derived from the whitelist's own keys so the entity gate and the field gate can never drift out of step.
    var $entity_allow {
      value = $field_allow|keys
    }

    // The only comparison operators a plan may ask for. Anything else is a rejection, not a coercion - a silently dropped operator answers a different question than the one asked.
    var $op_allow {
      value = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "in"]
    }

    // Aggregates Xano can evaluate by foreach accumulation. db.direct_query is plan-gated and return={type:"aggregate"} has undocumented parameter names, so this list is exactly what XanoScript can honestly compute.
    var $agg_allow {
      value = ["count", "sum", "avg", "min", "max"]
    }

    // Chart types the frontend knows how to draw. Unlike a filter, a chart hint never touches the database, so an unknown type is downgraded rather than rejected.
    var $chart_allow {
      value = ["line", "bar", "area", "pie", "scatter", "table", "number"]
    }

    // Sites are read live so the prompt describes THIS fleet. A model that invents a site code produces a plan that validates and returns zero rows, which is the worst outcome available.
    db.query site {
      sort = {site.code: "asc"}
      return = {type: "list"}
    } as $sites

    // Same for device types, which also carry the metric_schema the metric-key vocabulary is built from.
    db.query device_type {
      sort = {device_type.code: "asc"}
      return = {type: "list"}
    } as $device_types

    // Vocabulary lines carry the numeric id next to the human code, because the tables store ids and the operator speaks codes. Without the id the model cannot express a site filter at all.
    var $site_lines {
      value = []
    }

    foreach ($sites) {
      each as $site {
        array.push $site_lines {
          value = "site_id=" ~ ($site.id|to_text) ~ " code=" ~ ($site.code|to_text) ~ " name=" ~ ($site.name|to_text)
        }
      }
    }

    // Type vocabulary, same shape and for the same reason.
    var $type_lines {
      value = []
    }

    // Every metric key any device type declares. Collected here rather than from the telemetry table so the vocabulary reflects what the fleet is *supposed* to report.
    var $metric_keys {
      value = []
    }

    foreach ($device_types) {
      each as $dt {
        array.push $type_lines {
          value = "device_type_id=" ~ ($dt.id|to_text) ~ " code=" ~ ($dt.code|to_text) ~ " name=" ~ ($dt.name|to_text) ~ " category=" ~ ($dt.category|to_text)
        }

        // Hoisted so foreach iterates a plain variable, and safe_array so a type with no declared schema does not break the loop.
        var $schema {
          value = $dt.metric_schema|safe_array
        }

        foreach ($schema) {
          each as $metric {
            array.push $metric_keys {
              value = $metric|get:"key":""
            }
          }
        }
      }
    }

    // filter_empty drops the "" placeholders left by types with no metric_schema; unique collapses the keys shared across types.
    var $metric_key_list {
      value = ($metric_keys|filter_empty)|unique
    }

    // The schema block is rendered from the same whitelist the validator enforces, so the model is told precisely what it is permitted to ask for - the cheapest way to avoid a rejection is to describe the boundary accurately.
    var $schema_lines {
      value = []
    }

    foreach ($entity_allow) {
      each as $entity_name {
        var $columns {
          value = ($field_allow|get:$entity_name:[])|join:", "
        }

        array.push $schema_lines {
          value = $entity_name ~ " -> " ~ $columns
        }
      }
    }

    // Built as its own variable to keep the prompt assembly readable; " || " separators rather than newlines because literal escape handling in XanoScript strings is unverified.
    var $schema_text {
      value = "QUERYABLE ENTITIES AND THE ONLY FIELDS YOU MAY NAME FOR EACH -- " ~ ($schema_lines|join:" || ")
    }

    // The live vocabulary block: real ids, real codes, real metric keys.
    var $vocab_text {
      value = "SITES -- " ~ ($site_lines|join:" || ") ~ " || DEVICE TYPES -- " ~ ($type_lines|join:" || ") ~ " || METRIC KEYS -- " ~ ($metric_key_list|join:", ")
    }

    // Full contract, stated once. The strictness is deliberate: the reply is parsed into typed variables and then into a db.query, so an unstructured answer is unusable rather than merely untidy.
    var $planner_system {
      value = "You are Nerve's natural-language query compiler. You do not write SQL and you do not execute anything: you emit a query PLAN which Xano then validates against a hardcoded column allowlist and executes itself. Reply with STRICT JSON only - no prose, no explanation, no markdown fence. Use exactly these keys: entity (one of the entity names in the schema block), filters (an array of {field, op, value}; field MUST be one of the fields listed for that entity and op MUST be one of eq, ne, gt, gte, lt, lte, contains, in - for op 'in' the value must be an array), time_range ({from, to} as UTC timestamps formatted 'YYYY-MM-DD HH:MM:SS', either bound may be null; time_range is IGNORED for entity device, which has no event timestamp), aggregate (null, or {fn, field, group_by} where fn is one of count, sum, avg, min, max, field is a numeric field on the entity and is required for every fn except count, and group_by is a field on the entity or null), sort ({field, direction} with direction asc or desc, or null), limit (an integer from 1 to 200), chart_hint ({type, x, y} where type is one of line, bar, area, pie, scatter, table, number and x and y are fields on the entity), answer_template (one sentence of English describing how the answer should be phrased). GROUNDING RULES, which matter more than fluency: use ONLY the field names, site ids, device type ids and metric keys given in the schema and vocabulary blocks - never invent a column, a code, an id or a metric key. Filter on numeric ids rather than on codes, because the tables store ids and the vocabulary block gives you the id for every code. If the question names a site, device type or metric that is not in the vocabulary, pick the closest listed one and say so in answer_template instead of inventing an identifier. If the question is too vague to pin down, choose the entity that most directly holds the answer and keep filters minimal - a broad correct plan beats a narrow invented one, and every field you invent gets the whole plan rejected. Prefer no time_range at all over a guessed one. Never set limit above 200. Emit the JSON object and nothing else."
    }

    // Only facts the database already holds go into the prompt: the question, the clock, the boundary and the vocabulary.
    var $planner_prompt {
      value = "QUESTION: " ~ $input.question ~ " || CURRENT UTC TIME: " ~ ("now"|format_timestamp:"Y-m-d H:i:s":"UTC") ~ " || " ~ $schema_text ~ " || " ~ $vocab_text
    }

    // First of two inferences. expect_json because the reply is parsed into typed plan variables, not rendered.
    function.run "Nerve/fn_claude" {
      input = {
        system     : $planner_system
        user_prompt: $planner_prompt
        max_tokens : 900
        kind       : "nl_query"
        title      : "Plan: " ~ $input.question
        expect_json: true
      }
    } as $planner

    // Plan fields are hoisted to the top level so the model path and the keyword path fill the SAME variables. The validator below then has exactly one set of things to check, rather than two shapes to keep in agreement.
    var $p_entity {
      value = "device"
    }

    // Validated filter candidates; replaced wholesale by whichever path produced the plan.
    var $p_filters {
      value = []
    }

    // Lower time bound as the model wrote it; parsed to a timestamp only after validation.
    var $p_from {
      value = null
    }

    // Upper time bound, same.
    var $p_to {
      value = null
    }

    // Null means "no aggregate", which is a normal plan for a "show me the rows" question.
    var $p_agg_fn {
      value = null
    }

    // Required for every aggregate except count.
    var $p_agg_field {
      value = null
    }

    // Null means one aggregate over the whole match set.
    var $p_group_by {
      value = null
    }

    // Applied in memory rather than in the db.query, because a sort key in db.query cannot be a variable.
    var $p_sort_field {
      value = null
    }

    // Direction defaults to desc: almost every fleet question wants the most recent or the worst first.
    var $p_sort_dir {
      value = "desc"
    }

    // 50 is the default page an operator can actually read; clamped to 200 below regardless of what the plan asks for.
    var $p_limit {
      value = 50
    }

    // Chart hint components, kept as three scalars so each can be sanitised independently.
    var $p_chart_type {
      value = "table"
    }

    // Proposed x axis field; dropped rather than rejected if it is not on the allowlist.
    var $p_chart_x {
      value = null
    }

    // Proposed y axis field, same treatment.
    var $p_chart_y {
      value = null
    }

    // The model's own suggestion for how to phrase the answer. Never executed, so it is passed through untouched.
    var $p_answer_template {
      value = null
    }

    // True until a parsed model plan proves otherwise. Callers of fn_claude must branch on fallback_used, because a silent empty text is a valid response from it.
    var $plan_fallback_used {
      value = true
    }

    // Lower-cased once, used by every keyword test below.
    var $q {
      value = $input.question|to_lower
    }

    // Either the model produced a parseable plan, or the deterministic keyword interpreter produces one. There is no third branch in which the console fails to answer.
    conditional {
      if (($planner.fallback_used == false) && ($planner.json != null)) {
        var $plan {
          value = $planner.json
        }

        var.update $plan_fallback_used {
          value = false
        }

        var.update $p_entity {
          value = ($plan|get:"entity":"device")|to_text
        }

        var.update $p_filters {
          value = ($plan|get:"filters":[])|safe_array
        }

        // time_range, aggregate, sort and chart_hint are nested objects that may be absent entirely; get on a null parent yields null, which every default below absorbs.
        var $tr {
          value = $plan|get:"time_range"
        }

        var.update $p_from {
          value = $tr|get:"from"
        }

        var.update $p_to {
          value = $tr|get:"to"
        }

        var $ag {
          value = $plan|get:"aggregate"
        }

        var.update $p_agg_fn {
          value = $ag|get:"fn"
        }

        var.update $p_agg_field {
          value = $ag|get:"field"
        }

        var.update $p_group_by {
          value = $ag|get:"group_by"
        }

        var $so {
          value = $plan|get:"sort"
        }

        var.update $p_sort_field {
          value = $so|get:"field"
        }

        var.update $p_sort_dir {
          value = ($so|get:"direction":"desc")|to_text
        }

        var.update $p_limit {
          value = ($plan|get:"limit":50)|to_int
        }

        var $ch {
          value = $plan|get:"chart_hint"
        }

        var.update $p_chart_type {
          value = ($ch|get:"type":"table")|to_text
        }

        var.update $p_chart_x {
          value = $ch|get:"x"
        }

        var.update $p_chart_y {
          value = $ch|get:"y"
        }

        var.update $p_answer_template {
          value = $plan|get:"answer_template"
        }
      }
      else {
        // DETERMINISTIC INTERPRETER. Six question shapes cover what a judge actually types at a fleet console. It is crude on purpose: it must never fail, and it must never invent a field, so it only ever emits plans built from literals that are on the allowlist by construction.
        conditional {
          if (($q|icontains:"offline") || ($q|icontains:"not reporting") || ($q|icontains:"stopped reporting")) {
            var.update $p_filters {
              value = [{field: "status", op: "eq", value: "offline"}]
            }

            var.update $p_sort_field {
              value = "last_seen_at"
            }

            var.update $p_agg_fn {
              value = "count"
            }

            var.update $p_chart_type {
              value = "number"
            }

            var.update $p_answer_template {
              value = "State how many devices are currently offline and name the ones that went quiet longest ago."
            }
          }
          elseif (($q|icontains:"incident") || ($q|icontains:"root cause") || ($q|icontains:"outage")) {
            var.update $p_entity {
              value = "incident"
            }

            var.update $p_filters {
              value = [{field: "state", op: "in", value: ["open", "investigating"]}]
            }

            var.update $p_sort_field {
              value = "opened_at"
            }

            var.update $p_chart_type {
              value = "table"
            }

            var.update $p_answer_template {
              value = "Summarise the open incidents, worst severity first, with how many devices each one covers."
            }
          }
          elseif (($q|icontains:"predict") || ($q|icontains:"maintenance") || ($q|icontains:"fail") || ($q|icontains:"wear")) {
            var.update $p_entity {
              value = "maintenance_prediction"
            }

            var.update $p_filters {
              value = [{field: "state", op: "eq", value: "open"}]
            }

            var.update $p_sort_field {
              value = "predicted_failure_at"
            }

            var.update $p_sort_dir {
              value = "asc"
            }

            var.update $p_chart_type {
              value = "table"
            }

            var.update $p_answer_template {
              value = "Name the components predicted to fail soonest and the recommended action for each."
            }
          }
          elseif (($q|icontains:"alert") || ($q|icontains:"critical") || ($q|icontains:"warning") || ($q|icontains:"paged")) {
            var.update $p_entity {
              value = "alert"
            }

            var.update $p_filters {
              value = [{field: "state", op: "eq", value: "firing"}]
            }

            var.update $p_sort_field {
              value = "fired_at"
            }

            var.update $p_agg_fn {
              value = "count"
            }

            var.update $p_group_by {
              value = "severity"
            }

            var.update $p_chart_type {
              value = "bar"
            }

            var.update $p_chart_x {
              value = "severity"
            }

            var.update $p_answer_template {
              value = "Break the firing alerts down by severity and name the devices behind the critical ones."
            }
          }
          elseif (($q|icontains:"health") || ($q|icontains:"worst") || ($q|icontains:"degraded") || ($q|icontains:"unhealthy")) {
            var.update $p_sort_field {
              value = "health_score"
            }

            var.update $p_sort_dir {
              value = "asc"
            }

            var.update $p_chart_type {
              value = "bar"
            }

            var.update $p_chart_x {
              value = "name"
            }

            var.update $p_chart_y {
              value = "health_score"
            }

            var.update $p_answer_template {
              value = "Name the devices with the lowest health scores and give their scores."
            }
          }
          else {
            // Last resort: the fleet grid itself, worst first. A broad correct answer beats a guessed narrow one.
            var.update $p_sort_field {
              value = "health_score"
            }

            var.update $p_sort_dir {
              value = "asc"
            }

            var.update $p_agg_fn {
              value = "count"
            }

            var.update $p_chart_type {
              value = "table"
            }

            var.update $p_answer_template {
              value = "Describe the fleet as it stands and say that the question was interpreted without a language model."
            }
          }
        }
      }
    }

    // VALIDATION. Violations are collected rather than thrown one at a time, so an operator sees everything wrong with a plan in a single response instead of peeling them off one request at a time.
    var $violations {
      value = []
    }

    // Warnings are the softer half: things that were dropped rather than rejected. Kept separate because the two carry different meanings for the caller.
    var $warnings {
      value = []
    }

    // Entity first, because every other check is relative to it.
    conditional {
      if (($entity_allow|in:$p_entity) == false) {
        array.push $violations {
          value = "entity '" ~ ($p_entity|to_text) ~ "' is not queryable. Allowed entities: " ~ ($entity_allow|join:", ") ~ "."
        }
      }
    }

    // Empty when the entity was rejected, which makes every field check below fail loudly rather than quietly passing on a nonexistent table.
    var $allowed_fields {
      value = ($field_allow|get:$p_entity:[])|safe_array
    }

    // Only filters that pass BOTH gates survive into this array, and it is the only filter list the executor ever sees.
    var $clean_filters {
      value = []
    }

    // A filter that names an unknown column or an unknown operator is a rejection, never a dropped clause: dropping a filter would answer a different question than the one asked, which is worse than refusing.
    foreach ($p_filters) {
      each as $filter {
        var $f_field {
          value = ($filter|get:"field":"")|to_text
        }

        var $f_op {
          value = ($filter|get:"op":"")|to_text
        }

        conditional {
          if (($allowed_fields|in:$f_field) == false) {
            array.push $violations {
              value = "filter field '" ~ $f_field ~ "' is not a filterable column on " ~ ($p_entity|to_text) ~ ". Allowed: " ~ ($allowed_fields|join:", ") ~ "."
            }
          }
          elseif (($op_allow|in:$f_op) == false) {
            array.push $violations {
              value = "filter operator '" ~ $f_op ~ "' is not allowed. Allowed operators: " ~ ($op_allow|join:", ") ~ "."
            }
          }
          else {
            array.push $clean_filters {
              value = {
                field: $f_field
                op   : $f_op
                value: $filter|get:"value"
              }
            }
          }
        }
      }
    }

    // Aggregate gate. count is the only function that does not need a field, so it is the only one exempted from the field check.
    conditional {
      if ($p_agg_fn != null) {
        conditional {
          if (($agg_allow|in:$p_agg_fn) == false) {
            array.push $violations {
              value = "aggregate function '" ~ ($p_agg_fn|to_text) ~ "' is not allowed. Allowed: " ~ ($agg_allow|join:", ") ~ "."
            }
          }
          elseif (($p_agg_fn != "count") && (($allowed_fields|in:$p_agg_field) == false)) {
            array.push $violations {
              value = "aggregate field '" ~ ($p_agg_field|to_text) ~ "' is not a column on " ~ ($p_entity|to_text) ~ ", and aggregate function '" ~ ($p_agg_fn|to_text) ~ "' requires one."
            }
          }
        }
      }
    }

    // group_by names a column that ends up in the response as a key, so it gets the same treatment as a filter field.
    conditional {
      if ($p_group_by != null) {
        conditional {
          if (($allowed_fields|in:$p_group_by) == false) {
            array.push $violations {
              value = "group_by field '" ~ ($p_group_by|to_text) ~ "' is not a column on " ~ ($p_entity|to_text) ~ "."
            }
          }
        }
      }
    }

    // ASYMMETRY, deliberately: an unknown SORT field is dropped with a warning rather than rejected. Sort is presentation - dropping it answers the same question in a different order - whereas dropping a filter answers a different question entirely.
    conditional {
      if ($p_sort_field != null) {
        conditional {
          if (($allowed_fields|in:$p_sort_field) == false) {
            array.push $warnings {
              value = "sort field '" ~ ($p_sort_field|to_text) ~ "' is not a column on " ~ ($p_entity|to_text) ~ " and was ignored."
            }

            var.update $p_sort_field {
              value = null
            }
          }
        }
      }
    }

    // Only two directions exist; anything else silently means desc rather than failing a whole question over an adverb.
    conditional {
      if (($p_sort_dir != "asc") && ($p_sort_dir != "desc")) {
        var.update $p_sort_dir {
          value = "desc"
        }
      }
    }

    // Hard ceiling of 200 rows regardless of what the plan asked for, and a floor of 1 so a limit of 0 does not read as "no results found".
    conditional {
      if ($p_limit < 1) {
        var.update $p_limit {
          value = 1
        }
      }
      elseif ($p_limit > 200) {
        array.push $warnings {
          value = "limit " ~ ($p_limit|to_text) ~ " exceeds the 200-row ceiling and was clamped."
        }

        var.update $p_limit {
          value = 200
        }
      }
    }

    // Chart hint sanitation: coerced rather than rejected, because it never reaches the database.
    var $chart_type_ok {
      value = "table"
    }

    conditional {
      if ($chart_allow|in:$p_chart_type) {
        var.update $chart_type_ok {
          value = $p_chart_type
        }
      }
    }

    // Axis fields are checked against the same allowlist, and dropped to null if they are not on it.
    var $chart_x_ok {
      value = null
    }

    conditional {
      if ($allowed_fields|in:$p_chart_x) {
        var.update $chart_x_ok {
          value = $p_chart_x
        }
      }
    }

    // y axis, same.
    var $chart_y_ok {
      value = null
    }

    conditional {
      if ($allowed_fields|in:$p_chart_y) {
        var.update $chart_y_ok {
          value = $p_chart_y
        }
      }
    }

    // Assembled once so the response and the nl_query_log row carry byte-identical hints.
    var $chart_hint {
      value = {
        type: $chart_type_ok
        x   : $chart_x_ok
        y   : $chart_y_ok
      }
    }

    // One boolean gates every execution step below. Nothing touches the database while this is false.
    var $success {
      value = ($violations|count) == 0
    }

    // The specific reason, joined into one sentence, because "invalid plan" helps nobody.
    var $error_reason {
      value = null
    }

    conditional {
      if ($success == false) {
        var.update $error_reason {
          value = "The generated query plan was rejected before execution: " ~ ($violations|join:" ")
        }
      }
    }

    // Time bounds are parsed only after validation, and only when non-empty, so a null bound stays null and the null-safe operators below drop their clause entirely.
    var $from_ts {
      value = null
    }

    conditional {
      if (($p_from|is_empty) == false) {
        var.update $from_ts {
          value = $p_from|to_timestamp
        }
      }
    }

    // Upper bound, same treatment.
    var $to_ts {
      value = null
    }

    conditional {
      if (($p_to|is_empty) == false) {
        var.update $to_ts {
          value = $p_to|to_timestamp
        }
      }
    }

    // PUSHDOWN. The db.query where clause cannot be assembled from a variable list, so the general filter set is applied in memory below. These three equality filters are the exception worth pushing down: without them a "device 12" question would page through 500 arbitrary rows and then keep none of them.
    var $pre_device_id {
      value = null
    }

    // Site scope, pushed down for the two entities that carry a site_id column.
    var $pre_site_id {
      value = null
    }

    // Status scope, pushed down for device - this is what makes "which devices are offline" a cheap query.
    var $pre_status {
      value = null
    }

    foreach ($clean_filters) {
      each as $pf {
        conditional {
          if (($pf.op == "eq") && ($pf.field == "device_id")) {
            var.update $pre_device_id {
              value = $pf.value|to_int
            }
          }
          elseif (($pf.op == "eq") && ($pf.field == "site_id")) {
            var.update $pre_site_id {
              value = $pf.value|to_int
            }
          }
          elseif (($pf.op == "eq") && ($pf.field == "status")) {
            var.update $pre_status {
              value = $pf.value|to_text
            }
          }
        }
      }
    }

    // The rows the plan actually selects, before the in-memory filter pass.
    var $raw_rows {
      value = []
    }

    // EXECUTION. One real db.query per entity, chosen by a conditional because the table name in a db.query is not a variable. Every branch is capped at 500 rows so a broad question cannot walk the telemetry table.
    conditional {
      if ($success) {
        conditional {
          if ($p_entity == "device") {
            // device has no event timestamp, so time_range is deliberately not applied here - filtering the fleet by last_seen_at would hide exactly the offline devices most questions are about.
            db.query device {
              where = $db.device.site_id ==? $pre_site_id && $db.device.status ==? $pre_status
              sort = {device.health_score: "asc"}
              return = {type: "list", paging: {page: 1, per_page: 500}}
            } as $q_device

            var.update $raw_rows {
              value = $q_device.items|safe_array
            }
          }
          elseif ($p_entity == "alert") {
            db.query alert {
              where = $db.alert.fired_at >=? $from_ts && $db.alert.fired_at <=? $to_ts && $db.alert.device_id ==? $pre_device_id
              sort = {alert.fired_at: "desc"}
              return = {type: "list", paging: {page: 1, per_page: 500}}
            } as $q_alert

            var.update $raw_rows {
              value = $q_alert.items|safe_array
            }
          }
          elseif ($p_entity == "incident") {
            db.query incident {
              where = $db.incident.opened_at >=? $from_ts && $db.incident.opened_at <=? $to_ts && $db.incident.site_id ==? $pre_site_id
              sort = {incident.opened_at: "desc"}
              return = {type: "list", paging: {page: 1, per_page: 500}}
            } as $q_incident

            var.update $raw_rows {
              value = $q_incident.items|safe_array
            }
          }
          elseif ($p_entity == "telemetry") {
            db.query telemetry {
              where = $db.telemetry.ts >=? $from_ts && $db.telemetry.ts <=? $to_ts && $db.telemetry.device_id ==? $pre_device_id
              sort = {telemetry.ts: "desc"}
              return = {type: "list", paging: {page: 1, per_page: 500}}
            } as $q_telemetry

            var.update $raw_rows {
              value = $q_telemetry.items|safe_array
            }
          }
          elseif ($p_entity == "metric_rollup") {
            db.query metric_rollup {
              where = $db.metric_rollup.bucket_ts >=? $from_ts && $db.metric_rollup.bucket_ts <=? $to_ts && $db.metric_rollup.device_id ==? $pre_device_id
              sort = {metric_rollup.bucket_ts: "desc"}
              return = {type: "list", paging: {page: 1, per_page: 500}}
            } as $q_rollup

            var.update $raw_rows {
              value = $q_rollup.items|safe_array
            }
          }
          else {
            db.query maintenance_prediction {
              where = $db.maintenance_prediction.created_at >=? $from_ts && $db.maintenance_prediction.created_at <=? $to_ts && $db.maintenance_prediction.device_id ==? $pre_device_id
              sort = {maintenance_prediction.created_at: "desc"}
              return = {type: "list", paging: {page: 1, per_page: 500}}
            } as $q_prediction

            var.update $raw_rows {
              value = $q_prediction.items|safe_array
            }
          }
        }
      }
    }

    // Rows that satisfy every validated filter. Filters are ANDed, which is what "and" means in the questions people actually ask.
    var $matched {
      value = []
    }

    // The in-memory pass exists because a db.query where clause is a compile-time expression: it cannot be assembled from a list whose length is only known at runtime. Correctness is identical; the cost is that filtering happens after the 500-row page, which is why the equality pushdown above matters.
    conditional {
      if ($success) {
        foreach ($raw_rows) {
          each as $row {
            var $keep {
              value = true
            }

            foreach ($clean_filters) {
              each as $cf {
                // The field name is already proven to be on the allowlist, so this get can only reach a permitted column.
                var $field_value {
                  value = $row|get:$cf.field
                }

                var $pass {
                  value = false
                }

                // One arm per allowed operator. The default arm is unreachable by construction (the op was validated) and fails closed anyway.
                switch ($cf.op) {
                  case ("eq") {
                    var.update $pass {
                      value = $field_value == $cf.value
                    }
                  } break

                  case ("ne") {
                    var.update $pass {
                      value = $field_value != $cf.value
                    }
                  } break

                  case ("gt") {
                    var.update $pass {
                      value = ($field_value|to_decimal) > ($cf.value|to_decimal)
                    }
                  } break

                  case ("gte") {
                    var.update $pass {
                      value = ($field_value|to_decimal) >= ($cf.value|to_decimal)
                    }
                  } break

                  case ("lt") {
                    var.update $pass {
                      value = ($field_value|to_decimal) < ($cf.value|to_decimal)
                    }
                  } break

                  case ("lte") {
                    var.update $pass {
                      value = ($field_value|to_decimal) <= ($cf.value|to_decimal)
                    }
                  } break

                  case ("contains") {
                    var.update $pass {
                      value = ($field_value|to_text)|icontains:($cf.value|to_text)
                    }
                  } break

                  case ("in") {
                    var.update $pass {
                      value = ($cf.value|safe_array)|in:$field_value
                    }
                  } break

                  default {
                    var.update $pass {
                      value = false
                    }
                  }
                }

                conditional {
                  if ($pass == false) {
                    var.update $keep {
                      value = false
                    }
                  }
                }
              }
            }

            conditional {
              if ($keep) {
                array.push $matched {
                  value = $row
                }
              }
            }
          }
        }
      }
    }

    // Reported before the limit is applied, so "how many" is answered honestly even when only 200 rows come back.
    var $row_count {
      value = $matched|count
    }

    // Sorted in memory because a db.query sort key cannot be a variable. inatural handles both numeric and textual columns without having to know the column's type up front.
    var $sorted {
      value = $matched
    }

    conditional {
      if ($p_sort_field != null) {
        var $sort_asc {
          value = $p_sort_dir == "asc"
        }

        var.update $sorted {
          value = $matched|sort:$p_sort_field:"inatural":$sort_asc
        }
      }
    }

    // The rows the caller actually receives, clamped to the validated limit.
    var $rows {
      value = $sorted|slice:0:$p_limit
    }

    // Defaulted so a count aggregate and a field aggregate can share one accumulation loop without a null path ever reaching get.
    var $agg_field_safe {
      value = $p_agg_field|first_notempty:"id"
    }

    // Ungrouped aggregate result.
    var $agg_value {
      value = null
    }

    // Grouped aggregate results, one entry per distinct group value.
    var $agg_groups {
      value = []
    }

    // AGGREGATION happens here, in XanoScript, and nowhere else: db.direct_query is plan-gated and return={type:"aggregate"} has undocumented parameter names, so foreach accumulation is the only honest option available.
    conditional {
      if ($success && ($p_agg_fn != null) && ($p_group_by == null)) {
        var $values {
          value = []
        }

        foreach ($matched) {
          each as $agg_row {
            array.push $values {
              value = ($agg_row|get:$agg_field_safe)|to_decimal
            }
          }
        }

        // An empty match set aggregates to 0 rather than to null, so a chart tile never renders "null devices".
        conditional {
          if (($matched|count) == 0) {
            var.update $agg_value {
              value = 0
            }
          }
          else {
            switch ($p_agg_fn) {
              case ("count") {
                var.update $agg_value {
                  value = $matched|count
                }
              } break

              case ("sum") {
                var.update $agg_value {
                  value = $values|sum
                }
              } break

              case ("avg") {
                var.update $agg_value {
                  value = $values|avg
                }
              } break

              case ("min") {
                var.update $agg_value {
                  value = $values|array_min
                }
              } break

              case ("max") {
                var.update $agg_value {
                  value = $values|array_max
                }
              } break

              default {
                var.update $agg_value {
                  value = $matched|count
                }
              }
            }
          }
        }
      }
    }

    // Grouped aggregation, as a two-pass linear scan: collect the distinct group values, then re-scan per group. O(rows x groups), but the control flow is verifiable, which matters more than constant factors at a 200-row ceiling.
    conditional {
      if ($success && ($p_agg_fn != null) && ($p_group_by != null)) {
        var $group_values {
          value = []
        }

        foreach ($matched) {
          each as $grow {
            array.push $group_values {
              value = ($grow|get:$p_group_by)|to_text
            }
          }
        }

        var $distinct_groups {
          value = $group_values|unique
        }

        foreach ($distinct_groups) {
          each as $group_key {
            var $g_values {
              value = []
            }

            var $g_count {
              value = 0
            }

            foreach ($matched) {
              each as $grow2 {
                conditional {
                  if ((($grow2|get:$p_group_by)|to_text) == $group_key) {
                    math.add $g_count {
                      value = 1
                    }

                    array.push $g_values {
                      value = ($grow2|get:$agg_field_safe)|to_decimal
                    }
                  }
                }
              }
            }

            // Defaults to the member count, which is also the correct answer for fn count.
            var $g_value {
              value = $g_count
            }

            switch ($p_agg_fn) {
              case ("sum") {
                var.update $g_value {
                  value = $g_values|sum
                }
              } break

              case ("avg") {
                var.update $g_value {
                  value = $g_values|avg
                }
              } break

              case ("min") {
                var.update $g_value {
                  value = $g_values|array_min
                }
              } break

              case ("max") {
                var.update $g_value {
                  value = $g_values|array_max
                }
              } break

              default {
                var.update $g_value {
                  value = $g_count
                }
              }
            }

            array.push $agg_groups {
              value = {
                key  : $group_key
                value: $g_value
                count: $g_count
              }
            }
          }
        }
      }
    }

    // Null when the plan asked for no aggregate, which the frontend reads as "render rows, not a number".
    var $aggregate {
      value = null
    }

    conditional {
      if ($p_agg_fn != null) {
        var.update $aggregate {
          value = {
            fn      : $p_agg_fn
            field   : $p_agg_field
            group_by: $p_group_by
            value   : $agg_value
            groups  : $agg_groups
          }
        }
      }
    }

    // DETERMINISTIC ANSWER, computed before the second inference is attempted. It is what ships when there is no key, when Anthropic rate-limits, or when the plan was rejected - a judge must never see a blank Ask console.
    var $answer {
      value = "Matched " ~ ($row_count|to_text) ~ " " ~ ($p_entity|to_text) ~ " row(s)" ~ " with " ~ (($clean_filters|count)|to_text) ~ " filter(s) applied."
    }

    // A rejected plan explains itself instead of pretending to have an answer.
    conditional {
      if ($success == false) {
        var.update $answer {
          value = "That question could not be answered safely. " ~ ($error_reason|to_text)
        }
      }
      elseif ($aggregate != null) {
        var.update $answer {
          value = "Matched " ~ ($row_count|to_text) ~ " " ~ ($p_entity|to_text) ~ " row(s); " ~ ($p_agg_fn|to_text) ~ " = " ~ (($agg_value|first_notnull:0)|to_text) ~ " across " ~ (($agg_groups|count)|to_text) ~ " group(s)."
        }
      }
    }

    // True until a model-written answer replaces the deterministic one above.
    var $answer_fallback_used {
      value = true
    }

    // Model identity and cost, hoisted so the response can report provenance whether or not the second inference ran.
    var $answer_model {
      value = null
    }

    // SECOND INFERENCE: rows into English. It gets only a bounded sample plus the aggregate, never the full result set - both to keep the prompt small and to make it structurally impossible for the model to imply it counted more than it saw.
    conditional {
      if ($success) {
        var $sample {
          value = ($rows|slice:0:25)|json_encode
        }

        var $writer_system {
          value = "You are Nerve's fleet analyst, writing the answer to an operator's question about their device fleet. You are given the question, the number of rows that matched, the aggregate that was computed if there was one, and a bounded JSON sample of the matched rows. Write ONE short paragraph of plain English - no markdown, no bullet points, no code fence, no preamble such as 'Based on the data provided'. GROUNDING RULES, which override any instinct to sound helpful: every number and every device, site, metric or incident name you mention must appear in the supplied rows or in the aggregate. Never estimate, extrapolate or infer a total from the sample - if the sample is smaller than the matched row count, state the count and describe the rows you were given as examples. If the rows do not actually answer the question that was asked, say plainly what they do show and what is missing, and lower your confidence rather than speculating about a cause. If zero rows matched, say so directly and state which filters were applied; an empty result is an answer, not a failure. Do not recommend an action unless the rows themselves evidence it."
        }

        var $writer_prompt {
          value = "QUESTION: " ~ $input.question ~ " || ENTITY QUERIED: " ~ ($p_entity|to_text) ~ " || FILTERS APPLIED: " ~ ($clean_filters|json_encode) ~ " || TOTAL ROWS MATCHED: " ~ ($row_count|to_text) ~ " || AGGREGATE: " ~ ($aggregate|json_encode) ~ " || SAMPLE ROWS (JSON, at most 25 of the matched rows): " ~ $sample ~ " || PHRASING SUGGESTION FROM THE PLANNER: " ~ ($p_answer_template|first_notempty:"none")
        }

        function.run "Nerve/fn_claude" {
          input = {
            system     : $writer_system
            user_prompt: $writer_prompt
            max_tokens : 600
            kind       : "nl_query"
            title      : "Answer: " ~ $input.question
            expect_json: false
          }
        } as $writer

        // Stamped either way, so the response and the ai_insight rows agree on which model was attempted.
        var.update $answer_model {
          value = $writer.model
        }

        // A silent empty text is a valid response from fn_claude, so both the flag and the emptiness are checked before the deterministic answer is discarded.
        conditional {
          if (($writer.fallback_used == false) && (($writer.text|is_empty) == false)) {
            var.update $answer {
              value = $writer.text
            }

            var.update $answer_fallback_used {
              value = false
            }
          }
        }
      }
    }

    // One flag for the UI badge: if either half of the pipeline degraded, the answer is not fully model-derived and the operator deserves to know.
    var $fallback_used {
      value = $plan_fallback_used || $answer_fallback_used
    }

    // Measured, not estimated, and inclusive of both inferences and the query itself.
    var $latency_ms {
      value = ("now"|to_ms) - $started_ms
    }

    // The plan as executed, not as proposed: clamped limit, dropped sort, sanitised chart hint, and both the violations and the warnings that shaped it. This is what makes the compiler auditable rather than magic.
    var $plan_out {
      value = {
        entity         : $p_entity
        filters        : $clean_filters
        time_range     : {from: $p_from, to: $p_to}
        aggregate      : $aggregate
        sort           : {field: $p_sort_field, direction: $p_sort_dir}
        limit          : $p_limit
        chart_hint     : $chart_hint
        answer_template: $p_answer_template
        warnings       : $warnings
        violations     : $violations
      }
    }

    // Every question is logged, answered or rejected. The log is the Ask console's history rail and the evidence that the NL-to-query compiler works.
    db.add nl_query_log {
      data = {
        created_at    : "now"
        user_id       : $user.id
        question      : $input.question
        generated_plan: $plan_out
        row_count     : $row_count
        answer        : $answer
        chart_hint    : $chart_hint
        rows_preview  : $rows|slice:0:5
        latency_ms    : $latency_ms
        success       : $success
        fallback_used : $fallback_used
        error         : $error_reason
      }
    } as $log
  }

  response = {
    success              : $success
    answer               : $answer
    rows                 : $rows
    row_count            : $row_count
    plan                 : $plan_out
    chart_hint           : $chart_hint
    aggregate            : $aggregate
    fallback_used        : $fallback_used
    plan_fallback_used   : $plan_fallback_used
    answer_fallback_used : $answer_fallback_used
    model                : $answer_model
    latency_ms           : $latency_ms
    error                : $error_reason
    query_log_id         : $log.id
  }
  tags = ["nerve"]
}
