// One append-only write, called by every mutating endpoint and task. Kept trivial on purpose: audit logging that can fail is audit logging nobody trusts.
function "Nerve/fn_audit" {
  description = "Appends a row to audit_log. Every mutating Nerve endpoint calls this so who-changed-what is answerable after the fact."

  input {
    // Null for device- and task-originated actions, which have no user behind them.
    int user_id?

    // Verb-ish action slug, e.g. "device.update" or "alert.ack".
    text action

    // Table the action touched, so the log can be filtered per entity kind.
    text entity_type?

    // Primary key of the touched row.
    int entity_id?

    // Free-form before/after or request payload; the reason the column is json.
    json detail?

    // Which surface originated the action. Matches audit_log.source enum.
    text source?=ui
  }

  stack {
    // Single insert; created_at is written explicitly so the row's ordering does not depend on a column default.
    db.add audit_log {
      data = {
        created_at : "now"
        user_id    : $input.user_id
        action     : $input.action
        entity_type: $input.entity_type
        entity_id  : $input.entity_id
        detail     : $input.detail
        source     : $input.source
      }
    } as $entry
  }

  response = null
  tags = ["nerve"]
  guid = "zx1Bxm6nlT5HpcdOt3CQIk1Ykns"
}
