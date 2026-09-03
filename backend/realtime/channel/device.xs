// Per-device live feed, one channel per device id: device:1, device:42. The device-detail chart and the command console subscribe to exactly the one they are showing.
realtime_channel "device:*" {
  description = "Per-device Nerve feed (device:<id>). Server publishes full telemetry readings, z-scores and command acknowledgements; clients never publish. Events arrive with action \"event\", not \"message\"."
  active = true

  // Receive-only, JWT required. A device id is guessable, so the auth gate is what stops one tenant's tab from tailing another's readings.
  public_messaging = {active: true, auth: true}

  // Nothing a browser needs to say on a telemetry channel.
  private_messaging = {active: false, auth: false}

  // nested_channels off: device:12 must not silently receive device:123's traffic. auth_channel is off because the id in the channel name is a device, not a user, so Xano's user-channel binding does not apply. History is deeper than the fleet channel's because a reconnecting chart wants enough points to redraw.
  settings = {
    anonymous_clients: false
    nested_channels  : false
    message_history  : 50
    auth_channel     : false
    presence         : false
  }
}
