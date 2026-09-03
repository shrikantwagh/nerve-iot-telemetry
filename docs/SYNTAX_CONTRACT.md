# XanoScript syntax contract — Nerve

Every fact here is from real `xano workspace pull` output of this workspace, or from the
XanoScript language server shipped in `@xano/developer-mcp` v2.2.5. **Do not invent
syntax.** If something is not covered here, get it from the language server:

```bash
node scripts/xs-validate.mjs --docs apis      # topics: tables apis functions tasks triggers database types syntax realtime middleware security performance
node scripts/xs-validate.mjs backend/api/.../foo.xs   # validate; exits non-zero on error
```

Ground-truth reference files already in the repo (pulled from the live workspace):
`backend/table/user.xs`, `backend/api/authentication/auth/login_POST.xs`,
`backend/api/authentication/auth/me_GET.xs`,
`backend/api/event_logs/logs/user/my_events_GET.xs`,
`backend/function/quick_start/log_event.xs`,
`backend/function/quick_start/enforce_role.xs`.

---

## 1. File layout (canonical — this is what the CLI produces and expects)

| Primitive | Path |
|---|---|
| table | `table/<snake_name>.xs` |
| table trigger | `table/trigger/<snake_name>.xs` |
| custom function | `function/<snake_folder>/<snake_name>.xs` |
| API group | `api/<snake_group>/<snake_group>.xs` |
| API endpoint | `api/<snake_group>/<path_segments>/<last_segment>_<VERB>.xs` |
| background task | `task/<snake_name>.xs` |
| middleware | `middleware/<snake_name>.xs` |
| realtime channel | `realtime/channel/<snake_name>.xs` |

Endpoint example: group `Nerve`, path `devices/{device_id}/telemetry`, verb GET
-> `api/nerve/devices/{device_id}/telemetry_GET.xs`

**Never write a `guid = "..."` line in a new file.** The server assigns GUIDs on first
push and the CLI writes them back. Inventing one corrupts object identity.

---

## 2. Declarations

```xs
// Comment directly above a declaration becomes its description.
api_group Nerve {
  description = "..."
  canonical = "nerve"          // THE URL SEGMENT: /api:nerve/...
  history = {inherit: false}   // see §8 - request history
}

// Endpoint. Path is quoted when it contains / or {}.
query "devices/{device_id}" verb=GET {
  api_group = "Nerve"          // must match the api_group NAME, not the canonical
  auth = "user"                // omit entirely for a public endpoint
  input { ... }
  stack { ... }
  response = $something
}

function "Nerve/fn_name" {     // quoted, folder-prefixed; file is function/nerve/fn_name.xs
  description = "..."
  input { ... }
  stack { ... }
  response = $result
}

task task_name {
  active = true                // DEFAULT IS false - a task with active=false never fires
  stack { ... }
  schedule = [{starts_on: 2026-09-03 00:00:00+0000, freq: 300}]
}

middleware mw_name {
  input {
    json vars
    enum type { values = ["pre", "post"] }
  }
  stack { ... }
  response = {key: $value}
  response_strategy = "merge"
  exception_policy = "critical"
}

table_trigger trigger_name {
  table = "alert"
  input {
    json new
    json old
    enum action { values = ["insert", "update", "delete", "truncate"] }
    text datasource
  }
  stack { ... }
  actions = {insert: true}
}
```

`auth = true` on a **table** is a boolean (enables auth on it).
`auth = "user"` on a **query** is a string naming the auth-enabled table. Do not swap these.

---

## 3. Inputs

```xs
input {
  text name                          // required
  text note?                         // optional
  int page?=1                        // optional with default
  email email? filters=trim|lower
  decimal threshold?
  json metrics
  bool enabled?=true
  timestamp? from?                   // `type?` = NULLABLE, `name?` = OPTIONAL
  enum state? { values = ["open", "resolved"] }
  int device_id { table = "device" }  // path param that is a foreign key
  object[] readings? {
    schema {
      text device_serial
      timestamp? ts?
      json metrics
    }
  }
}
```

An endpoint with no inputs still needs an empty `input { }` block.

---

## 4. Stack steps

Form is `namespace.op target { params } as $var`. Put a `//` comment above each step.

```xs
db.get user { field_name = "id"  field_value = $auth.id  output = ["id", "name"] } as $user
db.has device { field_name = "serial"  field_value = $input.serial } as $exists

db.query device {
  where = $db.device.site_id == $input.site_id && $db.device.status == "online"
  sort = {device.health_score: "asc"}
  return = {type: "list", paging: {page: $input.page, per_page: 50, totals: true}}
  output = ["items.id", "items.name", "itemsTotal", "curPage", "pageTotal"]
} as $devices
```

`where` is the filter key (confirmed from this workspace's own pull output; some doc pages
say `search` — ignore them). `return.type` is one of
`exists | count | single | list | stream`.

```xs
db.add alert { data = {created_at: "now", device_id: $input.device_id, severity: "warning"} } as $alert
db.edit device { field_name = "id"  field_value = $input.device_id  data = {status: "online"} } as $d
db.add_or_edit metric_baseline { field_name = "id"  field_value = $b.id  data = {ewma: $new} } as $b2
db.patch device { field_name = "id"  field_value = $id  data = {}|set:"name":$input.name } as $d
db.del device { field_name = "id"  field_value = $input.device_id }
db.bulk.add telemetry { allow_id_field = false  items = $rows } as $inserted
db.transaction { stack { ... } }
```

```xs
precondition ($user != null) { error_type = "notfound"  error = "Device not found" }
// error_type: notfound | accessdenied | inputerror | unauthorized | toomanyrequests | standard

throw { name = "accessdenied"  value = "Admin required" }

conditional {
  if ($x > 10) { ... }
  else if ($x > 5) { ... }
  else { ... }
}

foreach ($list) { each as $item { ... } }

var $total { value = 0 }
var.update $total { value = $total + $item.amount }

array.push $acc { value = $row }

group { stack { ... } }

function.run "Nerve/fn_claude" { input = {system: $sys, user_prompt: $p} } as $ai

api.request {
  url = "https://api.anthropic.com/v1/messages"
  method = "POST"
  params = { model: "claude-opus-5", max_tokens: 1024, messages: [] }
  headers = []|push:"x-api-key: " ~ $env.ANTHROPIC_API_KEY|push:"anthropic-version: 2023-06-01"|push:"Content-Type: application/json"
  timeout = 30
} as $res

api.realtime_event { channel = "fleet"  data = $payload }

security.create_auth_token { table = "user"  extras = {}  expiration = 86400  id = $user.id } as $token
security.check_password { text_password = $input.password  hash_password = $user.password } as $ok
security.create_uuid as $uuid
```

`api.request` returns `{response: <parsed body>, status: <int>, headers: ...}`. Check
`$res.status` before trusting `$res.response`.

---

## 5. Expressions & filters

- String concat is `~`:  `"Device " ~ $device.name ~ " is hot"`
- Filters pipe off a value: `$input.email|trim|lower`, `$obj|get:"key"`,
  `$list|count`, `$n|round:2`, `$arr|first`, `$text|split:" "`
- Object/array literals: `{a: 1, b: $x}` and `[1, 2, $y]`
- `{}|set:"k":$v` builds an object incrementally
- `[]|push:$v` appends
- `"now"` is the literal for the current timestamp in `data = {...}`
- Timestamp maths uses filters, e.g. `"now"|timestamp_subtract_hours:24`. **Verify any
  filter name with `--docs syntax` or `--docs expressions/filters` before using it.**

---

## 6. Hard limits that shape the design

1. **No raw SQL.** `db.direct_query` is gated to Launch/Scale plans. Aggregations must be
   `db.query` + `foreach` accumulation in XanoScript.
2. **Do not use `return = {type: "aggregate"}`.** Its XanoScript parameter names are
   undocumented; guessing them produces a file that validates but misbehaves.
3. **Tasks take no inputs and return no response.** Parameters come from a config table
   or `$env`.
4. **Tasks are not cron.** `schedule = [{starts_on: <absolute ts>, freq: <seconds>}]`.
5. **`active = true`** or the task never runs.
6. **Realtime publishes action `event`**, not `message`.
7. Free plan is capped at 10 requests / 20 seconds instance-wide; Essential removes it.
   Batch telemetry regardless — one POST carrying many readings.

---

## 7. Nerve conventions

- API groups and their canonicals: `NerveAuth`/`auth`, `NerveIngest`/`ingest`,
  `Nerve`/`nerve`.
- Custom functions live under the `Nerve/` folder: `function "Nerve/fn_claude"` in
  `function/nerve/fn_claude.xs`.
- Every mutating endpoint calls `function.run "Nerve/fn_audit"` so the action is logged.
- Tag every new object `tags = ["nerve"]`.
- Field names come from `docs/TABLE_CONTRACT.md`. That file is generated from the live
  schema — treat it as authoritative and never guess a column name.
- Errors: `precondition` for expected failures (not found, bad input, denied); `throw`
  only inside a `conditional`.
- Endpoints that mutate must reject the demo account:
  `precondition ($user.demo_account == false) { error_type = "accessdenied" error = "The demo account is read-only." }`

---

## 8. Request history

Xano logs every request body into the instance database by default. For the ingest group
that is fatal — telemetry would dwarf the telemetry. Set on the ingest API group:

```xs
history = {inherit: false, enabled: false}
```

If the language server rejects that shape, fall back to `history = {inherit: false}` and
note it for a manual toggle in the UI. Validate, do not assume.
