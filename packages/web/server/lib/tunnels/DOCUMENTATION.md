# Tunnels Module Documentation

## Purpose
This module contains the shared tunnel support surface for PiChamber: provider
capability metadata, tunnel types/normalization helpers, cross-platform
executable discovery, and dependency install-help metadata.

The actual tunnel start implementations live in
`packages/web/server/lib/cloudflare-tunnel.js` and
`packages/web/server/lib/ngrok-tunnel.js`; CLI orchestration lives in
`packages/web/bin/lib/commands-tunnel.js`.

> Wiring note: the previous service orchestration entrypoint
> (`tunnels/index.js`, `createTunnelService`) was removed as dead code — no
> runtime entrypoint registered tunnel routes or started a tunnel service.
> The remaining files are consumed by the CLI capability surface and by the
> tunnel provider implementations, not by a tunnel orchestration runtime.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/executable-search.js`: cross-platform executable discovery, including Windows Store app aliases. Consumed by the tunnel providers and `packages/web/server/lib/workspace/host.js`.
- `packages/web/server/lib/tunnels/install-help.js`: provider/platform install command metadata (`getTunnelDependencyInstallInfo`) for missing tunnel dependencies.
- `packages/web/server/lib/tunnels/types.js`: shared tunnel provider constants (`TUNNEL_PROVIDER_CLOUDFLARE`, `TUNNEL_PROVIDER_NGROK`).

## Public exports
- `install-help.js` → `getTunnelDependencyInstallInfo(provider, platform)`
- `executable-search.js` → `getExecutableSearchDirectories`, `createExecutableSearchEnv`, `findExecutableOnPath`, `resolveExecutableLaunchTarget`
- `types.js` → `TUNNEL_PROVIDER_CLOUDFLARE`, `TUNNEL_PROVIDER_NGROK`

## Consumers
- `packages/web/bin/lib/cli-tunnel-capabilities.js`: provider capability metadata for CLI tunnel commands.
- `packages/web/server/lib/cloudflare-tunnel.js` / `packages/web/server/lib/ngrok-tunnel.js`: executable discovery, install-help metadata, and provider constants.
- `packages/web/server/lib/workspace/host.js`: executable discovery.

