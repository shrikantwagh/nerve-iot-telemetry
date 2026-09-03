// Creates a site. `code` matters more than it looks: the ingest register path resolves a device's site by code, so this is the value a device firmware ships with.
query "sites" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    // Short stable identifier, unique across the workspace. Devices announce themselves with this, not with the id.
    text code

    text name

    // Defaults to UTC. Site-local time is what an operator reads a chart in, so a wrong value here is a wrong story about when something happened.
    text timezone?

    text region?

    text address?

    // Optional because a site is useful before anyone has geocoded it; the fleet map simply skips a site without coordinates.
    decimal? lat?

    decimal? lng?
  }

  stack {
    // Role and demo status come from the row rather than the token, so a demotion is effective on the next request.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role", "demo_account"]
    } as $user

    precondition ($user != null) {
      error_type = "unauthorized"
      error = "Authenticated user no longer exists."
    }

    precondition ($user.role == "admin" || $user.role == "operator") {
      error_type = "accessdenied"
      error = "Operator or admin role required to create a site."
    }

    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Trimmed but deliberately NOT case-folded: ingest matches this string exactly, and silently upper-casing it here would break every device flashed with a lowercase code.
    var $code {
      value = $input.code|trim
    }

    precondition (($code|strlen) > 0) {
      error_type = "inputerror"
      error = "code is required and cannot be blank."
    }

    var $name {
      value = $input.name|trim
    }

    precondition (($name|strlen) > 0) {
      error_type = "inputerror"
      error = "name is required and cannot be blank."
    }

    // Checked explicitly so the operator gets a sentence naming the collision instead of a constraint violation.
    db.has site {
      field_name = "code"
      field_value = $code
    } as $code_taken

    precondition ($code_taken == false) {
      error_type = "inputerror"
      error = "A site with code '" ~ $code ~ "' already exists."
    }

    // first_notempty rather than first_notnull so a blank timezone field from a form also falls back to UTC.
    var $timezone {
      value = $input.timezone|first_notempty:"UTC"
    }

    db.add site {
      data = {
        created_at: "now"
        code      : $code
        name      : $name
        timezone  : $timezone
        region    : $input.region
        address   : $input.address
        lat       : $input.lat
        lng       : $input.lng
      }
    } as $site

    // A new site changes how every fleet rollup is bucketed, which is worth a row.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $auth.id
        action     : "site.create"
        entity_type: "site"
        entity_id  : $site.id
        detail     : {
          code    : $code
          name    : $name
          timezone: $timezone
          region  : $input.region
        }
        source     : "ui"
      }
    } as $audit
  }

  response = $site
  tags = ["nerve"]
  guid = "CK00T7Ux9_HUjKlg7psvhS1ghKU"
}
