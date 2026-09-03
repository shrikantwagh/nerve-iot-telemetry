// Device authentication by API key, as a custom function.
//
// This began as a pre-middleware, which is the better design - one enforcement point that
// an endpoint author cannot forget. Xano gates middleware behind a paid plan
// ("Please upgrade to access middleware" on import), which would make this repository
// impossible to stand up on a Free instance. Custom functions have no such gate, so
// enforcement moved here and every ingest endpoint calls it as its first stack step.
//
// The cost of the move is that it is now opt-in per endpoint: a new ingest endpoint that
// forgets this call is unauthenticated. That is a real regression against the middleware
// version, so it is stated here rather than buried.
//
// $auth is never populated on this path - devices carry hashed keys, not user JWTs - so
// nothing here may dereference it.
function "Nerve/fn_api_key_auth" {
  description = "Authenticates a device by its API key: finds the key by prefix, verifies the plaintext against key_hash, requires enabled == true, records usage, and returns the resolved key. Throws unauthorized when the key is absent, wrong or disabled."

  input {
    // Explicit fallback transport. Checked last, after the headers, so a device that
    // cannot set headers still has a way in and the key shows up in the OpenAPI spec.
    text api_key?
  }

  stack {
    // VERIFIED AGAINST THE LIVE INSTANCE: this path does not work here.
    //
    // $env.$http_headers is the documented accessor (it appears in the language
    // server's own CORS example), but on this Xano version a custom request header does
    // not surface through it. Tested x-api-key, X-Api-Key, api-key and api_key against
    // the deployed endpoint - all four returned 401, while the bearer-token and declared
    // -input transports below both authenticated the same key successfully.
    //
    // The block is kept because it costs one comparison and may work on another Xano
    // version, but nothing should DEPEND on it: Authorization: Bearer is the documented
    // transport for Nerve, and it is built on $env.$request_auth_token, a first-class
    // built-in rather than header introspection.
    var $headers {
      value = $env.$http_headers
    }

    // Accumulates the plaintext key from whichever transport carried it.
    var $raw_key {
      value = ""
    }

    // Shape 1, the documented one: a lowercase-keyed header map.
    conditional {
      if ($headers|is_object) {
        var.update $raw_key {
          value = (($headers|get:"x-api-key"|first_notempty:"")|to_text)|trim
        }
      }
    }

    // Same map, canonical-case spelling, in case Xano preserves the client's casing.
    conditional {
      if (($raw_key == "") && ($headers|is_object)) {
        var.update $raw_key {
          value = (($headers|get:"X-API-Key"|first_notempty:"")|to_text)|trim
        }
      }
    }

    // Shape 2: an array of raw "Name: value" lines. Scanned case-insensitively rather
    // than keyed, because the casing is the client's choice.
    conditional {
      if (($raw_key == "") && ($headers|is_array)) {
        foreach ($headers) {
          each as $line {
            // Normalised copy for the prefix test; the value is taken from the original
            // so the key's own casing survives.
            var $line_lower {
              value = ($line|to_text)|to_lower
            }

            // Split on ":" and rejoin the tail, so a key containing a colon is not
            // truncated.
            conditional {
              if ($line_lower|starts_with:"x-api-key:") {
                var.update $raw_key {
                  value = ((($line|to_text)|split:":")|slice:1|join:":")|trim
                }
              }
            }
          }
        }
      }
    }

    // Transport 2: "Authorization: Bearer <key>". $env.$request_auth_token is a
    // documented built-in that extracts the bearer token, so this path needs no header
    // parsing and is the most reliable of the three.
    conditional {
      if ($raw_key == "") {
        var.update $raw_key {
          value = (($env.$request_auth_token|first_notempty:"")|to_text)|trim
        }
      }
    }

    // Transport 3: the declared input.
    conditional {
      if ($raw_key == "") {
        var.update $raw_key {
          value = (($input.api_key|first_notempty:"")|to_text)|trim
        }
      }
    }

    // CONVENTION, and it must match api-keys_POST exactly or the indexed lookup misses
    // every time and every request degrades into the full-table bcrypt scan below.
    // The minting endpoint stores `$secret|substr:0:8` - the first 8 characters of the
    // secret, NOT of the plaintext - and the plaintext is "nrv_" ~ $secret. So the same
    // handle is recovered from the presented key by skipping the 4-character "nrv_"
    // marker and taking 8 characters (substr is start:length). table/api_key.xs says
    // "First 8 chars", which is the authority here.
    var $prefix {
      value = $raw_key|substr:4:8
    }

    // Run unconditionally: an empty prefix matches nothing, and branching around it
    // would put $candidate out of scope for the verification below.
    db.query api_key {
      where = $db.api_key.key_prefix == $prefix && $db.api_key.enabled == true
      return = {type: "single"}
      output = ["id", "created_at", "name", "key_prefix", "key_hash", "site_id", "created_by", "enabled", "use_count", "scopes"]
    } as $candidate

    // The authenticated key row, or null. Null is the only rejection signal.
    var $key {
      value = null
    }

    // A matching prefix is not authentication - the secret still has to hash to key_hash.
    conditional {
      if ($candidate != null) {
        security.check_password {
          text_password = $raw_key
          hash_password = $candidate.key_hash
        } as $prefix_ok

        conditional {
          if ($prefix_ok == true) {
            var.update $key {
              value = $candidate
            }
          }
        }
      }
    }

    // Safety net for the prefix convention: if the minting endpoint ever stores a
    // differently shaped key_prefix, the fast path misses every time and ingest dies
    // silently. Verifying against the remaining enabled keys keeps the convention a
    // performance detail rather than a correctness dependency. Only reached on a miss,
    // and only when something key-shaped was actually presented.
    conditional {
      if (($key == null) && (($raw_key|strlen) >= 8)) {
        db.query api_key {
          where = $db.api_key.enabled == true && $db.api_key.key_prefix != $prefix
          return = {type: "list"}
          output = ["id", "created_at", "name", "key_prefix", "key_hash", "site_id", "created_by", "enabled", "use_count", "scopes"]
        } as $other_keys

        foreach ($other_keys) {
          each as $other {
            // Short-circuit by hand: foreach has no break, and bcrypt is expensive
            // enough that re-checking after a match would dominate the request.
            conditional {
              if ($key == null) {
                security.check_password {
                  text_password = $raw_key
                  hash_password = $other.key_hash
                } as $other_ok

                conditional {
                  if ($other_ok == true) {
                    var.update $key {
                      value = $other
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Deliberately says nothing about WHICH check failed - prefix, hash or enabled flag
    // - so the response is not an oracle for probing keys.
    precondition ($key != null) {
      error_type = "unauthorized"
      error = "Invalid or disabled device API key. Present it as an Authorization: Bearer header (recommended) or as the api_key request field."
    }

    // Usage accounting doubles as the "is this device still talking to us" signal in the
    // admin key list.
    db.edit api_key {
      field_name = "id"
      field_value = $key.id
      data = {
        last_used_at: "now"
        use_count   : ($key.use_count|first_notnull:0) + 1
      }
    } as $bumped
  }

  // site_id is the tenancy anchor a scoped ingest endpoint filters on; null means the
  // key is fleet-wide.
  response = {
    api_key_id: $key.id
    site_id   : $key.site_id
    key_name  : $key.name
    scopes    : $key.scopes
  }
  tags = ["nerve"]
  guid = "s1WrxxYJ-u1_qr-1HpbShTejrJ4"
}
