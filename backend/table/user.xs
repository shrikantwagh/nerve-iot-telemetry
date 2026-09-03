// Stores user information and allows the user to authenticate against
//
// Extended from the Xano quick-start template for Nerve: the role enum carries the three
// roles the app actually gates on, and the demo_account flag marks the read-only account
// the one-click demo login issues tokens for.
table user {
  auth = true

  schema {
    int id
    timestamp created_at?=now
    text name filters=trim
    email? email filters=trim|lower
    password? password filters=min:8|minAlpha:1|minDigit:1

    // admin   - full control, including API keys and device deletion
    // operator - can ack alerts, issue commands, edit rules
    // viewer  - read-only
    enum role?=viewer {
      values = ["admin", "operator", "viewer"]
    }

    object password_reset? {
      schema {
        password token?
        timestamp? expiration?
        bool used?
      }
    }

    // Hex colour for the avatar chip, so operators are distinguishable in the UI.
    text avatar_color? filters=trim
    timestamp? last_login_at?

    // Marks the shared demo account. Endpoints that mutate refuse it, so a judge poking
    // at the live demo cannot delete the fleet.
    bool demo_account?=false
  }

  index = [
    {type: "primary", field: [{name: "id"}]}
    {type: "btree", field: [{name: "created_at", op: "desc"}]}
    {type: "btree|unique", field: [{name: "email", op: "asc"}]}
    {type: "btree", field: [{name: "role"}]}
  ]

  tags = ["xano:quick-start", "nerve"]
  guid = "v2BpspxVWHkKaLy-e_B4r4cjcuk"
}
