# Tunnels Module Documentation

## Purpose
This module contains the shared tunnel support surface for PiChamber: provider
capability metadata, tunnel types/normalization helpers, cross-platform
executable discovery, and dependency install-help metadata.

The tunnel start implementation lives in
`packages/web/server/lib/cloudflare-tunnel.js`; CLI orchestration lives in
`packages/web/bin/lib/commands-tunnel.js`.

> Wiring note: the previous service orchestration entrypoint
> (`tunnels/index.js`, `createTunnelService`) was removed as dead code — no
> runtime entrypoint registered tunnel routes or started a tunnel service.
> The remaining files are consumed by the CLI capability surface and by the
> Cloudflare tunnel provider implementation, not by a tunnel orchestration runtime.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/executable-search.js`: cross-platform executable discovery, including Windows Store app aliases. Consumed by the tunnel providers and `packages/web/server/lib/workspace/host.js`.
- `packages/web/server/lib/tunnels/install-help.js`: provider/platform install command metadata (`getTunnelDependencyInstallInfo`) for missing tunnel dependencies.
- `packages/web/server/lib/tunnels/types.js`: shared tunnel provider, mode, and intent constants plus the shared `TunnelServiceError` class.

## Public exports
- `install-help.js` → `getTunnelDependencyInstallInfo(provider, platform)`
- `executable-search.js` → `getExecutableSearchDirectories`, `createExecutableSearchEnv`, `findExecutableOnPath`, `resolveExecutableLaunchTarget`
- `types.js` → `TUNNEL_PROVIDER_CLOUDFLARE`, `TUNNEL_MODE_QUICK`, `TUNNEL_MODE_MANAGED_REMOTE`, `TUNNEL_MODE_MANAGED_LOCAL`, `TUNNEL_INTENT_EPHEMERAL_PUBLIC`, `TUNNEL_INTENT_PERSISTENT_PUBLIC`, `TunnelServiceError`

## Consumers
- `packages/web/bin/lib/cli-tunnel-capabilities.js`: provider capability metadata for CLI tunnel commands (Cloudflare only).
- `packages/web/server/lib/cloudflare-tunnel.js`: executable discovery, install-help metadata, and provider constants.
- `packages/web/server/lib/workspace/host.js`: executable discovery.

