// A physical location that devices live in. Scoping alerts and incidents by site is
// what turns "40 unrelated alerts" into "one thing wrong at Osaka".
table site {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    // Short human code used by devices when they self-register, e.g. "OSA-01".
    text code filters=trim|upper

    text name filters=trim
    text timezone?=UTC filters=trim
    text region? filters=trim
    text address? filters=trim
    decimal? lat?
    decimal? lng?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree|unique", field: [{name: "code", op: "asc"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
  ]

  tags = ["nerve"]
  guid = "tQukkb44iH8qG3wzq7BpLFVyDqs"
}
