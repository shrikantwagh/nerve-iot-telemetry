// The device-facing surface. Split from the user-JWT group because its callers are devices holding hashed API keys, and because its request-history policy has to differ.
api_group NerveIngest {
  description = "Device-facing ingest: self-registration, single and batch telemetry, and command acknowledgements. Authenticated by the mw_api_key_auth pre-middleware, never by a user JWT."
  canonical = "ingest"
  history = 0
  tags = ["nerve"]
}
