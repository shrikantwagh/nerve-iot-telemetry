// The dashboard's own group. Kept separate from `ingest` so device traffic never shares request-history settings or auth strategy with human traffic, and separate from `auth` so a token-minting surface stays small.
api_group Nerve {
  description = "Authenticated (user JWT) read/write surface for the Nerve dashboard: fleet rollups, devices, sites, device types, alerts, incidents, commands and the AI endpoints."
  canonical = "nerve"
  tags = ["nerve"]
}
