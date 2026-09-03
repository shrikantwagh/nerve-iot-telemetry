// Create an account and hand back a usable session in one call. The first account on a fresh workspace becomes admin, so a cold install is never locked out of its own admin surface.
query "signup" verb=POST {
  api_group = "NerveAuth"

  input {
    // Shown on the avatar and in the audit log, so it is required rather than decorative.
    text name filters=trim

    // The unique key for an account; normalised so "Foo@Bar.com " and "foo@bar.com" cannot become two users.
    email email filters=trim|lower

    // Length floor enforced at the edge - the `password` column type hashes it, but it cannot make a short password strong.
    text password filters=min:8|max:128
  }

  stack {
    // Email is the account's unique key, so a plain get is the whole duplicate check.
    db.get user {
      field_name = "email"
      field_value = $input.email
      output = ["id"]
    } as $existing

    // Refuse before writing anything. accessdenied rather than inputerror so the response does not confirm which emails are registered any more than it has to.
    precondition ($existing == null) {
      error_type = "accessdenied"
      error = "An account with this email already exists."
    }

    // Bootstrap check: on an empty user table the very first signup has to become admin, or nobody can ever reach /api-keys or /admin/seed.
    db.query user {
      return = {type: "count"}
    } as $user_count

    // Default for everyone after the first. Least privilege: a new account can read the fleet, not command it.
    var $role {
      value = "viewer"
    }

    // The bootstrap promotion. Deliberately count-based rather than a config flag, so it cannot be re-triggered once anyone exists.
    conditional {
      if ($user_count == 0) {
        var.update $role {
          value = "admin"
        }
      }
    }

    // Small fixed palette instead of a random hex, so avatars stay legible against the dark UI and two users are visually distinguishable.
    var $palette {
      value = ["#6366f1", "#0ea5e9", "#14b8a6", "#f59e0b", "#ef4444", "#a855f7", "#22c55e", "#ec4899"]
    }

    // shuffle|first is the pick: there is no scalar random filter, and shuffling an 8-element literal is free.
    var $avatar_color {
      value = $palette|shuffle|first
    }

    // demo_account is written explicitly as false. A real signup must never inherit the read-only demo identity.
    db.add user {
      data = {
        created_at  : "now"
        name        : $input.name
        email       : $input.email
        password    : $input.password
        role        : $role
        avatar_color: $avatar_color
        demo_account: false
        last_login_at: "now"
      }
    } as $new_user

    // Re-read with an explicit column list. This is the only guarantee the password hash never reaches the response - the row returned by db.add carries it.
    db.get user {
      field_name = "id"
      field_value = $new_user.id
      output = ["id", "created_at", "name", "email", "role", "avatar_color", "last_login_at", "demo_account"]
    } as $user

    // Who created which account, and whether it was the bootstrap admin, is exactly the kind of question asked after the fact.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $user.id
        action     : "user.signup"
        entity_type: "user"
        entity_id  : $user.id
        detail     : {role: $role, bootstrap_admin: ($user_count == 0)}
        source     : "ui"
      }
    } as $audit

    // Signup logs the user straight in; making them re-post to /login would be theatre.
    security.create_auth_token {
      table = "user"
      extras = {}
      expiration = 86400
      id = $user.id
    } as $authToken
  }

  response = {authToken: $authToken, user: $user}
  tags = ["nerve"]
  guid = "tpN4HfmsynqQPmz6WfGqrFSTKS8"
}
