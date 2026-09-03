// One-click demo login: a judge presses a button and lands in the app. Public and password-free by design, and self-healing on a cold workspace - if the demo account does not exist yet, this call creates it rather than failing.
query "demo" verb=POST {
  api_group = "NerveAuth"

  input {
  }

  stack {
    // The flag, not the email, is the real identity of this account - an operator may rename it, and the read-only guard on every mutating endpoint keys off demo_account.
    db.query user {
      where = $db.user.demo_account == true
      sort = {user.id: "asc"}
      return = {type: "single"}
    } as $demo_by_flag

    // Fallback lookup. Someone may have created demo@nerve.app by hand without the flag; email is unique, so blindly inserting would fail on the constraint instead of logging them in.
    db.get user {
      field_name = "email"
      field_value = "demo@nerve.app"
      output = ["id"]
    } as $demo_by_email

    // Flat selector so the branches below stay linear.
    var $demo_user {
      value = $demo_by_flag|first_notnull:$demo_by_email
    }

    // Cold-start path: mint the account on first use. A random uuid as the password means the credential exists (the column is required for any future password login) but nobody, including us, knows it.
    conditional {
      if ($demo_user == null) {
        security.create_uuid as $generated_password

        db.add user {
          data = {
            created_at   : "now"
            name         : "Nerve Demo"
            email        : "demo@nerve.app"
            password     : $generated_password
            role         : "viewer"
            avatar_color : "#14b8a6"
            demo_account : true
            last_login_at: "now"
          }
        } as $created_user

        var.update $demo_user {
          value = $created_user
        }
      }
    }

    // Should be unreachable; kept because a null here would otherwise mint a token for id null.
    precondition ($demo_user != null) {
      error_type = "standard"
      error = "The demo account could not be provisioned."
    }

    // demo_account is re-asserted, not merely stamped: this is what heals the email-matched row from the fallback lookup, which is the one case where the flag might be false.
    db.patch user {
      field_name = "id"
      field_value = $demo_user.id
      data = {last_login_at: "now", demo_account: true}
    } as $patched

    // Explicit column list keeps the generated password hash out of the response.
    db.get user {
      field_name = "id"
      field_value = $demo_user.id
      output = ["id", "created_at", "name", "email", "role", "avatar_color", "last_login_at", "demo_account"]
    } as $user

    // Demo logins are unauthenticated, so the audit row is the only record that someone walked in this way.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $user.id
        action     : "auth.demo_login"
        entity_type: "user"
        entity_id  : $user.id
        detail     : {provisioned: ($demo_by_flag == null), matched_by_email: ($demo_by_flag == null && $demo_by_email != null)}
        source     : "ui"
      }
    } as $audit

    // Same 24h expiry as a real login. The account is read-only, so a long-lived demo token is not a privilege risk.
    security.create_auth_token {
      table = "user"
      extras = {}
      expiration = 86400
      id = $user.id
    } as $authToken
  }

  response = {authToken: $authToken, user: $user}
  tags = ["nerve"]
  guid = "qE3H3gi16Gp2gTr2vqERptntc6E"
}
