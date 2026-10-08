# Shared Servers Module Documentation

Ownership: `packages/ui/src/components/servers/` (presentational components
+ desktop data hook) and `packages/ui/src/lib/servers/` (pure view-model +
probe deduper). Runtime-agnostic by design: nothing here imports Electron,
Capacitor, or any platform transport. Desktop-specific behavior (probing over
the Electron IPC bridge, in-place runtime switching, new windows) lives in
`useDesktopServers`; everything else consumes only `ServerListItem`.

## View-model (`lib/servers/serverViewModel.ts`)

- `ServerStatus`: one vocabulary for every surface — `checking`,
  `connected`, `reachable`, `offline`, `sign-in-required`, `update-required`,
  `update-recommended`, `incompatible`, `wrong-service`, `unknown`. Each has a
  label, tone (`SERVER_STATUS_META`), and short description.
- `probeStatusToServerStatus`: maps every desktop probe result (`ok`, `auth`,
  `update-recommended`, `incompatible`, `wrong-service`, `unreachable`) plus
  the reserved `update-required`/`reachable` outcomes. Desktop probes never
  emit the reserved pair today; they exist so version gates and unverified
  reachability (mobile) need no new vocabulary.
- `resolveQuietStatus(cached, probing)`: quiet refresh — while a probe runs,
  keep showing the last known status with a subtle indicator, never flashing
  "Checking…". An unprobed host under probe reads `checking`; otherwise
  `unknown` (never shown for a host that is being probed).
- `ServerRoute` (`local` | `lan` | `tailscale` | `relay` | `tunnel` |
  `direct`, human labels "This computer", "Local network", "Tailscale",
  "PiChamber Relay", "Tunnel", "Direct"). A relay-only server yields one
  `{ kind: 'relay', address: null }` route — the `relay://` pseudo-URL never
  reaches the UI. Direct addresses classify by hostname (`.ts.net` →
  tailscale, `*.trycloudflare.com`/`*.cfargotunnel.com` → tunnel, private
  IPv4 / `.local` / `.lan` / `.home` / `.internal` → lan, else direct).
- `desktopHostToServerListItem(host, ctx)`: adapter for saved desktop hosts.
  Mixed direct+relay hosts yield both routes; the active route follows the
  last successful probe transport (`via: 'relay'`). `canEdit` is false for the
  local server and for relay-only hosts (no address to edit — re-import
  instead, matching the old servers page rule); `canRemove` is false only for
  local; `canOpenInNewWindow` is a capability flag (desktop always true —
  blocked statuses disable the affordance at render time via
  `isServerStatusBlocked`).
- Addresses arrive pre-redacted: the caller passes `redactUrl`
  (`redactSensitiveUrl` on desktop) and the adapter applies it to labels and
  route addresses, so components never handle tokens.
- `sortServerListItems`: current first, then default, then by label.
  `serverDisplayAddress`: active route address, else first route with one.

## Components (presentational, no data fetching)

- `ServerRow`: status dot, label, "Current" badge, "Default" star toggle
  (`aria-pressed`, accessible names), route chips (active highlighted;
  multi-route servers render a `radiogroup` with `role="radio"` chips driven
  by `aria-checked`, read-only until a caller passes `onSelectRoute`),
  redacted address, latency, and an actions menu (Switch/Connect, Open in new
  window when allowed, Edit, Remove with inline confirmation). Icon-only
  buttons carry accessible names; `layout="touch"` stacks chips/address with
  larger targets for narrow/mobile surfaces.
- `ServerList`: rows plus empty state.
- `AddServerDialog` (+ `AddServerDialogBody` for SSR tests): one entry point
  with "Paste a pairing link" (primary), "Scan QR code" (only when
  `canScanQr` — desktop passes false), and "Enter address manually"
  (advanced label/URL/token/headers form). Persistence and the pairing redeem
  flow stay with the caller via `onImportLink`/`onAddManual`.
- `serverHeaderDrafts.ts`: header-draft helpers shared by the manual form and
  the desktop edit dialog.

## Desktop hook (`useDesktopServers.ts`)

Single owner of desktop server data, used by both the settings servers page
and the host switcher, so status caches are shared and one probe cycle serves
both. No new polling: probe-on-open cadence is unchanged, and concurrent
probes collapse per host through `lib/servers/probeDedupe.ts`.

- Probing: direct first, relay fallback (E2EE tunnel probe for relay-only
  hosts), results settled all at once into a process-wide cache.
- CRUD + import: manual add, pairing-link import via `importDesktopHostPairing`
  (direct-then-relay race and redeem, same error strings as before), edit
  (address hosts only; changing the address drops the pinned `serverId` via
  `withEditedDesktopHostUrl`, so the new server is not rejected as
  wrong-service), delete (default falls back to local), default star.
- Switching (semantics preserved from the old switcher): Electron switches
  in place via `switchRuntimeEndpoint` acting on the cached probe (no
  re-probe), adopting the probe's live tunnel for relay switches and
  scheduling a candidate refresh afterwards; the non-Electron desktop shell
  probes then navigates; new windows open by host id for relay hosts, by URL
  otherwise.

## Mobile adoption (part 2, done)

- Adapter: `lib/servers/mobileServerViewModel.ts` —
  `mobileConnectionToServerListItem(connection, ctx)` returns a
  `ServerListItem`. Each saved candidate maps to a `ServerRoute` (direct
  candidates via `classifyDirectRoute`, so LAN/Tailscale/Tunnel each get a
  labeled route; relay candidates as `{ kind: 'relay', address: null }` —
  the `relay://` pseudo-URL never reaches the UI), one route per kind. The
  active route follows the live transport of the current connection.
  Statuses reuse the shared vocabulary through `resolveQuietStatus`:
  connected → `connected`, auth-invalid → `sign-in-required`,
  unreachable/retrying → `offline`, connecting → `checking`, unprobed →
  `unknown`, with quiet refresh while a connect is in flight. Mobile never
  probes saved rows (relay tunnels cost radio/battery), carries no latency
  signal (never renders a bogus `0ms`), has no default server, sets
  `canOpenInNewWindow: false`, keeps the direct-only `canEdit` rule, and
  sorts with `sortServerListItems` (current first).
- Hook: `apps/mobile/useMobileServers.ts` — wraps the existing mobile
  storage/transport APIs without changing their semantics (list, current,
  connect/switch through `connect(...)` with candidate racing, direct-only
  edit, remove with the drop-back-to-connect-screen fallback). Statuses
  derive from existing live signals only (active runtime connection,
  relay-mode flag, pending unlock, per-row connecting flag, recovery
  uncertainty) — no new polling. Concurrent connects to the same server
  collapse through `probeDedupe` (`mobile-connect:<id>`), so the sheet and
  the settings page share one candidate race.
- Surfaces (`apps/MobileServersManager.tsx`, shared by the quick-access
  sheet and the mobile servers settings page; `apps/MobileInstancesSurface`
  is now a thin wrapper, `apps/MobileConnectionWelcome.tsx` for first run)
  render `ServerList`/`ServerRow` with `layout="touch"`,
  `switchLabel="Connect"` (no route picking — candidate racing stays
  authoritative; chips are read-only) and the shared `AddServerDialog`
  with `canScanQr` true on Capacitor native. Scan uses the mobile QR flow,
  paste link uses the pairing-link redeem path, manual address connects by
  address (token + password-unlock included; desktop-only extra headers are
  ignored). Remove uses the row's inline confirmation. Edit keeps the
  mobile inline form (direct only). User-facing copy reads "Servers".
- Touch targets: in `layout="touch"` the row menu trigger and the default
  star are 44px and the remove confirmation buttons are at least 44px tall;
  the whole row is the Connect target. Android back closes scanner → add
  dialog → edit/password layers LIFO before the sheet/surface beneath.
- Do not edit this module's desktop hook for mobile needs — the view-model
  grows only through documented, tested additions like the mobile adapter.
