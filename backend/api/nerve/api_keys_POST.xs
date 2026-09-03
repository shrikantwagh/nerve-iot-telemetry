// Mint an ingest credential. The plaintext key exists in exactly one response body, ever: the column type hashes what is stored, so there is no path back to it afterwards - including for us.
query "api-keys" verb=POST {
  api_group = "Nerve"
  auth = "user"

  input {
    // What the key is for, e.g. "Osaka simulator" - the only thing an admin will have to recognise it by once the secret is gone.
    text name filters=trim

    // Optional tenancy pin. A site-scoped key can only register and report for devices at that site.
    int site_id? { table = "site" }

    // Free-form capability list, stored as-is for the ingest middleware to interpret.
    json scopes?
  }

  stack {
    // Role read fresh from the row, so a demotion takes effect immediately.
    db.get user {
      field_name = "id"
      field_value = $auth.id
      output = ["id", "role", "demo_account"]
    } as $user

    // Valid token, deleted account.
    precondition ($user != null) {
      error_type = "unauthorized"
      error = "The account for this token no longer exists."
    }

    // Inline rather than via the quick-start enforce_role helper, which only knows admin/member.
    precondition ($user.role == "admin") {
      error_type = "accessdenied"
      error = "Admin role required."
    }

    // The shared demo identity must never be able to mint a live ingest credential, even if someone promotes it by hand.
    precondition ($user.demo_account == false) {
      error_type = "accessdenied"
      error = "The demo account is read-only."
    }

    // Two uuids rather than one: 64 hex characters after the dashes are stripped, which puts the secret comfortably beyond guessing while using only the documented uuid generator.
    security.create_uuid as $uuid_a

    // Second half of the secret.
    security.create_uuid as $uuid_b

    // Dashes removed so the key is a single opaque token a device can put in a header without escaping.
    var $secret {
      value = ($uuid_a ~ $uuid_b)|replace:"-":""
    }

    // "nrv_" makes a leaked key recognisable in a log or a git diff, which is what makes secret scanning possible at all.
    var $plaintext_key {
      value = "nrv_" ~ $secret
    }

    // The lookup handle: the FIRST 8 CHARACTERS OF THE SECRET, not of the plaintext. Nerve/fn_api_key_auth recovers the same 8 characters from a presented key as `$raw_key|substr:4:8` (skipping the 4-character "nrv_" marker), then verifies the full plaintext against key_hash - so the prefix is deliberately not secret. These two derivations must stay in step or the indexed lookup misses and every ingest request degrades into a full-table bcrypt scan.
    var $key_prefix {
      value = $secret|substr:0:8
    }

    // key_hash receives the FULL plaintext including the nrv_ prefix; the `password` column type hashes it on write. Verification must therefore hash the whole header value, not just the secret half.
    db.add api_key {
      data = {
        created_at: "now"
        name      : $input.name
        key_prefix: $key_prefix
        key_hash  : $plaintext_key
        site_id   : $input.site_id
        created_by: $user.id
        enabled   : true
        use_count : 0
        scopes    : $input.scopes
      }
    } as $created

    // Minting a credential is the single most sensitive action on this surface, so the audit row records who and which prefix - never the secret.
    function.run "Nerve/fn_audit" {
      input = {
        user_id    : $user.id
        action     : "api_key.create"
        entity_type: "api_key"
        entity_id  : $created.id
        detail     : {name: $input.name, key_prefix: $key_prefix, site_id: $input.site_id, scopes: $input.scopes}
        source     : "ui"
      }
    } as $audit

    // Field-by-field whitelist, same reasoning as the list endpoint: $created carries key_hash and must not be returned wholesale.
    var $api_key {
      value = {
        id          : $created.id
        created_at  : $created.created_at
        name        : $created.name
        key_prefix  : $created.key_prefix
        site_id     : $created.site_id
        created_by  : $created.created_by
        enabled     : $created.enabled
        last_used_at: $created.last_used_at
        use_count   : $created.use_count
        scopes      : $created.scopes
      }
    }
  }

  response = {
    api_key: $api_key
    plaintext_key: $plaintext_key
    warning: "Copy this key now. It is shown exactly once and is stored only as a hash - it cannot be recovered or resent. If you lose it, disable this key and create another."
  }
  tags = ["nerve"]
  guid = "TCjBF-GubKcNOOEn78lvDq4zJLA"
}
