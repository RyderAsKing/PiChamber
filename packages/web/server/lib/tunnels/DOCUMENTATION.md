# Tunnels module documentation

## Purpose

This module contains the shared tunnel support surface for PiChamber: provider
capability metadata, tunnel types and normalization helpers, cross-platform
executable discovery, and dependency install-help metadata.

The Cloudflare provider implementation lives in
`packages/web/server/lib/cloudflare-tunnel.js`. The server-owned lifecycle is
`packages/web/server/lib/server/tunnel-service.js`, and CLI orchestration lives
in `packages/web/bin/lib/commands-tunnel.js`.

`startWebUiServer` creates the tunnel service and registers its authenticated
routes. Tunnel startup is intentionally separate from `pichamber serve` startup:
use `pichamber tunnel start` after the server is running.

## Entrypoints and structure

- `executable-search.js` discovers provider executables across platforms,
  including Windows Store app aliases. The workspace host and tunnel providers
  use it.
- `install-help.js` provides provider and platform install guidance for missing
  dependencies.
- `types.js` defines provider, mode, intent, and `TunnelServiceError` values.
- `../cloudflare-tunnel.js` starts Cloudflare Quick, Managed Remote, and Managed
  Local children and reports their public hostname.
- `../server/tunnel-service.js` owns one active child, token storage, public URL
  state, and tunnel-auth registration.

## Public exports

- `install-help.js` → `getTunnelDependencyInstallInfo(provider, platform)`
- `executable-search.js` → `getExecutableSearchDirectories`,
  `createExecutableSearchEnv`, `findExecutableOnPath`,
  `resolveExecutableLaunchTarget`
- `types.js` → `TUNNEL_PROVIDER_CLOUDFLARE`, `TUNNEL_MODE_QUICK`,
  `TUNNEL_MODE_MANAGED_REMOTE`, `TUNNEL_MODE_MANAGED_LOCAL`,
  `TUNNEL_INTENT_EPHEMERAL_PUBLIC`, `TUNNEL_INTENT_PERSISTENT_PUBLIC`,
  `TunnelServiceError`

## Consumers

- `packages/web/bin/lib/cli-tunnel-capabilities.js` provides Cloudflare
  capability metadata to the CLI.
- `packages/web/bin/lib/commands-tunnel.js` validates flags, presents prompts,
  and calls the server lifecycle routes.
- `packages/web/server/index.js` creates the tunnel service and registers the
  authenticated routes.
- `packages/ui/src/components/sections/pichamber/tunnel/` renders status,
  setup, profiles, and one-time connect links.
- `packages/electron/main.mjs` reads tunnel status for native quit-risk UI.
