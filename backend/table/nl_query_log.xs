// Natural-language query history.
//
// Stores the question, the JSON query plan the model produced, and what came back. Two
// jobs: it powers the "recent questions" list in the Ask console, and it is the audit
// trail proving the NL-to-query compiler produced a real, inspectable query rather than
// a hallucinated answer.
table nl_query_log {
  auth = false

  schema {
    int id
    timestamp created_at?=now

    int user_id? {
      table = "user"
    }

    text question filters=trim

    // The validated plan: {entity, filters, time_range, aggregate, chart_hint}.
    json generated_plan?

    int row_count?=0
    text answer?
    json chart_hint?
    json rows_preview?

    int latency_ms?=0
    bool success?=true
    bool fallback_used?=false
    text error?
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree", field: [{name: "user_id"}]}
    {type: "btree", field: [{name: "success"}]}
  ]

  tags = ["nerve"]
}
