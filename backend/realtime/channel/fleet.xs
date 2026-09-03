// The fleet-wide live feed. Overview tiles and the ingest sparkline subscribe here instead of polling.
// Receive-only: the server publishes, clients never do, so private_messaging is off - there is nothing
// legitimate for one browser to say to another on a telemetry feed. public_messaging.auth is true so a
// browser must present its user JWT to subscribe; telemetry is not readable by an anonymous visitor.
// nested_channels stays on so a future "fleet/site:3" narrowing needs no new channel definition.
// auth_channel is off because "fleet" is not scoped to one user id, unlike a user:{id} channel.
// message_history is deliberately small: a reconnecting tab wants the last few events, not a replay of the firehose.
realtime_channel "fleet" {
  description = "Fleet-wide Nerve feed. Server publishes telemetry summaries plus alert and incident events; clients never publish. Events arrive with action \"event\", not \"message\"."
  active = true
  public_messaging = {active: true, auth: true}
  private_messaging = {active: false, auth: false}
  settings = {
    anonymous_clients: false
    nested_channels  : true
    message_history  : 25
    auth_channel     : false
    presence         : false
  }
}
