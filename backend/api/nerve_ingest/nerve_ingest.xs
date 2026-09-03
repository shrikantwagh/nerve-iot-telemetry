// The device-facing ingest surface. Separate from the user-JWT group because devices carry hashed API keys, not tokens.
api_group NerveIngest {
  description = "Device-facing ingest: registration, telemetry (single and batch) and command acknowledgements. Authenticated by mw_api_key_auth, never by a user JWT."
  canonical = "ingest"
  // Statements logged per request. Zero on purpose: Xano writes every request body
  // into the instance database, and on a telemetry ingest path that log would dwarf
  // the telemetry itself. `history` is an INTEGER (a statement cap), not an object.
  history = 0
  tags = ["nerve"]
}
