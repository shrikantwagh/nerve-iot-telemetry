// Public front door. Every endpoint here declares its own auth, because three of the four must be reachable without a token - and the fourth, /demo, is the whole point: a judge gets a working session without ever typing a password.
api_group NerveAuth {
  canonical = "auth"

  // Signup, login and demo all carry a password or a freshly minted token. `history` at group level caps how many statements each request records for debugging, so zero keeps credential-bearing stack traces out of the instance database. Request-body archival itself is a separate workspace-level setting the UI owns.
  history = 0
  tags = ["nerve"]
}
