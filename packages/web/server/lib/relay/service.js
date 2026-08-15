// Private relay service: shared relay endpoint configuration.
//
// The relay host entrypoint (createRelayService: settings persistence, the
// /api/openchamber/relay/* management routes, and host lifecycle wiring) was
// removed as dead code — no runtime wired it in. What remains is the relay
// endpoint constant, which the CLI connect-url command uses so the pairing
// link points at the same relay a host would dial out to.

export const DEFAULT_RELAY_URL = 'wss://relay.openchamber.dev/ws';
