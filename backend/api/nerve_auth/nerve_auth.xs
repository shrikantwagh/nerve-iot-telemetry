// Public front door. Every endpoint here declares its own auth, because three of the four must be reachable without a token - and the fourth, /demo, is the whole point: a judge gets a working session without ever typing a password.
api_group NerveAuth {
  description = "Public identity surface for Nerve: signup, login, token introspection, and the one-click demo login judges use instead of a password."
  // Canonical is the URL segment and must be unique at the INSTANCE level, not just the
  // workspace. A bare "auth" was silently rejected on import and replaced with a random
  // slug, which would then differ on every fresh instance and break any hardcoded
  // client. Prefixed names are specific enough to be accepted and stable enough to
  // hardcode.
  canonical = "nerve-auth"

  // Signup, login and demo all carry a password or a freshly minted token. `history` at group level caps how many statements each request records for debugging, so zero keeps credential-bearing stack traces out of the instance database. Request-body archival itself is a separate workspace-level setting the UI owns.
  history = 0
  tags = ["nerve"]
  guid = "iiy_EF0FgXf3lJoiEE75ntaKd30"
}
