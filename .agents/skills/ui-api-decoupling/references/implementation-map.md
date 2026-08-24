# Runtime Implementation Map

## Shared UI

- `packages/ui/src/lib/pi/client.ts`: Pi service facade for `/api/pi/*`.
- `packages/ui/src/lib/pi/protocol.ts`: public Pi request, response, and event contracts.
- `packages/ui/src/apps/pi-session-store.ts`: runtime-wide Pi session cluster.
- `packages/ui/src/lib/runtime-fetch.ts`: runtime HTTP URL resolution and auth.
- `packages/ui/src/lib/runtime-url.ts`: browser/realtime URL construction.
- `packages/ui/src/lib/runtime-auth.ts`: bearer state and short-lived URL-token minting.
- `packages/ui/src/lib/api/types.ts`: shared `RuntimeAPIs` contract.
- `packages/ui/src/contexts/RuntimeAPIProvider.tsx`: React provider and runtime API wrappers.
- `packages/ui/src/hooks/useRuntimeAPIs.ts`: React consumption path.

## Web And Server

- `packages/web/src/runtimeConfig.ts`: initializes runtime URL/auth and web APIs.
- `packages/web/src/api/index.ts`: composes web `RuntimeAPIs`.
- `packages/web/server/lib/pi/routes.js`: authenticated public Pi routes.
- `packages/web/server/lib/pi/session-daemon/`: Pi daemon lifecycle, IPC, and session runtime.
- `packages/web/server/lib/server/core-routes.js`: shared server route registration.
- `packages/web/server/lib/ui-auth/ui-auth.js`: session and URL-token route gates.

Pi session state and actions are served only through `/api/pi/*`.

## Runtime Switching

`packages/ui/src/lib/runtime-switch.ts` updates endpoint/auth state and emits the runtime-change event. App roots reconnect clients and reset runtime-scoped stores/transports.

Review every cache keyed only by session ID, directory, URL, or entity ID. Add runtime identity when local and remote runtimes can collide.

## Tests To Prefer

- Pi client/protocol: `packages/ui/src/lib/pi/client.test.ts`, `protocol.test.ts`
- Pi routes: `packages/web/server/lib/pi/routes.test.js`
- HTTP/request fidelity: `packages/ui/src/lib/runtime-fetch.test.ts`
- URL/auth: `packages/ui/src/lib/runtime-url.test.ts`, `runtime-auth.test.ts`
- Server auth: `packages/web/server/lib/ui-auth/ui-auth.test.js`

Also run focused tests beside new runtime implementations and validation required by each affected workspace.
