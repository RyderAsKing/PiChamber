# Remote Access Settings Documentation

## Ownership

- `RemoteAccessPage.tsx`: page assembly — Ways to connect (LAN + Tailscale),
  Devices with access, Security (desktop password or web password state),
  passkeys, and the Add-a-device dialog.
- `LocalNetworkRouteRow.tsx`: desktop LAN toggle (local origin) or web
  read-only LAN status from pairing transports.
- `TailscaleRouteRow.tsx` + `tailscaleViewModel.ts` +
  `useTailscaleAccessState.ts`: Tailscale Off/Private/Public row.
- `DevicesSection.tsx` + `useRemoteDevicesState.ts`: paired devices and
  pending pairings.
- `AddDeviceDialog.tsx` + `useAddDeviceState.ts` + `addDeviceViewModel.ts`:
  one pairing session covering every available route.
- `DesktopLanAccessSettings.tsx` + `useDesktopLanAccessState.ts`: desktop LAN
  toggle (Ways to connect) and desktop UI password (Security), one draft.
- `@/lib/tailscale.ts`: `runtimeFetch` client for
  `/api/pichamber/tailscale/*` (all runtimes, no cached base URL).

## State hooks

- `useTailscaleAccessState`: initial load + polling (fast ~2s while
  starting/needs-approval, slow ~15s otherwise, paused while hidden),
  generation-guarded mutations reconciling to the authoritative PUT/POST
  response. A failed fetch preserves prior state and surfaces distinctly.
- `useAddDeviceState`: creating → ready ⇄ expired → succeeded; closing
  without success cancels the pending session server-side.
- `useRemoteDevicesState`: paired + pending lists with scoped reload.
- `useDesktopLanAccessState`: desktop LAN/password draft with one
  save-and-restart flow.

## View models

- `presentTailscaleStatus(status)`: status → pill/tone/headline/actions.
  Prerequisites derive from `installed`/`running`/`loggedIn` regardless of
  `state`, so `off` + not-installed renders Not installed, never Off.
- `isTailscaleModeAllowed(status, mode)`: per-mode server `authGate`
  (`privateAllowed`/`publicAllowed`); missing gate allows both.
- `requiresPublicConfirm(current, target)`: Public needs confirmation when
  switching on from Off/Private.
- `addDeviceViewModel`: single-session input, loopback-only detection, route
  chips, countdown formatting/announcement, phase derivation.

## Invariants

- No QR without a reachable route: loopback-only transports show the
  "can't reach this computer yet" callout (pointing at Ways to connect),
  never a loopback QR.
- Public needs confirmation every time it is switched on from Off/Private.
- Fetch failure ≠ off: null status renders Checking…/Unknown with retry,
  never the Off pill or an empty device list.
- One failed entity never clears unrelated state (per-directory device
  handling, per-mode Tailscale gating, generation-guarded async).
- Mutations always give visible feedback: Saving… while in flight, then the
  authoritative status or an inline `role="alert"` error with the server
  code (403/422/network mapped to readable copy).
- Auth is core-enforced (`checkTailscaleAuthGate` in
  `packages/web/server/lib/tailscale/`), never UI-only; the UI additionally
  disables disallowed modes up front with "Set a UI password first".
