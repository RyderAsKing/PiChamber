---
name: ui-api-decoupling
description: Use when creating or modifying PiChamber shared UI data access, Pi APIs, `RuntimeAPIs`, runtime fetch/auth/URLs, authenticated browser assets, bridges/proxies, runtime switching, or server API routes.
---

# UI API Decoupling

## Core Boundary

- Pi session, provider, resource, and daemon capabilities use `piClient` and explicit `/api/pi/*` routes.
- PiChamber-owned HTTP capabilities use `RuntimeAPIs` where runtime-specific behavior exists, otherwise explicit routes through `runtimeFetch`.
- Browser/realtime consumers use shared runtime URL/socket helpers.
- Shared UI never hardcodes localhost, ports, API origins, credentials, or one runtime's transport assumptions.

## Classify First

| Need | Correct path |
|---|---|
| Pi daemon/session/provider capability | `piClient` |
| PiChamber HTTP route | `runtimeFetch('/api/...')` |
| Runtime-owned capability | Extend `RuntimeAPIs` and implement each applicable runtime |
| Browser-owned authenticated URL | Runtime URL resolver and scoped URL auth |
| SSE/WebSocket | Owning realtime transport; also load `relay-transport` |

## Load References By Task

| Task | Required reference |
|---|---|
| Iframes, downloads, raw images, object URLs, URL tokens, preview proxy/subresources | `references/browser-assets-and-auth.md` |
| Adding runtime capabilities, Electron privilege/security, unsupported runtime behavior | `references/runtime-parity.md` |
| Locating implementations, route registration, runtime switching, or focused tests | `references/implementation-map.md` |

Load every matching reference before editing.

## Mandatory Rules

1. **Use the Pi facade for Pi APIs.** Keep request and response parsing in `piClient`; do not recreate Pi requests in components or stores.
2. **Keep PiChamber routes explicit.** Pi session state and actions live under `/api/pi/*`.
3. **Use runtime APIs for runtime-owned capabilities.** Components consume hooks/providers, not runtime globals.
4. **Resolve runtime state at call time.** Do not cache runtime base URLs, resolver output, credentials, or clients across endpoint switches.
5. **Let transport own auth.** HTTP uses runtime bearer handling; browser/realtime URLs use scoped short-lived URL auth where headers are impossible.
6. **Never put long-lived client credentials in URLs.** Do not manually append URL tokens.
7. **Define runtime parity explicitly.** Shared UI needs deliberate web, Electron, hosted-mobile, and Capacitor behavior or stable unsupported responses.
8. **Authoritative fetches must signal failure.** Do not convert failure into a valid empty value that callers use to clear state.
9. **Keep privileges at the native/runtime boundary.** UI visibility and prompts are not authorization.
10. **Confirm trust-boundary mutations.** Host imports, credential writes, privileged deep links, and runtime switching require explicit user intent.

## HTTP Decision Rules

Pass route paths directly to `runtimeFetch`:

```ts
await runtimeFetch('/api/pi/runtime');
await runtimeFetch('/api/pi/ui-settings');
await runtimeFetch('/api/fs/raw', { query: { path } });
```

Use the runtime URL resolver only when a browser/realtime API itself consumes the URL:

```ts
const iframeSrc = getRuntimeUrlResolver().authenticatedAsset('/api/preview/frame');
const eventUrl = getRuntimeUrlResolver().sse('/api/pi/events');
```

Plain `fetch` is reserved for intentional external origins that are not the active PiChamber runtime.

## Runtime Switch Safety

Review runtime base URL, auth, Pi clients, terminal/realtime transports, stores, session memory, and caches. Key caches by runtime identity where IDs, paths, or URLs can collide. Reset or reconnect affected state through the established runtime-switch flow.

## Common Anti-Patterns

| Avoid | Use |
|---|---|
| Raw feature `fetch` to Pi routes | `piClient` |
| Component reads runtime globals | `useRuntimeAPIs()` / provider |
| Hardcoded runtime URL | `runtimeFetch` or runtime URL resolver |
| Browser URL containing bearer/client token | Scoped URL-auth helper |
| Web-only shared route | Explicit mobile/Electron decision |
| Returning `[]` after authoritative fetch failure | Throw or distinct failure result |

## Verification

- Pi calls use `piClient` and `/api/pi/*`.
- Request fidelity, auth, abort, query, and body behavior are tested.
- Browser/realtime auth uses narrow allowlists and scoped tokens.
- Every applicable runtime has implementation or explicit unsupported behavior.
- Runtime switching cannot reuse stale endpoint/auth/cache state.
- Privileged Electron behavior is enforced outside the renderer.
- Focused transport, bridge, auth, and runtime tests pass; static type/lint checks alone are insufficient.
