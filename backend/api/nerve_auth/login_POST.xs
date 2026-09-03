// Exchange an email and password for a session token. Mirrors the workspace's own login flow, with last_login_at stamped so the admin surface can tell a live account from a dormant one.
query "login" verb=POST {
  api_group = "NerveAuth"

  input {
    // Normalised the same way signup normalises it, or a capitalised address would never match its own row.
    email email filters=trim|lower

    // No length filter here on purpose: rejecting a short password at login would leak the policy and cannot help anyway.
    text password
  }

  stack {
    // The password hash is pulled deliberately - security.check_password needs it, and it is dropped again before the response.
    db.get user {
      field_name = "email"
      field_value = $input.email
      output = ["id", "password"]
    } as $user

    // Same error text and type as the failed-password branch below, so the response cannot be used to enumerate registered emails.
    precondition ($user != null) {
      error_type = "accessdenied"
      error = "Invalid credentials."
    }

    // Constant-time comparison against the stored hash; the plaintext never touches the database.
    security.check_password {
      text_password = $input.password
      hash_password = $user.password
    } as $pass_result

    // Indistinguishable from the unknown-email case, by design.
    precondition ($pass_result) {
      error_type = "accessdenied"
      error = "Invalid credentials."
    }

    // Written on the successful path only, so the column means "last time this account actually got in".
    db.patch user {
      field_name = "id"
      field_value = $user.id
      data = {last_login_at: "now"}
    } as $patched

    // Fresh read with an explicit column list. This is what keeps the hash out of the response - $user and $patched both carry it.
    db.get user {
      field_name = "id"
      field_value = $user.id
      output = ["id", "created_at", "name", "email", "role", "avatar_color", "last_login_at", "demo_account"]
    } as $user_public

    // Successful logins are the baseline an audit reader needs to spot the unusual ones.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $user_public.id
        action     : "auth.login"
        entity_type: "user"
        entity_id  : $user_public.id
        detail     : {role: $user_public.role}
        source     : "ui"
      }
    } as $audit

    // 24h matches the workspace's existing convention; the SPA re-logins rather than refreshing.
    security.create_auth_token {
      table = "user"
      extras = {}
      expiration = 86400
      id = $user_public.id
    } as $authToken
  }

  response = {authToken: $authToken, user: $user_public}
  tags = ["nerve"]
}
