# PiChamber Pi Migration: Workstream 0 Boundary Record

## Status and scope

This is the Workstream 0 implementation record for the approved [Pi migration plan](./pichamber-pimigration.md). It records the migration boundary, names the new Pi-owned surfaces, and captures the current OpenCode dependency inventory. The Week 0 disposable-environment spike is complete; its successor daemon-lifecycle work is recorded separately. Neither creates a releasable dual-runtime path.

The spike adds the reviewed, exactly pinned Pi SDK only to `@pichamber/web`, its direct consumer. It does not add Pi code to an OpenCode module or expose a browser-facing daemon listener.

## Decisions

| Decision | Record |
| --- | --- |
| Runtime architecture | Pi SDK inside a PiChamber-owned private session daemon; never a browser-facing listener. |
| Server ownership | New daemon code belongs in `packages/web/server/lib/pi/session-daemon/`; no Pi behavior is added to `packages/web/server/lib/opencode/`. |
| Shared UI ownership | New Pi API client/types/reducer helpers belong in `packages/ui/src/lib/pi/`; Pi session bootstrap/reconnect/reduction remains under `packages/ui/src/sync/`. |
| Existing transport | `runtimeFetch`, runtime URL/auth/switching, and the PiChamber realtime carrier remain PiChamber-owned transport. They are not OpenCode compatibility layers and are retained until deliberately replaced by the Pi API contract. |
| Public API cutover | Pi session APIs use the `/api/pi/` namespace. No OpenCode endpoint or event-name alias is added. |
| Release policy | There is no engine selector and no supported OpenCode/Pi dual-runtime UI. A short-lived isolated spike is allowed, but is not a releasable code path. |

## Pi SDK review and dependency gate

The approved spike adds `@earendil-works/pi-coding-agent` **`0.84.1`** exactly to `packages/web/package.json`; Bun resolved its lockfile entry. `bun pm view @earendil-works/pi-coding-agent version --json` reported `0.84.1` as the latest stable version at review time.

| Review item | Evidence |
| --- | --- |
| License | MIT |
| Engine | Node `>=22.19.0`; PiChamber's Node `>=22` contract and the development runtime (Node `26.5.0`) satisfy it. |
| SDK surface used | `createAgentSessionRuntime`, `createAgentSessionServices`, `createAgentSessionFromServices`, `SessionManager`, and `getAgentDir`. |
| Runtime behavior | Creates a persistent Pi session for the selected cwd and agent directory; Pi extensions are disabled explicitly for the core milestone. |
| Disposable smoke result | A temporary cwd and `agentDir` created a Pi SDK session and authenticated over a temporary Unix socket with `PI_OFFLINE=1`; no developer credentials or sessions were read. |

Every 0.x minor upgrade remains a potentially breaking change: review the exact release, SDK surface, Node requirement, and this module's disposable-runtime validation before updating the exact version. The existing `@opencode-ai/sdk` convention is likewise exact pins; Pi must never use a version range.

## Final Pi-native naming

These names are the target contract for Workstreams 1–4. An implementation may add fields to a versioned payload, but must not rename these surfaces or create OpenCode compatibility aliases.

### Public server routes

The authenticated web-server API is the only browser-visible boundary. It translates requests to the private daemon; clients never receive the daemon endpoint or credential.

| Surface | Canonical route(s) |
| --- | --- |
| Runtime health/capabilities | `GET /api/pi/runtime` |
| Projects | `GET /api/pi/projects`, `POST /api/pi/projects/select` |
| Session collection | `GET /api/pi/sessions`, `POST /api/pi/sessions` |
| Session state | `GET`, `PATCH`, and `DELETE /api/pi/sessions/:sessionId`; `GET /api/pi/sessions/:sessionId/snapshot` |
| Session operations | `POST /api/pi/sessions/:sessionId/{prompt,steer,follow-up,abort,model,thinking,compact,fork,clone}` |
| Providers | `GET /api/pi/providers`, `GET /api/pi/providers/:providerId/status`, `POST /api/pi/providers/:providerId/{login,logout}`, `PUT /api/pi/providers/:providerId/models` |
| Native resources | `GET /api/pi/resources` |
| Attachments | `POST /api/pi/attachments` |
| Sequenced realtime events | `GET /api/pi/events` |

`/api/pi/events` is the public event stream. Its reconnect cursor is a sequence number, and a client obtains a snapshot before treating any reconnect state as authoritative. The public API is intentionally versioned by its JSON payload `protocolVersion`; a `/v1` path segment is not introduced during the first cutover.

### Private daemon IPC

The daemon protocol is a versioned JSON request/response/event envelope with these fixed top-level fields:

```text
protocolVersion, requestId, kind, command | event, payload
```

`kind` is `request`, `response`, or `event`. Responses carry either `result` or a stable error object containing `code`; diagnostics must not include credentials, pairing material, attachment bytes, or prompt/transcript content.

Canonical command names:

```text
runtime.health
projects.list
projects.select
sessions.list
sessions.create
sessions.open
sessions.rename
sessions.delete
sessions.tree
sessions.navigate
sessions.fork
sessions.clone
sessions.prompt
sessions.steer
sessions.followUp
sessions.abort
sessions.setModel
sessions.setThinking
sessions.compact
providers.list
providers.status
providers.login
providers.logout
providers.setModels
resources.list
attachments.create
```

Canonical event names:

```text
session.snapshot
session.lifecycle
assistant.message.start
assistant.message.delta
assistant.message.end
assistant.thinking.delta
session.tool.start
session.tool.update
session.tool.end
session.queue
session.model
session.thinking
session.compaction
session.error
session.interrupted
```

Every session event includes `sessionId` and a monotonically increasing `sequence`. A snapshot includes the last incorporated `sequence`. `DAEMON_UNAVAILABLE` is an explicit error, never an empty session list or idle state.

### Daemon endpoints and sidecars

| Item | Canonical name and invariant |
| --- | --- |
| Daemon module | `packages/web/server/lib/pi/session-daemon/` |
| POSIX endpoint | `$XDG_RUNTIME_DIR/pichamber/pi-session-daemon.sock`; when `XDG_RUNTIME_DIR` is unavailable, `$OPENCHAMBER_DATA_DIR/runtime/pi-session-daemon.sock`. The parent directory is mode `0700`; the socket is mode `0600`. |
| Windows endpoint | `\\.\pipe\pichamber-pi-session-daemon-<owner-key>`, where `owner-key` is a stable non-secret identifier derived from the current OS user. The pipe ACL is restricted to that user. |
| Daemon state | `$OPENCHAMBER_DATA_DIR/pi/session-daemon-state.json`; non-secret lifecycle/protocol metadata only. |
| Daemon lock | `$OPENCHAMBER_DATA_DIR/pi/session-daemon.lock`; serializes start/reuse/stop ownership. |
| Daemon credential | `$OPENCHAMBER_DATA_DIR/pi/session-daemon.key`; generated locally, mode `0600`, read only by the PiChamber server and daemon, never exposed to the browser or logs. |
| Archive sidecar | `$OPENCHAMBER_DATA_DIR/pi/session-archive.json`; PiChamber-only archive metadata keyed by Pi session identity/path. It never edits Pi JSONL. |

Stale endpoint, state, and lock cleanup must verify daemon identity before removal. A crash during cleanup must leave a visible unavailable/interrupted state rather than fabricate an empty bootstrap.

### Environment variables

| Variable | Status and meaning |
| --- | --- |
| `OPENCHAMBER_DATA_DIR` | Retained PiChamber data-root variable; owns the PiChamber sidecars above, not Pi credentials or JSONL sessions. |
| `OPENCHAMBER_PI_AGENT_DIR` | New optional server-only override for the Pi agent directory. Its default is Pi's normal `~/.pi/agent` discovery. It is intended for controlled deployments and disposable tests; it is never returned to browsers. |
| `OPENCHAMBER_PI_SESSION_DAEMON_ENDPOINT` | New optional server-only local-endpoint override for controlled tests and supervised deployments. Values must resolve to a local Unix socket or Windows named pipe; TCP URLs are invalid. |

No PiChamber variable carries a daemon credential. Provider environment variables remain subject to Pi's normal provider resolution and are not copied into PiChamber configuration.

All `OPENCODE_*` variables and the OpenCode-specific `OPENCHAMBER_*` variables in the inventory below are deletion targets, not names to translate mechanically. Retained generic PiChamber variables keep their existing names unless a separate product-identity migration explicitly changes them.

## Current OpenCode inventory

This is a baseline for deletion and port planning, not a compatibility commitment. Counts are repository-search snapshots; the path groups identify the owning migration workstream. The complete implementation inventory must be refreshed before any deletion batch.

### SDK and shared UI data shapes

- **184 direct import sites** currently import `@opencode-ai/sdk` from source/test files under `packages/`; another **10 package/config/documentation sites** reference the dependency string.
- The primary runtime facade is `packages/ui/src/lib/opencode/client.ts` (`OpencodeService`). The migration replaces it with Pi-native modules rather than adapting its types or endpoint names.
- The primary event reduction owner is `packages/ui/src/sync/event-reducer.ts`; the remaining session bootstrap, stream, cache, ordering, and optimistic-flow consumers are in `packages/ui/src/sync/`.
- OpenCode SDK data shapes also reach UI hooks, stores, message rendering, sidebar/session components, mobile apps, review/worktree flows, and their tests. `rg -l '@opencode-ai/sdk' packages` is the authoritative file list for this snapshot.
- Direct runtime SDK clients outside the shared facade currently include `packages/web/server/lib/openchamber-sessions/routes.js`, `packages/web/server/lib/openchamber-control/service.js`, `packages/web/server/lib/scheduled-tasks/runtime.js`, and `packages/web/server/lib/opencode/skill-routes.js`.

### OpenCode process and server ownership

- `packages/web/server/lib/opencode/` is the current process lifecycle, environment/configuration, proxy, watcher, SSE, update, route, settings, provider, snippets, skill, and OpenCode event ownership boundary. Its full entrypoint/export inventory is documented in [`packages/web/server/lib/opencode/DOCUMENTATION.md`](../packages/web/server/lib/opencode/DOCUMENTATION.md).
- `packages/web/server/index.js` is the current composition root that wires the managed OpenCode lifecycle, proxy/event paths, session service, and control service.
- `packages/electron/scripts/prepare-opencode-cli.mjs`, `verify-opencode-cli.mjs`, and `verify-linux-appimage.mjs`, plus the OpenCode CLI resources they stage, are OpenCode-binary deletion targets.
- `packages/web/vite.config.ts` contains OpenCode SDK alias/vendor-chunk configuration and is a cutover consumer.
- `packages/web/server/lib/system-prompt/` and its managed-launch injection path, plus `packages/web/server/lib/session-assist/` and its UI/settings consumers, were removed as OpenCode-coupled features. `packages/web/server/lib/agent-tool/`, `packages/web/server/lib/scheduled-tasks/`, and their callers remain OpenCode-coupled feature removal targets; they are not Pi daemon homes.

### Existing API/event routes

| Current surface | Current owner | Disposition |
| --- | --- | --- |
| Generic `/api/*` OpenCode proxy, `/api/event`, `/api/global/event`, and session message forwarding | `packages/web/server/lib/opencode/proxy.js` | Remove; replace only the required product operations under `/api/pi/`. |
| `/api/openchamber/events` | `packages/web/server/lib/scheduled-tasks/routes.js` plus server wiring | Replace with `/api/pi/events` for Pi runtime events; preserve unrelated product notifications only through an intentional PiChamber event design. |
| `/api/openchamber/realtime-proxy/{sse,ws}` | `packages/web/server/lib/realtime-proxy.js` | Retain only as generic PiChamber transport if a Pi-native consumer still needs it; it is not the daemon protocol. |
| `/api/openchamber/sessions`, `/:sessionId/send`, `/:sessionId/fork` | `packages/web/server/lib/openchamber-sessions/routes.js` | Replace with the `/api/pi/sessions` routes above. |
| `/api/openchamber/control` and `/api/openchamber/agent-tool` | `openchamber-control/routes.js`, `agent-tool/runtime.js` | Remove: the OpenCode tool/agent-control contract is a migration non-goal. |
| `/api/openchamber/scheduled-tasks/status` | `scheduled-tasks/routes.js` | Remove: scheduled tasks and loop-file scheduling are migration non-goals. |
| `/api/openchamber/relay/{status,enable,disable}` | `relay/service.js` | Retain as PiChamber-owned relay management and port after direct Pi connections are stable. |
| `/api/openchamber/tunnel/{check,doctor,providers,status,managed-remote-token,start,stop}` | `tunnels/routes.js` | Retain as PiChamber-owned tunnel management; port after direct Pi connections are stable. |
| `/api/opencode/*` health/version/directory/upgrade and `/api/config/opencode-resolution` | `packages/web/server/lib/opencode/routes.js` | Remove. |
| `/api/config/{agents,commands,mcp,plugins}` and reload | `config-entity-routes.js`, `plugin-routes.js`, `core-routes.js` | Remove: these are explicit migration non-goals. |
| `/api/config/skills*` and catalog installer | `skill-routes.js` | Replace only with Pi native resource discovery in `/api/pi/resources`; do not port catalog copying. |
| `/api/config/snippets*` | `config-entity-routes.js` | Rebuild as Pi prompt-template operations under the Pi resource contract. |
| `/api/provider/*` and provider OAuth proxy | `opencode/routes.js`, `opencode/proxy.js` | Replace with `/api/pi/providers/*`; no raw auth material reaches a browser. |
| `/api/openchamber/models-metadata` and `/api/zen/models` | `opencode/pichamber-routes.js` | Replace with Pi model/provider discovery; do not retain the endpoint names. |
| `/api/openchamber/update-*` | `opencode/pichamber-routes.js` | Rehome under PiChamber update ownership; it is not part of the daemon protocol. |

The PiChamber-owned transport, authentication, pairing, direct connection, tunnel, relay, filesystem, terminal, and Git routes need separate per-module classification during their port work. Their `/api/openchamber/` prefix alone does not make them OpenCode-owned.

### Environment-variable baseline

The following are all currently discovered `OPENCODE_*` names and are migration deletion targets:

```text
OPENCODE_ADJECTIVES
OPENCODE_API_PREFIX
OPENCODE_BINARY
OPENCODE_BINARY_INVALID
OPENCODE_CONFIG
OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_DIR
OPENCODE_DATA_DIR
OPENCODE_DISABLE_CLAUDE_CODE
OPENCODE_DISABLE_CLAUDE_CODE_SKILLS
OPENCODE_DISABLE_EXTERNAL_SKILLS
OPENCODE_EXPERIMENTAL
OPENCODE_EXPERIMENTAL_PLAN_MODE
OPENCODE_HEALTH_PATH
OPENCODE_HEALTH_TIMEOUT_MS
OPENCODE_HOST
OPENCODE_JWT_SECRET
OPENCODE_NOUNS
OPENCODE_PATH
OPENCODE_PORT
OPENCODE_SERVER_PASSWORD
OPENCODE_SERVER_USERNAME
OPENCODE_SHUTDOWN_GRACE_MS
OPENCODE_SKIP_START
OPENCODE_UI_PASSWORD
OPENCODE_UPGRADE_IN_PROGRESS
OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER
OPENCODE_UPGRADE_UNSUPPORTED
OPENCODE_WORKTREE_ATTEMPTS
OPENCODE_WSL_DISTRO
```

These `OPENCHAMBER_*` variables are currently OpenCode-specific and are also deletion targets rather than Pi names:

```text
OPENCHAMBER_AGENT_TOOL_ACTIONS
OPENCHAMBER_AGENT_TOOL_ACTION_DEFINITIONS
OPENCHAMBER_AGENT_TOOL_TOKEN
OPENCHAMBER_AGENT_TOOL_URL
OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR
OPENCHAMBER_OPENCODE_BIN
OPENCHAMBER_OPENCODE_CLI_VERSION
OPENCHAMBER_OPENCODE_CWD
OPENCHAMBER_OPENCODE_HEALTH_CACHE_MS
OPENCHAMBER_OPENCODE_HEALTH_CONSECUTIVE_FAILURES
OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS
OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS
OPENCHAMBER_OPENCODE_HOSTNAME
OPENCHAMBER_OPENCODE_PATH
OPENCHAMBER_OPENCODE_PORT
OPENCHAMBER_OPENCODE_WSL_DISTRO
OPENCHAMBER_SKIP_OPENCODE_START
```

### Inventory refresh commands

Run these commands from the repository root before beginning a batch that removes or ports a listed surface. Review the paths, not just the count.

```bash
rg -l '@opencode-ai/sdk' packages | sort
rg -n '@opencode-ai/sdk|lib/opencode|src/lib/opencode' packages
rg -o --no-filename 'OPENCODE_[A-Z0-9_]+' packages | sort -u
rg -o --no-filename 'OPENCHAMBER_[A-Z0-9_]+' packages | sort -u
rg -n '/api/(openchamber|opencode|config|zen)' packages/web packages/ui packages/electron
find packages/web/server/lib/opencode -type f | sort
```

## Week 0 spike implementation

The completed focused spike lives in `packages/web/server/lib/pi/session-daemon/` with colocated tests. It:

1. imports the approved, exactly pinned Pi SDK and creates a persistent session using a disposable agent directory and selected cwd;
2. binds only a local Unix socket (or Windows named pipe), authenticates the private client, and creates the socket with owner-only permissions on POSIX;
3. maps Pi text and tool events to the versioned IPC envelope;
4. keeps the runtime alive while a client disconnects and sends a sequenced snapshot to the reconnecting client; and
5. rejects TCP endpoints and unauthenticated clients instead of presenting a false empty/idle state.

The spike itself did not register public routes or lifecycle supervision. The initial detached-process supervision and `GET /api/pi/runtime` adapter are now recorded in [the Workstream 1 daemon record](./pichamber-pi-workstream-1.md); session registry, operation families, queue policy, and recovery remain later work.
