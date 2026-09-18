/**
 * Test-only runtime window stub for attachment runtime-switch coverage.
 *
 * This module must be imported before `./input-store` so the store's
 * `subscribeRuntimeEndpointWillChange` registration observes a `window` and
 * actually subscribes. ES module evaluation order guarantees that: the first
 * import in the test file runs before the later `input-store` import.
 * It installs no exports consumed by production code.
 */

const events = new EventTarget()
const runtimeWindow = {
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
}

if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: runtimeWindow,
  })
}

// `switchRuntimeEndpoint` mints a URL auth token over fetch; that
// best-effort call is kept hermetic by a fetch stub scoped in
// `input-store-runtime-endpoint.test.ts` hooks (saved/restored around each
// test), not here, so this module never permanently overwrites global fetch.
