# Runtime API And Parity

## Extending `RuntimeAPIs`

1. Add or extend the shared interface in `packages/ui/src/lib/api/types.ts`.
2. Implement web behavior under `packages/web/src/api/*` and compose it in `packages/web/src/api/index.ts`.
3. Keep Electron shared through the web runtime unless behavior is inherently native.
4. Register APIs through app entrypoints and consume via `RuntimeAPIProvider` hooks.

React components use `useRuntimeAPIs()`. Non-React modules use `getRegisteredRuntimeAPIs()` only when hooks are impossible. Do not introduce direct reads of the legacy runtime global `window.__PICHAMBER_RUNTIME_APIS__` in feature code.

## Electron Boundary

Electron normally reuses the web runtime/server implementation. Keep privileged shell behavior behind main/preload IPC and local-page gates.

- API base and shell identity may be broadly available for routing.
- Client tokens, home paths, filesystem/shell access, and privileged IPC remain local-page gated.
- Do not trust arbitrary loopback, `file://`, or `about:blank` origins as packaged UI.
- Remote pages and preview iframes must not gain local host privileges.
- Deep links that import hosts, store credentials, or switch runtimes require explicit in-app confirmation before mutation.

## Shared Contract Rule

For every shared capability, decide web, Electron, hosted-mobile, and Capacitor behavior explicitly. A stable unsupported response is acceptable; accidental fallthrough is not.
