// Device authentication for the ingest group. Devices carry a hashed API key, never a user JWT, so $auth is unpopulated on every request that reaches here and must never be dereferenced.
middleware mw_api_key_auth {
  description = "Authenticates a device by its API key: derives key_prefix from the presented key, verifies it against api_key.key_hash, requires enabled == true, bumps last_used_at/use_count, and exposes the resolved key row to the endpoint as nerve_* inputs. Rejects with error_type unauthorized."

  input {
    // The invoked object's variables. On a pre-middleware this carries the endpoint's declared inputs, which is the third and last place we look for the key.
    json vars

    // Xano tells the middleware which phase it is running in. Only the pre phase authenticates.
    enum type { values = ["pre", "post"] }
  }

  stack {
    // The post phase runs after the endpoint has already been allowed to execute; re-authenticating there would only be able to reject a response, which is not a security boundary. Gate on the phase instead of assuming.
    var $enforce {
      value = ($input.type != "post")
    }

    // Documented as an object of request headers. Both shapes seen in the wild are handled below, because getting this wrong silently means "no key presented" and a blanket 401.
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
          value = (($headers|get:"x-api-key":"")|to_text)|trim
        }
      }
    }

    // Same map, canonical-case spelling, in case Xano preserves the client's casing.
    conditional {
      if (($raw_key == "") && ($headers|is_object)) {
        var.update $raw_key {
          value = (($headers|get:"X-API-Key":"")|to_text)|trim
        }
      }
    }

    // Shape 2: an array of raw "Name: value" header lines. Scanned case-insensitively rather than keyed, because the casing is the client's choice.
    conditional {
      if (($raw_key == "") && ($headers|is_array)) {
        foreach ($headers) {
          each as $line {
            // Normalised copy for the prefix test; the value is taken from the original so the key's own casing survives.
            var $line_lower {
              value = ($line|to_text)|to_lower
            }

            // Split on ":" and rejoin the tail, so a key that itself contains a colon is not truncated.
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

    // Transport 2: "Authorization: Bearer <key>". $env.$request_auth_token is a documented built-in that extracts the bearer token for us, so this path needs no header parsing at all and is the most reliable of the three.
    conditional {
      if ($raw_key == "") {
        var.update $raw_key {
          value = (($env.$request_auth_token|first_notempty:"")|to_text)|trim
        }
      }
    }

    // Transport 3: the key as a declared endpoint input. Every ingest endpoint declares `text api_key?` precisely so a device that cannot set headers still has a way in, and so the key appears in the generated OpenAPI.
    conditional {
      if ($raw_key == "") {
        var.update $raw_key {
          value = (($input.vars|get:"api_key":"")|to_text)|trim
        }
      }
    }

    // CONVENTION: key_prefix is the first 12 characters of the plaintext key (format nrv_<8 hex>_<secret>). This is the indexed lookup that keeps auth to one bcrypt check instead of one per stored key.
    var $prefix {
      value = $raw_key|substr:0:12
    }

    // Run unconditionally: an empty prefix simply matches nothing, and branching around it would put $candidate out of scope for the verification below.
    db.query api_key {
      where = $db.api_key.key_prefix == $prefix && $db.api_key.enabled == true
      return = {type: "single"}
      output = ["id", "created_at", "name", "key_prefix", "key_hash", "site_id", "created_by", "enabled", "use_count", "scopes"]
    } as $candidate

    // The authenticated key row, or null. Null is the only rejection signal; nothing below trusts $candidate on its own.
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

    // Safety net for the prefix convention: if the admin endpoint that mints keys stores a differently-shaped key_prefix, the fast path above misses every time and ingest dies silently. Verifying against the remaining enabled keys keeps the convention a performance detail rather than a correctness dependency. Only reached on a miss, and only when something key-shaped was actually presented.
    conditional {
      if (($key == null) && (($raw_key|strlen) >= 8)) {
        db.query api_key {
          where = $db.api_key.enabled == true && $db.api_key.key_prefix != $prefix
          return = {type: "list"}
          output = ["id", "created_at", "name", "key_prefix", "key_hash", "site_id", "created_by", "enabled", "use_count", "scopes"]
        } as $other_keys

        foreach ($other_keys) {
          each as $other {
            // Short-circuit by hand: the loop has no break, and bcrypt is expensive enough that re-checking after a match would be the dominant cost of the request.
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

    // Collapsed into one boolean so the rejection reads as a precondition with the error_type the contract asks for, while still letting the post phase through untouched.
    var $authorized {
      value = ($key != null) || ($enforce == false)
    }

    // Deliberately says nothing about which of the three checks failed - prefix, hash or enabled flag - so the response is not an oracle for probing keys.
    precondition ($authorized) {
      error_type = "unauthorized"
      error = "Invalid or disabled device API key. Present it as the x-api-key header, as an Authorization bearer token, or as the api_key input."
    }

    // Usage accounting doubles as the "is this device still talking to us" signal in the admin key list.
    conditional {
      if ($key != null) {
        db.edit api_key {
          field_name = "id"
          field_value = $key.id
          data = {
            last_used_at: "now"
            use_count   : ($key.use_count|first_notnull:0) + 1
          }
        } as $bumped
      }
    }

    // Built with |get: rather than dotted access because $key is legitimately null on the post phase, and a null deref here would fail every response.
    var $merged {
      value = {}
    }

    // nerve_ prefixed so a merge into the endpoint's input namespace cannot shadow a declared input.
    var.update $merged {
      value = $merged|set:"nerve_api_key_id":($key|get:"id":null)
    }

    // The tenancy anchor a scoped ingest endpoint would filter on; null means the key is fleet-wide.
    var.update $merged {
      value = $merged|set:"nerve_site_id":($key|get:"site_id":null)
    }

    // Carried so an audit row can name the key that acted without a second lookup.
    var.update $merged {
      value = $merged|set:"nerve_key_name":($key|get:"name":null)
    }
  }

  response = $merged
  response_strategy = "merge"
  exception_policy = "critical"
  tags = ["nerve"]
}
