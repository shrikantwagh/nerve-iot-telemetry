// Resolve the bearer token to its account. The SPA calls this on boot to decide which nav items to render, so it must return the role.
query "me" verb=GET {
  api_group = "NerveAuth"
  auth = "user"

  input {
  }

  stack {
    // Explicit column list rather than the whole row: `password`, `token` and `password_reset` all live on this table and none of them belong in a response.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "created_at", "name", "email", "role", "avatar_color", "last_login_at", "demo_account"]
    } as $user

    // A structurally valid token for a deleted account. Better a clean 404 than a null body the SPA has to guess about.
    precondition ($user != null) {
      error_type = "notfound"
      error = "The account for this token no longer exists."
    }
  }

  response = $user
  tags = ["nerve"]
  guid = "7-4VkcKEo_JcbP34jcw59re7Cv4"
}
