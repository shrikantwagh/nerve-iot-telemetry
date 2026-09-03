// The device-facing ingest surface. Separate from the user-JWT group because devices carry hashed API keys, not tokens.
api_group NerveIngest {
  description = "Device-facing ingest: registration, telemetry (single and batch) and command acknowledgements. Authenticated by mw_api_key_auth, never by a user JWT."
  canonical = "ingest"
  history = {inherit: false, enabled: false}
  tags = ["nerve"]
}
