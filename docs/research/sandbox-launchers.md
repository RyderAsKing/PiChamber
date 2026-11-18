# Sandbox launchers: running Pi sessions under nono, bubblewrap, and others

Status: research (2026-11-15). Nothing is built yet. Recommendation below;
open questions for the maintainer at the end.

## Summary and recommendation

- **Unit: per project, one extra daemon per sandboxed project.** A session
  keeps its project's setting. Per-session sandboxing costs a process (about
  145 MB) per session and has no grant set of its own, since the grants are
  shaped by the folder. Leave a per-session override for later.
- **Launch the existing daemon inside the launcher.** Keep the same
  `daemon-process.js`, a separate profile key per sandbox, and its own
  credential and socket. The server routes each request to a daemon by
  directory and merges event streams. The main daemon stays exactly as it is
  today, so "off" is a no-op.
- **nono first, as `nono run` (supervised) with a PiChamber-written profile
  file.** Direct mode (`nono wrap`) is the simplest process tree, but it
  cannot run nono's network proxy. Without the proxy, the agent can reach the
  PiChamber HTTP server on loopback, and that API is unauthenticated when UI
  auth is off. That is a full escape (finding 4.1).
- **Read-only access to Pi's agent directory does not work as is.** Pi takes
  a `proper-lockfile` lock (a `mkdir` beside the file) even to *read*
  `auth.json` and `settings.json`. Without write access to the folder, Pi
  silently loads no credentials (verified). The sandboxed daemon needs a
  **shadow agent directory** that PiChamber owns: writable, holding symlinks
  or binds to the real read-only files, plus a writable bind of
  `sessions/<this project>/` and the lease directory (finding 2).
- **The sandbox boundary does not stop at the daemon.** Before calling any
  launcher safe, five things outside it must be closed (finding 4):
  1. Host loopback must be unreachable.
  2. The main daemon's credential file must be unreadable.
  3. Unsandboxed `git` that PiChamber runs in a sandboxed repo must ignore
     repo config and hooks: `core.fsmonitor` runs on `git status` (verified).
  4. Project `.pi/` and `.git/hooks` written while sandboxed must not load
     unsandboxed without re-approval.
  5. bwrap and srt need a PID namespace, because without one the sandbox
     writes host files through `/proc/<pid>/root` (verified). PiChamber's
     PID-based daemon identity and lease liveness checks then stop working.
- **Fail closed.** A project marked sandboxed whose launcher is missing or
  fails its probe gets `SANDBOX_UNAVAILABLE` on open and create. It never
  falls back to the main daemon.

## The question

Can users opt in to sandboxing Pi agents, with nono.sh first, as an easy
on/off switch that leaves sessions, listing, and live state intact? Should
the switch work per project or per session? And what generic launcher seam
lets bubblewrap, Anthropic's sandbox-runtime (srt), firejail, and later
containers and microVMs plug in?

## What PiChamber does today (verified in code)

- One server makes one supervisor:
  `createPiSessionDaemonSupervisor({ dataDir, port, version })` in
  `packages/web/server/index.js:307`. It spawns one detached daemon per server
  profile (`supervisor.js:550-571`):
  `process.execPath daemon-process.js --endpoint … --credential-file …
  --state-file … --cwd … --profile-key … --server-pid … --daemon-id …
  --agent-dir? --open-url-socket?`, with `detached: true` and stdio going to
  the per-profile log.
- Identity is PID-based throughout:
  - The daemon writes `pid: process.pid` into its state sidecar
    (`daemon-process.js:65`).
  - The supervisor requires `health.daemonPid === state.pid`
    (`supervisor.js:345`).
  - Stop sends SIGTERM to `state.pid` (`supervisor.js:469`). A startup
    timeout sends SIGTERM to `child.pid`, the spawned process
    (`supervisor.js:612`).
  - Liveness is `kill(pid, 0)` (`supervisor.js:84`).
  - The daemon checks its owner server with `kill(serverPid, 0)` before
    accepting a claim (`session-daemon.js:219`, `:4402`).
  - Session leases treat another daemon's lease as live while
    `kill(daemonPid, 0)` succeeds (`session-lease.js:98`).
- Paths come from `resolvePiSessionDaemonPaths` (`supervisor.js:131-197`):
  - per-profile files: `<dataDir>/pi/daemons/<profileKey>/` (credential,
    `daemon-state.json`, `operation.lock`)
  - socket: `$XDG_RUNTIME_DIR/pichamber/pi-daemons/<profileKey>/daemon.sock`,
    or `<dataDir>/runtime/…`
  - Open request socket: `open-url.sock` in the same folder
  - log: `<dataDir>/logs/pi-daemon-<profileKey>.log`
- Leases live under `<agentDir>/.pichamber/locks/sessions/<sha256>.json`, one
  flat folder for all projects (`session-lease.js:31-48`). Each lease has a
  `<file>.lock` beside it (cross-process lock).
- `routes.js` has 34 `getDaemonRuntime(getPiSessionDaemonRuntime)` call
  sites. Session operations pass `directory` from the query or body
  (`routes.js:1095-1111`). `/api/pi/events` opens **one** subscription
  (optionally filtered by session) with one `streamEpoch` and sequence space
  (`routes.js:1890-1950`). The UI opens one global stream
  (`packages/ui/src/lib/pi/transport.ts:94-103`). The desktop notification
  watcher holds one more subscription per supervisor
  (`lib/notifications/pi-notification-watcher.js:130`).
- `projects` is a host-local field (`ui-settings-store.js:58-59`,
  `LOCAL_FIELDS`), not portable.
- Managed worktrees live outside the project, at
  `<PICHAMBER_DATA_DIR>/worktree/<project id>/<name>/`
  (`lib/git/service.js:975`). Their `.git` file points into the main repo's
  `.git/worktrees/`, so commits write into the main repo's `.git`.
- The server runs git in project folders unsandboxed: `simple-git` and
  `execFile` (`lib/git/service.js:1-12`). It even runs the repo's
  `post-checkout` hook directly (`lib/git/service.js:1092`).
- With UI auth off, `requireAuth` calls `next()` for every request
  (`lib/ui-auth/ui-auth.js:631-633`). A request with no `Origin` header passes
  the cross-site check (`lib/ui-auth/DOCUMENTATION.md`, "Cross-site
  requests").

## Findings

### 1. nono mechanics for a long-running detached daemon

Read at nono v0.82.0 (released 2026-11-14; `crates/nono-cli/Cargo.toml`).

**Two execution modes.** `nono run` (Supervised) forks. The child is
sandboxed and the parent stays unsandboxed for audit, proxy, rollback, and
capability expansion. `nono wrap` (Direct) applies the sandbox and `exec`s, so
"nono disappears from the process tree" (`docs/cli/features/execution-modes.mdx`).
`wrap` rejects every proxy flag: `--network-profile`, `--allow-domain`,
`--credential`, `--upstream-proxy` (`docs/cli/usage/flags.mdx`, "nono wrap").
It also has no `--memory`, `--max-processes`, `--isolate`, or
`--startup-timeout` (same file).

**Process tree and PIDs.** nono creates no PID namespace. The only namespaces
it adds are net, ipc, uts, and user, under `--isolate`
(`docs/cli/usage/flags.mdx`, `--isolate`), so the daemon's `process.pid` is a
host PID:

- With `wrap`, the spawner's `child.pid` *is* the daemon.
- With `run`, `child.pid` is the nono supervisor, and the daemon is its child
  with its own host PID. That is what the daemon writes into its state
  sidecar.
- nono forwards SIGINT, SIGTERM, SIGHUP, SIGQUIT, and SIGUSR1 to the child
  (`crates/nono-cli/src/exec_strategy.rs:2310-2360`, `forward_signal`
  `:2423-2470`).
- It exits with the child's exit code (`execution_runtime.rs:851-882`).

PiChamber's stop path (IPC `runtime.shutdown`, then SIGTERM to `state.pid`)
therefore reaches the daemon directly, and nono exits after it. The only fix
needed is the startup-timeout path, which signals `child.pid`. Under `run`,
that still works because the signal is forwarded.

**Prompts without a TTY.** All three prompt paths stay quiet for a
`detached: true` child with stdin from `/dev/null`:

- *CWD sharing.* `prompt_cwd_sharing` returns "no" when stdin is not a
  terminal (`crates/nono-cli/src/output.rs:1383-1395`). With `-s/--silent`, a
  missing CWD decision is a hard error (`CwdPromptRequired`,
  `sandbox_prepare.rs:1202-1208`, `:1886`), which fails closed. Avoid the
  question entirely: pass explicit grants, or `--allow-cwd`.
- *The post-run "Save suggestions to a user profile?" grants prompt.* It runs
  only when `/dev/tty` opens read+write. `NONO_NO_SAVE_PROMPT=1` disables it
  (`profile_save_runtime.rs:239-262`). A `setsid` child (Node's `detached`)
  has no controlling terminal, so the prompt cannot appear. Set the variable
  anyway.
- *Capability elevation prompts.* These are off unless
  `--capability-elevation` is given or the profile enables it
  (`docs/cli/features/supervisor.mdx`). The Pi pack sets
  `capability_elevation: false` (`nono-packs/pi/policy.json`). Without it,
  denials are plain `EPERM`/`EACCES`.

**Other environment.** Set `NONO_NO_UPDATE_CHECK=1`
(`update_check.rs:25`, `:202`) so a daemon start makes no update request. Set
`NONO_NO_PACK_UPDATE_HINTS` to silence pack hints (constant found in
source; effect not traced).

**Flags we would use** (`docs/cli/usage/flags.mdx`):

- `--profile <path>`: a value containing `/` or ending in `.json` is read as
  a file path (`profile/mod.rs:3530-3538`).
- `--allow`, `--read`, `--write`, `--allow-file`, `--read-file`
- `--allow-unix-socket-dir-bind <dir>` for the daemon socket. Without a
  profile setting, Linux does not mediate pathname sockets; the flag only adds
  the implied write grant on the folder. Binding needs `MAKE_SOCK`, which is
  part of nono's write set (`docs/cli/internals/landlock.mdx`, "Access Rights
  Mapping").
- `--allow-domain` / `--network-profile` / `--credential` (proxy, `run` only)
- `--block-net`
- `--no-audit` or `--no-audit-integrity`
- `--no-rollback`
- `--no-diagnostics`
- `-s`

`--listen-port` takes effect only in proxy mode and the daemon does not
listen on TCP, so we never need it. `--detached` is nono's own PTY session
manager (`nono attach`, `nono ps`). It solves a different problem, and
PiChamber already detaches the daemon itself. Do not use it.

**Credential proxy lifetime.** The proxy runs in the unsandboxed supervisor
parent for the life of the `nono run` process (`docs/cli/features/networking.mdx`,
"Proxy Modes"). One daemon equals one proxy, which lives as long as the
daemon. It sets `HTTP(S)_PROXY`, and `NODE_USE_ENV_PROXY=1` only on Node 26+
(same doc). Before Node 26, Node's `fetch` ignores `HTTPS_PROXY` unless that
variable is set. Pi's provider SDKs may or may not honour the proxy, and the
daemon must be tested on the Node that PiChamber ships. *Unverified.*

**Audit for long runs.** Each `nono run` is one audit session. Events are
appended to `audit-events.ndjson` under `~/.local/state/nono/audit/` (or
`~/.nono/audit/` per the pack README). Integrity data is finalised at session
end (`docs/cli/features/audit.mdx`). A daemon that runs for days makes one
long-lived audit session with unbounded proxy events. Recommend
`--no-audit-integrity` by default and leave audit as a user choice. Whether
the event file is rotated was *not verified*.

**Rollback** snapshots once before the command and once after it exits
(`docs/cli/features/atomic-rollbacks.mdx`). One daemon serves many turns over
days, so that is useless here. Always pass `--no-rollback`. Per-turn
snapshots would be PiChamber's own job (git already covers most of it).

**Landlock ABI** (`docs/cli/internals/landlock.mdx`, kernel docs below):

| ABI | Kernel | Adds |
|---|---|---|
| v1 | 5.13 | Filesystem rules |
| v4 | 6.7 | TCP port rules |
| v6 | 6.12 | Signal and abstract Unix socket scoping |
| v9 | not mapped by nono's doc | `LANDLOCK_ACCESS_FS_RESOLVE_UNIX` |

`LANDLOCK_ACCESS_FS_RESOLVE_UNIX` is the first control over `connect(2)` to
*pathname* Unix sockets ([kernel Landlock docs](https://docs.kernel.org/userspace-api/landlock.html),
"Pathname UNIX sockets (ABI < 9)"). Below ABI 9, Landlock never restricts
connecting to a pathname socket. nono can mediate pathname sockets itself
with seccomp user notification, but only when the profile sets
`linux.af_unix_mediation: "pathname"` (`docs/cli/internals/landlock.mdx`,
"Pathname Unix Socket Mediation"). Creating a socket (`bind`) is
`LANDLOCK_ACCESS_FS_MAKE_SOCK` on the parent folder, so the daemon's runtime
folder needs a write grant.

nono's Landlock is allow-only. Deny groups are "exclusion filters" that
cannot remove a subfolder from an allowed parent (`docs/cli/features/profiles-groups.mdx`,
line 805). So `<project>/.git` cannot be made read-only inside a read-write
project grant with nono on Linux.

**Signal scoping.** On ABI v6, `signal_mode: "isolated"` (the Pi pack's
setting) scopes signals to the sandbox's Landlock domain. Per the kernel docs
a denied signal returns `EPERM`, and PiChamber's `isPidAlive` treats `EPERM`
as alive (`supervisor.js:84-90`, `session-lease.js:14-21`). Lease and owner
checks from inside nono therefore still see live outside processes as alive.
That `kill(pid, 0)` hits the scope check is inferred from the kernel docs and
*not verified on a Landlock kernel*.

**macOS (Seatbelt).** Connecting to a Unix socket is `network-outbound`, not a
file operation. nono emits extra rules to block sockets in denied paths
(`docs/cli/internals/seatbelt.mdx`, "Unix Socket Connections"). `--listen-port`
and `--open-port` open *all* ports on macOS (`flags.mdx`). Capability
elevation is Linux-only (`supervisor.mdx`).

**WSL2.**

- The kernel ships with Landlock v3, so there is no TCP filtering.
- WSL2's init holds the only seccomp notify listener, so the proxy is blocked
  by default (`wsl2_proxy_policy: "insecure_proxy"` opts in) and capability
  elevation is unavailable.
- `--block-net` and filesystem rules work (`docs/cli/internals/wsl2.mdx`).

On WSL2, nono can therefore give PiChamber filesystem isolation, but either
no network or unfiltered network. The loopback escape (4.1) stays open unless
the network is blocked.

**First-run grants.** The Pi pack's install step runs
`json_array_append` on `$HOME/.pi/agent/settings.json` `packages`
(`nono-packs/pi/package.json`, `wiring`). So `nono pull nolabs-ai/pi` installs
a Pi extension (`extensions/nono-sandbox.ts`) into the *global* Pi settings,
which the unsandboxed main daemon also loads. That is worth stating in the UI
if we suggest the pack. Better: generate our own profile file and do not
depend on the pack.

### 2. The `~/.pi` problem

The Pi pack grants read+write on all of `$HOME/.pi`
(`nono-packs/pi/policy.json`, `filesystem.allow`). That lets a sandboxed agent:

- edit `~/.pi/agent/settings.json` (`packages`, `extensions`)
- drop files into `~/.pi/agent/extensions/`
- change `trust.json`
- read every project's transcripts

The unsandboxed main daemon loads all of these on its next runtime creation.
It is the same escape as planting a shell rc file.

What Pi touches, from the Pi 1.5.0 SDK (`dist/config.js:510-552`, writers
found by grep in `dist/core/*.js`):

| Path under agent dir | Read in a session | Written in a session | Written at settings/login time |
|---|---|---|---|
| `settings.json` | yes (with a lock, see below) | model switch, thinking, steering/follow-up mode, compaction, retry toggles (`core/agent-session.js:2035-3162` calls `setDefaultModelAndProvider`, `setDefaultThinkingLevel`, …) | yes |
| `auth.json` | yes (with a lock) | OAuth token refresh (`core/auth-storage.js:386-410`) | `/login`, logout |
| `models.json` | yes | no | PiChamber model editor |
| `trust.json` (+ `trust.json.lock`) | yes | `/trust` | yes |
| `sessions/<encoded cwd>/*.jsonl` | yes | append (`core/session-manager.js:761`) | — |
| `extensions/`, `prompts/`, `themes/`, `tools/`, skills | yes | no | resource editing |
| `bin/` (fd, rg downloads) | yes | first use of a missing tool (`utils/tools-manager.js:10, 230`) | — |
| `tmp/extensions` | — | package installs (`core/package-manager.js:86`) | — |
| `crashes.json`, `pi-debug.log` | — | on crash/debug (`core/crash-log.js:8`) | — |
| `mcp.json`, `mcp-auth.json`, `mcp.log` | yes | MCP OAuth, log (`extensions/mcp/*.js`) | yes |
| `.pichamber/locks/sessions/` | yes | every resident session (PiChamber) | — |

**The lock trap.** `AuthStorage.withLock` and `SettingsManager.withLock` call
`proper-lockfile`'s `lockSync(path)` *before reading*
(`core/auth-storage.js:62-79`, `core/settings-manager.js:150-160`). That
creates the folder `<file>.lock` beside the file. A failed lock is swallowed
(`reload()` keeps "the last valid in-memory snapshot", `auth-storage.js:314-328`).

I ran Pi's real `AuthStorage` under bwrap with the agent folder bound
read-only and a test `auth.json` holding one API key. `list()` returned `[]`.
The same code outside the sandbox returned the key (experiment E4). A
read-only agent folder therefore means "logged out", with no error shown.

**Can Landlock express "write only `sessions/<this project>/` plus locks, read
the rest"?** For files Pi *appends to*, yes:

```
read  ~/.pi/agent
allow ~/.pi/agent/sessions/<encoded cwd>
allow ~/.pi/agent/.pichamber/locks/sessions
```

It cannot express the lock folders Pi creates *beside* `settings.json` and
`auth.json` without a write grant on `~/.pi/agent` itself. Landlock rules
cover the whole subtree, so that grant would re-open `extensions/` and
`settings.json` to writes (`docs/cli/internals/landlock.mdx`, "Access Rights
Mapping"; kernel docs).

**Recommended shape: a shadow agent directory.** For each sandboxed project,
PiChamber creates `<dataDir>/pi/sandbox/<projectKey>/agent/`, owned by
PiChamber and writable by the sandbox, and passes it as `--agent-dir`. That
makes `PI_CODING_AGENT_DIR` point there (`daemon-process.js:34`). Inside it:

- **Symlinks** to the real `settings.json`, `auth.json`, `models.json`,
  `trust.json`, `extensions/`, `prompts/`, `themes/`, `skills/`, `tools/`,
  `bin/`, `mcp.json`, with read-only grants on the real targets. Lock folders
  land in the shadow folder. Writes fail softly: `SettingsManager` records
  the error (`settings-manager.js:417-440`) and the real file is untouched.
  bwrap stand-in, experiment E5: settings loaded (`defaultThinkingLevel` read
  back), `auth.json` listed its key, and a later `setDefaultThinkingLevel`
  failed with `EROFS` into `drainErrors()`. Whether Landlock follows a
  symlink to a read-granted target the same way is *not verified* (no
  Landlock here). bwrap can bind the real files instead of using symlinks.
- **`sessions/<encoded cwd>`** for the project and each of its worktrees: a
  symlink or bind to the real `~/.pi/agent/sessions/<encoded cwd>`, granted
  read-write. Other projects' session folders get no grant at all, not even
  read.
- **`.pichamber/locks/sessions`**: the real lease folder, granted read-write.
  It is one flat folder for all projects, so a sandboxed agent can write or
  delete *any* lease file. Worst case is denial of service (a forged live
  lease makes a session `SESSION_IN_USE`). If that matters, leases need a
  per-cwd subfolder (a small change in `session-lease.js:43-44`).

Cost of the read-only global config: inside a sandboxed project, a model
switch does not become the global default. Pi already restores model and
thinking from the session branch, so per-session behaviour is unchanged.
OAuth token refresh cannot persist (open question 3).

The lease lock is not shared across the trust boundary: lock folders in the
shadow do not coordinate with host Pi processes writing `auth.json`. With
read-only `auth.json` this does not matter; with read-write it would (OAuth
refresh races).

**Extension planting.** Three sources load code into a later *unsandboxed*
daemon:

1. Global `~/.pi/agent/extensions` and `settings.json` `packages`/`extensions`.
   Closed by the read-only grants above.
2. Project-local `.pi/extensions`, `.pi/settings.json`, and `.pi/mcp.json`,
   which load after project trust (Pi `docs/security.md`, "Resources
   protected by project trust").
3. Code the user's own tools run outside: `.git/hooks`, `.git/config`
   (finding 4.3), and `package.json` scripts.

(2) cannot be blocked inside the sandbox with nono on Linux (allow-only). bwrap
can `--ro-bind <project>/.pi <project>/.pi` (experiment E3 shows nested
read-only binds inside a read-write bind work). Recommended defence for every
launcher: when a project goes **sandboxed → unsandboxed**, PiChamber hashes
the trust-protected project resources at sandbox time and, on switch-off,
puts the project's Pi trust back to "ask" if any changed. Pi already supports
saved trust decisions in `trust.json` and `defaultProjectTrust`. The
"Project trust changes" path already exists in the daemon
(`DOCUMENTATION.md`, "Project trust changes are persisted in Pi trust.json").

### 3. Paths the sandboxed daemon itself needs

From `supervisor.js:131-197`, `daemon-process.js`, and `lib/open-url/browser-env.js:41-80`:

| Need | Grant | Notes |
|---|---|---|
| Node binary | read+exec of its **real** folder | `/root/.bun/bin/node` is a symlink to a different folder; bwrap failed with `execvp … No such file` until the real folder was bound (experiment E1). Resolve `realpath(process.execPath)`; in Electron, the app bundle (`ELECTRON_RUN_AS_NODE=1`). |
| PiChamber install | read of the `packages/web` install root and its `node_modules` (SDK, built-in extensions `codemode`, `tool-search`, `mcp`) | `builtin-extensions.js` loads them from the SDK package. |
| Profile folder `<dataDir>/pi/daemons/<sandboxProfileKey>/` | read+write | credential, state sidecar, `operation.lock`. **Not** the main profile's folder (4.2). |
| Runtime folder `…/pi-daemons/<sandboxProfileKey>/` | read+write (`MAKE_SOCK`) | binds `daemon.sock` |
| Open request socket | connect | Today `open-url.sock` sits in the main profile's runtime folder. Give each sandbox profile its own intake socket, or grant connect on that one file (bwrap: bind the single socket file). |
| `$BROWSER` launcher | write in the profile's runtime folder or private folder (`browser-env.js:41-48`, falls back to `os.tmpdir()`) | |
| Log | stdout/stderr already redirected by the spawner | no file grant needed |
| Shadow agent folder and real targets | see finding 2 | |
| Project folder | read+write | |
| Worktrees `<dataDir>/worktree/<projectId>/` | read+write | plus the main repo's `.git` (shared object store); see 4.3 |
| Temp | read+write of a private `TMPDIR` | bwrap `--tmpfs /tmp`; nono needs an explicit folder; set `TMPDIR` |
| Tools | read+exec of `git`, `rg`, `fd`, shells, `/usr`, language runtimes | nono's groups `node_runtime`, `git_config`, `system_read_linux_core` cover most of this |
| User caches | read+write on `~/.npm`, `~/.cache`, … | the user's call; Pi pack groups `user_caches_*` |
| Provider network | proxied allowlist | 4.1 |

Do *not* grant `<dataDir>` as a whole. It holds `settings.json`,
`runtime-state.json`, remote-client tokens, the JWT secret, passkeys, the
tunnel token (`DOCUMENTATION.md`, "Shared writable state is coordinated"),
and every other profile's daemon credential.

### 4. Escape routes outside the sandbox

A sandbox around the daemon is only as good as the unsandboxed things that
trust its output.

1. **PiChamber's own HTTP server on loopback.** With UI auth off,
   `requireAuth` passes every request (`ui-auth.js:631-633`), and a request
   with no `Origin` is not cross-site. A sandboxed `curl
   http://127.0.0.1:<port>/api/pi/sessions` can create an unsandboxed session,
   or open the terminal WebSocket.

   - Experiment E3: inside bwrap *without* `--unshare-net`, a connect to a
     host `127.0.0.1` listener succeeded; with `--unshare-net` it was refused.
   - nono's default network is "allowed", and `nono wrap` cannot filter by
     host, so plain `nono wrap` leaves this open.
   - Proxy mode adds seccomp user notification that "checks the real
     destination address of every `connect()`"
     (`docs/cli/features/networking.mdx`, "Linux"). Whether it refuses a
     direct loopback connect when loopback is not allowlisted, and whether
     the proxy refuses `CONNECT 127.0.0.1:<port>`, is *not verified*.
     Required test before shipping.

   Independent fix: when any project is sandboxed, require a per-server
   loopback token on `/api/*`, or bind the server API to a Unix socket.
2. **The main daemon's socket and credential.** Below Landlock ABI 9, and with
   nono's default `af_unix_mediation` off, pathname sockets are unmediated.
   The only protection for the main daemon's socket is its credential file.
   Never grant read on `<dataDir>/pi/daemons/` except the sandbox's own
   profile subfolder.
3. **Unsandboxed git in a sandboxed repo.** A repo-local `core.fsmonitor`
   runs on every `git status`. Experiment E6 printed `FSMONITOR-RAN` from
   plain `git status`, and nothing with `-c core.fsmonitor=false`. PiChamber's
   Git panel polls status and runs `post-checkout` itself
   (`lib/git/service.js:1092`). Other config keys run commands too: pagers,
   `diff.external`, filter drivers, `core.sshCommand`, credential helpers.

   - bwrap can bind `.git/config` and `.git/hooks` read-only.
   - nono on Linux cannot (allow-only, and the worktree needs write on the
     main `.git`).

   Recommended for every launcher: run PiChamber's server-side git for a
   sandboxed project *through the same launcher*, as a short-lived sandboxed
   process with the project's grants. Hardening with `-c` flags alone is a
   deny-list and will miss keys.
4. **Planted project `.pi` resources.** See finding 2. Reset trust on
   switch-off.
5. **`/proc/<pid>/root` without a PID namespace (bwrap, firejail, srt).**
   Experiment E2: bwrap with its own `--proc` but no `--unshare-pid` let the
   sandbox write `/tmp/sbxresearch-exp/escape-nopidns.txt` on the host through
   `/proc/<host pid>/root/…`. With `--unshare-pid` the same write failed. srt
   always passes `--unshare-pid`, with the comment "If we don't have
   --unshare-pid, it is possible to escape the sandbox"
   (`sandbox-runtime/src/sandbox/linux-sandbox-utils.ts:3803-3810`).

   Tested as root. That the same works for a non-root user against same-UID
   processes follows from `/proc/<pid>/root` needing only `PTRACE_MODE_READ`,
   which is *not verified* here. nono is not affected the same way: Landlock
   checks the resolved path whatever the mount namespace. Not tested.

**What a PID namespace breaks.** Experiment E1 with `--unshare-pid`:

- the daemon reported `pid: 2`
- the host's `kill(2, 0)` reached `kthreadd`, so the main daemon's identity
  checks would compare against the wrong process
- inside the sandbox, `kill(serverPid, 0)` returned `ESRCH`, so the sandboxed
  daemon would think its owner server is dead (`session-daemon.js:4402`)
  *and that every other daemon's lease is stale* (`session-lease.js:98`). It
  would steal leases, and two daemons could write the same JSONL.

Fixes, all needed before bwrap, firejail, or srt can ship:

- The launcher reports the host PID of the sandbox root. bwrap
  `--info-fd`/`--json-status-fd` writes `{"child-pid": N, …}` with N a host
  PID (experiment E1b).
- The supervisor stores it and uses it for liveness and signalling.
- The daemon reports `daemonId` over IPC instead of trusting its own
  `process.pid` for identity.
- Leases stop using `kill(pid, 0)` across sandboxes. Use a held `flock`
  on the lease file: kernel locks work across mount and PID namespaces on a
  shared file. Or have the server, which sees host PIDs, check liveness.

### 5. Switching semantics

What must happen when project P flips sandbox state (either direction):

1. **Persist the new desired state first.** Then new creates and opens for P
   route to the target daemon at once.
2. **Sessions resident in the old daemon.** An idle resident session is
   disposed there (lease released). It is not moved live: Pi runtimes have no
   migration. The next open recreates it in the target daemon from JSONL, the
   same path as idle disposal today (`DOCUMENTATION.md`, idle disposal).

   A session mid-turn, mid-compaction, mid-`custom()`, or with a pending
   dialog keeps running in the old daemon. Its row shows "switches to
   sandboxed after this turn". It is disposed at its next idle edge, which
   needs a "dispose at next safe edge" request the daemon already has the
   pieces for (deferred recreation, `ctx.shutdown()` handling). Until then,
   the target daemon answers `SESSION_IN_USE` for that id (leases already do
   this). That is correct, not a failure.
3. **Event subscriptions.** The browser keeps one `/api/pi/events`
   connection. The server merges the streams. Each daemon has its own
   `streamEpoch` and sequence, so the merged cursor becomes a small vector
   `{ daemonKey: { epoch, seq } }`, encoded as an opaque string. A daemon
   appearing or disappearing resyncs only its sessions through
   `session.snapshot`. A `session.moved` event (or a list invalidation for P)
   tells clients to refetch the session from the new owner.
4. **Listing.** Every daemon can list every directory, since JSONL is the
   authority. Route `sessions.list?directory=P` to P's current daemon, which
   carries `live` for its resident rows. While a turn drains in the old
   daemon, also ask the old daemon for `live` on that folder and merge by
   session id. Without that, a row would show no `live` ("unknown"), which
   follows the existing rule that missing `live` is not idle.
5. **Directory-less commands go to the main daemon**: `providers.*`,
   `settings.*`, `projects.*`, `resources.*` without a directory, and
   `engines.list`. Provider login must never run inside a sandbox, because it
   writes `auth.json`. `sessions.pendingInput` and the notification watcher
   fan out to all live daemons and merge.
6. **Fail closed.** If P is marked sandboxed and the launcher probe fails
   (binary missing, Landlock absent, profile invalid, spawn error), every
   P-scoped command returns `SANDBOX_UNAVAILABLE` with the launcher's reason
   code. Listing still works through any daemon, read-only. Never route P to
   the main daemon while P is marked sandboxed.
7. **Switch-off checks** (finding 2): reset P's Pi trust to "ask" if
   protected `.pi` resources changed while sandboxed.

**UI.** The project's settings card gets a "Sandbox" row (launcher name, or
Off). Each sandboxed session row and the chat header get a small text label
("Sandboxed (nono)"), with no icon beyond what the theme already has. Show
unavailable as an error state on the project with the reason ("nono not
found", "Landlock not available on this kernel"). A pending switch shows on
the affected rows as "switches after this turn".

### 6. Generic launcher contract

Every launcher must provide:

- availability with a machine-readable reason
- version
- platform support
- argv and env built from a *structured* grant list, never raw user strings
- an identity string that goes into the daemon profile key, so a changed
  policy or version means a new daemon rather than reuse
- the host PID of the sandbox root
- whether it needs a networked transport
- how denials surface

How each tool maps onto it (CLI syntax from the cited sources):

| Grant | nono (`flags.mdx`) | bubblewrap (`bwrap(1)` 0.9.0) | srt (`README.md`, settings JSON) | firejail (`firejail.1.in`) |
|---|---|---|---|---|
| read dir | `--read D` | `--ro-bind D D` | read is allowed by default; narrow with `filesystem.denyRead` + `allowRead` | default; `--read-only=D` |
| read+write dir | `--allow D` | `--bind D D` | `filesystem.allowWrite: [D]` | `--whitelist=D` (+ `--read-write=D`) |
| read-only inside read-write | not on Linux (allow-only) | nested `--ro-bind` (E3) | `filesystem.denyWrite` (wins over allowWrite) | `--read-only=` inside whitelist |
| hide a path | not granted = hidden | not bound = absent | `denyRead` | `--blacklist=D` |
| private tmp | grant a folder, set `TMPDIR` | `--tmpfs /tmp` | `allowWrite: ["/tmp"]` | `--private-tmp` |
| bind own Unix socket | `--allow-unix-socket-dir-bind D` | bind the folder rw | blocked by seccomp on Linux unless `allowAllUnixSockets: true` | allowed |
| block network | `--block-net` | `--unshare-net` | `allowedDomains: []` | `--net=none` |
| domain allowlist | `--allow-domain H` (proxy, `run` only) | none (needs a proxy socket bound in) | `allowedDomains: [H]` (host proxy over a Unix socket) | none |
| PID namespace | none | `--unshare-pid` (required, 4.5) | always | always (default) |
| host PID of root | `child.pid` (`wrap`: the daemon; `run`: the supervisor) | `--info-fd` `child-pid` | srt's own `child.pid` plus bwrap inside (*unverified* how to get the inner PID) | `firejail --list` / `--join` (*unverified*) |
| stays as parent | `run`: yes; `wrap`: no | yes (E1) | yes (Node process runs the proxies) | yes |
| signal forwarding | yes (SIGINT/TERM/HUP/QUIT/USR1) | **no**: SIGTERM to bwrap leaves the child running unless `--die-with-parent`, and then it is SIGKILL (E1c) | not checked | `--deterministic-exit-code` for exit status; signals not checked |
| exit code | the child's | the child's (E1c) | not checked | the first child's with `--deterministic-exit-code` |
| needs root/suid | no | no (user namespaces) | no | **setuid root** binary (`firejail.1.in` line 37) |
| platforms | Linux (Landlock), macOS (Seatbelt), WSL2 | Linux | Linux, macOS, Windows (dedicated user + WFP) | Linux |

Consequences for the PiChamber design:

- **bwrap without `--die-with-parent` orphans the daemon** when the wrapper is
  killed (E1c). PiChamber must always stop through IPC and SIGTERM to the
  *daemon's* PID. That is already how `stop` works, but the start-timeout
  path signals `child.pid`.
- **srt blocks Unix sockets by default on Linux**, and the daemon binds one.
  Set `allowAllUnixSockets: true`, which also re-opens 4.2, so the credential
  file must stay hidden.
- **firejail is a setuid-root program.** Its man page states the risk
  plainly ("if a vulnerability is discovered…", lines 55-60). Rank it last.
- **Containers and microVMs (Docker/Podman, Docker Sandboxes `sbx`, Gondolin)
  need a networked transport.**
  - The daemon's Unix socket and the open-url socket must reach the host
    server. That works for rootful Docker or Podman on Linux with a
    bind-mounted folder (same kernel).
  - It fails for Docker Desktop on macOS and Windows and for microVMs, where
    the daemon runs on another kernel. A bind mount does not carry a
    listening Unix socket across a VM boundary. *Reasoned, not tested.*
  - Those launchers need the daemon to listen on TCP or vsock with the
    existing credential handshake, plus TLS or a forwarded port. Today the
    supervisor rejects TCP endpoints on purpose (`DOCUMENTATION.md`,
    "TCP endpoints are rejected").
  - The session JSONL also has to reach the host for listing (shared mount or
    sync).
  - Pi's own isolation guide recommends a separate agent home volume rather
    than mounting `~/.pi/agent` (`docs/containerization.md`, "Run Pi in plain
    Docker").
  - Gondolin only sandboxes Pi's *tools* and keeps Pi on the host (same doc,
    "Route tools through Gondolin"). It is a tool backend, not a daemon
    launcher, and would sit behind a different seam.

Proposed interface:

```ts
type Grant =
  | { kind: 'read' | 'readWrite'; path: string; recursive: true }
  | { kind: 'readFile' | 'readWriteFile'; path: string }
  | { kind: 'readOnlyWithin'; path: string }        // e.g. <project>/.git/hooks; may be unsupported
  | { kind: 'unixSocketBind'; dir: string }
  | { kind: 'unixSocketConnect'; path: string }
  | { kind: 'privateTmp' };

type NetworkPolicy =
  | { mode: 'none' }
  | { mode: 'proxy'; allowDomains: string[] }       // host loopback never reachable
  | { mode: 'unrestricted' };                       // refused unless the server API needs auth on loopback

interface LaunchRequest {
  argv: string[];                 // [nodeRealPath, daemonEntrypoint, ...flags]
  env: Record<string, string>;
  cwd: string;
  grants: Grant[];
  network: NetworkPolicy;
  logFd: number | null;
}

interface PreparedLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  extraFds?: { info: number };    // bwrap --info-fd
  cleanup?: () => Promise<void>;  // e.g. delete a generated profile file
}

interface SandboxLauncher {
  id: 'nono' | 'bwrap' | 'srt' | 'firejail' | string;
  platforms: NodeJS.Platform[];
  transport: 'local-socket' | 'network';           // containers/VMs: 'network'
  probe(): Promise<
    | { available: true; version: string; capabilities: string[] }   // e.g. 'landlock-abi-6', 'net-proxy'
    | { available: false; code: string }>;                           // NOT_INSTALLED, NO_LANDLOCK, NO_USERNS, ...
  supports(grant: Grant): boolean;                 // readOnlyWithin false for nono/Linux
  identity(req: LaunchRequest): string;            // hash(id, version, normalized grants, network) -> profile key suffix
  prepare(req: LaunchRequest): Promise<PreparedLaunch>;
  rootPid(child: ChildProcess, prepared: PreparedLaunch): Promise<number>; // host PID used for liveness
  describeDenial?(stderrLine: string): { path?: string; op?: string } | null;
}
```

**Denials surface three ways.** Tool calls see ordinary `EACCES`, `EPERM`,
or `EROFS` and report them in the transcript, as Pi does today. Launch
failures map to stable codes on the project. Optional launcher diagnostics
(nono's footer, srt's `<sandbox_violations>`) go to the per-profile log only.
Never show raw paths in public projections; follow the existing redaction
rule.

### 7. Granularity: per project vs per session

| | Per project (recommended) | Per session |
|---|---|---|
| Processes | 1 + number of sandboxed projects with a resident session (idle disposal can stop an empty sandbox daemon after N minutes) | 1 + number of resident sandboxed sessions |
| Memory | about 145 MB baseline per daemon (E7: fresh daemon, 437-457 ms to ready, RSS 145 MB with `PI_OFFLINE=1`; the production daemon on this host sits at 94 MB after days with sessions disposed). Resident sessions add on top in either case. | 145 MB × sessions, before session memory |
| Startup | about 0.45 s once per project (E7; bwrap added no measurable time: 437-447 ms) | about 0.45 s on every session open after idle disposal |
| Grants | project folder + its worktrees + `sessions/<cwd>` for each: a natural set | the same set per session; a session-only folder grant is not meaningful, since tools reach the whole cwd |
| Worktrees | a worktree session's cwd is `<dataDir>/worktree/<projectId>/<name>/`, outside the project. The project daemon grants the folder `<dataDir>/worktree/<projectId>/` and the main repo's `.git` once; new worktrees fit under the grant without a restart. | each session grants exactly its worktree, plus the main `.git` |
| Leases | unchanged; one daemon per project; cross-daemon only during a switch | unchanged; more daemons contend |
| Listing | route by directory; one owner per folder | a folder's sessions are spread over many daemons; `live` needs fan-out across all of them |
| Event merging | vector cursor across a handful of daemons | across many, with daemons appearing and disappearing per session |
| Switch | per project, drain per session | per session, simpler draining, but projects end up half sandboxed |

"For every project, for each thread" reads well as: *the setting lives on the
project and applies to every thread in it*. A per-thread override (for
example "run this one session unsandboxed") can come later. It would reuse
the same router: the override picks the main daemon or the project's sandbox
daemon. It does not need one daemon per thread.

### 8. Settings surface

- **Server-wide availability.** A host-local list of detected launchers with
  probe results and versions, refreshed on demand. It never travels between
  machines, because a launcher on one host says nothing about another.
- **Per-project choice.** `projects[].sandbox = { launcher: 'nono', network:
  'proxy', extraGrants?: Grant[] }`. `projects` is already a `LOCAL_FIELDS`
  entry (`ui-settings-store.js:58-59`), so the choice is host-local by
  construction. That is correct: grants are host paths.
- **Defaults.** A portable "new projects start sandboxed" preference could go
  in `PORTABLE_FIELDS` (`ui-settings-store.js:25-53`), but only as a wish
  ("sandbox if available"). It must not turn into a silent failure on a host
  without the launcher. Leave it out of the first version.
- **Per-session override.** Later, stored in PiChamber's session metadata
  next to the archive and shelf stores, never in Pi JSONL.
- **Windows.**
  - nono supports WSL2, not native Windows (`README.md` line 39).
  - srt supports native Windows through a dedicated `srt-sandbox` local user
    and a machine-wide WFP filter set (`sandbox-runtime/README.md`, "How It
    Works"), which needs an install step with admin rights.
  - The daemon uses a named pipe on Windows, and pipe ACLs are "not yet
    equivalent owner-only OS permissions" (`DOCUMENTATION.md`).

  Ship Windows as "not available" in the first version. srt-on-Windows is a
  later candidate, and a WSL2 server with nono is the documented path for
  Windows users today.

## Phased plan

Sizes are rough (S ≈ a day, M ≈ several days, L ≈ a week or more).

1. **Daemon identity and leases that survive namespaces. M.** The supervisor
   stores the launcher-reported host PID. Health identity moves to
   `daemonId` and `profileKey`. Leases use a held `flock` (or server-side
   liveness) instead of `kill(pid, 0)`, with a per-cwd lease subfolder.
   Useful even without sandboxing (container daemons). Tests in
   `session-lease.test.js` and `supervisor.test.js`.
2. **Daemon router in the server. L.**
   - `getDaemonRuntime` becomes `getDaemonRuntimeFor({ directory? })`.
   - Directory-less commands go to the main daemon.
   - `pendingInput` and the notification watcher fan out.
   - `/api/pi/events` merges streams under an opaque vector cursor.
   - `sessions.list` merges `live` while a switch drains.

   Ships inert: only the main daemon exists. This is the bulk of the work,
   because 34 call sites and the sync contract change, so the
   `sync-state-invariants` and `ui-api-decoupling` skills apply.
3. **Launcher seam and nono launcher. M.**
   - Profile key `<base>-sbx-<projectKey>-<identityHash>`.
   - Shadow agent folder; generated nono profile file in the sandbox profile
     folder.
   - `nono run -s --profile <file> --no-rollback --no-audit-integrity
     --no-diagnostics -- <node> daemon-process.js …`, with
     `NONO_NO_SAVE_PROMPT=1` and `NONO_NO_UPDATE_CHECK=1`.
   - Probe through `nono --version` plus a functional
     `nono wrap --read / -- true`.
   - Fail closed with `SANDBOX_UNAVAILABLE`.
4. **Close the outside escapes. M.**
   - Loopback auth for `/api/*` while any project is sandboxed (or verify
     nono proxy mode blocks loopback, and refuse `unrestricted` network).
   - Sandboxed git for sandboxed projects.
   - Trust reset on switch-off.
   - Hidden credential folders.

   Must land with or before phase 3 is turned on.
5. **Project setting and UI. M.** Project settings row, session labels,
   switch draining, error states. Screenshots per the repo's screenshot
   script.
6. **bubblewrap launcher. S-M.** Needs phases 1 and 4. Use `--unshare-pid
   --unshare-net --new-session --die-with-parent --info-fd`, plus a host-side
   domain proxy on a bound Unix socket (or reuse srt's proxy design). Without
   a proxy, bwrap is offline-only.
7. **srt launcher. M.** Settings JSON written per project,
   `allowAllUnixSockets: true`, inner host PID discovery.
8. **Containers and microVMs. L each.** A networked daemon transport with
   the existing credential handshake, and JSONL sync. Separate design.

## Open questions for the maintainer

1. Is per-project (one setting per project, every thread in it) the intended
   reading of "for every project, for each thread", or do you want
   per-thread overrides in the first version?
2. Network default for sandboxed projects: domain allowlist through the
   launcher's proxy (safe, needs `nono run` and a provider list to maintain),
   or unrestricted plus mandatory loopback auth on the PiChamber API?
3. OAuth subscriptions (ChatGPT, Claude) refresh tokens by writing
   `auth.json`. With read-only `auth.json`, a sandboxed session works until
   the token expires, then fails. Options:
   - grant read-write on `auth.json` only, accepting that the agent can read
     and replace credentials (it can already read them);
   - have the main daemon refresh and the sandbox re-read;
   - API keys through nono's credential proxy only.
4. Should a sandboxed agent be able to read `auth.json` at all? With nono
   phantom credentials it would not, but that covers API keys only and moves
   key storage into nono's keyring, a second place for users to manage.
5. The terminal panel in a sandboxed project: sandboxed too, or always the
   user's own unsandboxed shell (current behaviour)?
6. Sessions started outside PiChamber (Pi CLI) in a sandboxed project are not
   sandboxed. Is a label on such sessions enough?
7. Should switch-off reset project trust to "ask" whenever protected `.pi`
   resources changed, or always?
8. Is depending on the nono Pi pack acceptable, given that it edits global
   `settings.json` `packages`? Or should PiChamber generate its own profile
   (recommended)?
9. Audit default: off (`--no-audit`) to avoid unbounded logs, or on without
   integrity?

## Verified by experiment vs by reading

Experiments ran on this LXC host (kernel 7.0.2-2-pve, LSMs
`lockdown,capability,yama,apparmor,ima,evm`, no Landlock), bwrap 0.9.0, Node
24.5.0, as root, in `/tmp/sbxresearch-exp` with a throwaway HOME and agent
folder. No real `~/.pi` or `~/.config/pichamber` was touched. nono was not
executed anywhere.

- **E1, bwrap process tree.** Without `--unshare-pid`, the spawner's
  `child.pid` is bwrap and the daemon is a child with its own host PID
  (`2347907` → `2347908`). With `--unshare-pid` the daemon sees `pid 2`, and
  `kill(hostPid, 0)` gives `ESRCH` in both directions. A Unix socket bound
  inside a read-write bind accepted a host connection in both cases.
- **E1b, `--info-fd`.** It writes `{"child-pid": <host pid>, …}` for the
  namespace's init process.
- **E1c, signals.** SIGTERM to bwrap is not forwarded; without
  `--die-with-parent` the child keeps running. With it, the child dies (by
  SIGKILL, per bwrap(1)). SIGTERM to the daemon PID runs its handler, and
  bwrap exits 0.
- **E2, escape.** No `--unshare-pid` plus `--proc /proc` allowed a write to a
  host file through `/proc/<host pid>/root`. With `--unshare-pid` it was
  blocked.
- **E3, mount layout and network.** A read-only agent folder with read-write
  binds of `sessions/<one cwd>` and the lease folder:
  - other projects' session folders and `extensions/` gave `EROFS`
  - `mkdir auth.json.lock` gave `EROFS`
  - host `127.0.0.1` was reachable without `--unshare-net`, and refused with
    it
- **E4, auth.** Pi 1.5.0 `AuthStorage` with a read-only agent folder listed
  no credentials. Outside the sandbox it listed the key.
- **E5, shadow folder.** A writable shadow agent folder with symlinks to the
  read-only real `auth.json` and `settings.json`: credentials and settings
  loaded, and a settings write failed softly (`EROFS` in `drainErrors()`)
  without touching the real file. A tmpfs over the agent folder with
  read-only binds also loaded the key.
- **E6, git.** A repo-local `core.fsmonitor` command ran on `git status`, and
  did not run with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`.
- **E7, daemon cost.** A fresh `daemon-process.js` (from a sibling checkout
  with installed dependencies, throwaway HOME, agent folder, and data folder,
  `PI_OFFLINE=1`) was ready in 437-478 ms with 142-146 MB RSS. Under bwrap
  (`--ro-bind / / --unshare-pid --unshare-net`) it was ready in 437-447 ms.
  `ps` shows the host's existing production daemon at 94 MB RSS.

Read only, not executed:

- all nono behaviour (flags, prompts, signals, proxy, audit, rollback,
  Landlock mapping, Seatbelt, WSL2), from docs and source at v0.82.0
- the nono Pi pack
- srt behaviour, from README and `linux-sandbox-utils.ts`
- firejail, from its man page source
- Landlock ABI 9 `RESOLVE_UNIX` and signal scoping, from kernel docs
- whether nono proxy mode blocks direct loopback connects (open)
- symlink behaviour under Landlock (open)
- non-root `/proc/<pid>/root` access (open)
- Docker Desktop and microVM socket behaviour (reasoned)

## Sources

- nono v0.82.0, github.com/nolabs-ai/nono (read at HEAD, 2026-11-15):
  - docs: `docs/cli/features/execution-modes.mdx`, `features/supervisor.mdx`,
    `features/networking.mdx`, `features/audit.mdx`,
    `features/atomic-rollbacks.mdx`, `features/profiles-groups.mdx`,
    `usage/flags.mdx`, `internals/landlock.mdx`, `internals/seatbelt.mdx`,
    `internals/wsl2.mdx`
  - source: `crates/nono-cli/src/exec_strategy.rs`, `output.rs`,
    `sandbox_prepare.rs`, `profile_save_runtime.rs`, `update_check.rs`,
    `profile/mod.rs`, `cli.rs`
- nono Pi pack, github.com/nolabs-ai/nono-packs/tree/main/pi: `README.md`,
  `policy.json`, `package.json`
- Anthropic sandbox-runtime 0.0.83,
  github.com/anthropic-experimental/sandbox-runtime: `README.md`,
  `src/sandbox/linux-sandbox-utils.ts`
- firejail 0.9.82.2 man page source,
  github.com/netblue30/firejail `src/man/firejail.1.in`
- bubblewrap 0.9.0, `bwrap(1)` (local man page)
- Linux kernel Landlock documentation,
  https://docs.kernel.org/userspace-api/landlock.html
- Pi coding agent 1.5.0 (`@earendil-works/pi-coding-agent`): `docs/security.md`,
  `docs/containerization.md`, `docs/sessions.md`, `docs/settings.md`,
  `docs/environment-variables.md`, `dist/config.js`,
  `dist/core/auth-storage.js`, `dist/core/settings-manager.js`,
  `dist/core/session-manager.js`, `dist/core/agent-session.js`,
  `dist/utils/tools-manager.js`, `dist/core/package-manager.js`
- PiChamber: `packages/web/server/index.js`,
  `lib/pi/session-daemon/{supervisor.js, daemon-process.js, session-daemon.js,
  session-lease.js, DOCUMENTATION.md}`, `lib/pi/routes.js`,
  `lib/pi/event-stream.js`, `lib/pi/ui-settings-store.js`,
  `lib/notifications/pi-notification-watcher.js`,
  `lib/open-url/browser-env.js`, `lib/git/service.js`,
  `lib/ui-auth/{ui-auth.js, DOCUMENTATION.md}`,
  `packages/ui/src/lib/pi/transport.ts`

## nono experiments on a Landlock kernel (2026-11-15)

These runs settle most of the items above marked *not verified*. Where a
result contradicts an earlier finding, this section wins.

### Setup

- Debian 13 cloud image under QEMU (TCG software emulation, 2 vCPUs, 3 GB),
  kernel `6.12.116+deb13-cloud-amd64`, LSMs
  `lockdown,capability,landlock,yama,apparmor,tomoyo,bpf,ipe,ima,evm`, Yama
  `ptrace_scope` 0.
- nono 0.82.0 from the release `.deb`. Node v24.22.3 from nodejs.org
  (`node-v24.22.3-linux-x64.tar.xz: OK` against `SHASUMS256.txt`).
- `@pi-chamber/web@1.0.7-rc.1` with Pi 1.5.0. Running `npm install` inside
  the VM was too slow under emulation: its SSH session dropped and npm died
  halfway. The same package was installed on the host instead
  (`npm install --ignore-scripts`, only `node-pty`'s native build skipped,
  which the daemon does not load) and copied into the VM's
  `/opt/pichamber`.
- Everything ran as the non-root user `tester` unless stated otherwise. A
  throwaway `~/.pi/agent` held a test `auth.json`
  (`{"fake":{"type":"api_key","key":"fake-test-key"}}`), a `models.json`
  provider `fake` (`openai-completions`, `baseUrl`
  `http://127.0.0.1:18080/v1`, no `apiKey`), and `settings.json` with
  `defaultProvider: fake`. The fake provider was a 40-line Node HTTP server on
  127.0.0.1:18080. It returns 401 unless the request carries
  `Bearer fake-test-key`, answers a user message containing `RUN: <cmd>` with
  a streamed `bash` tool call, and answers anything else with fixed text.
  Every successful turn below therefore also proves that the key was read
  from `auth.json`.
- The real `daemon-process.js` was spawned by a script that copies
  `supervisor.js:550-571`: the same argv, `detached: true`, stdio
  `['ignore', logFd, logFd]`, `cwd` set to the project. The only difference
  is that the command is prefixed with `nono run …`. The test client speaks
  the daemon's newline-JSON protocol (`authenticate`, then `request`
  frames), the same frames as `ipc-client.js`. The whole PiChamber server was
  not started.
- Baseline without nono: ready in 9.9 s (emulated). A `RUN: echo baseline >
  base.txt && cat base.txt` turn completed with tool output `"baseline\n"`.

### 1. `nono setup --check-only`

```
  * Kernel version: 6.12.116+deb13-cloud-amd64
  * Landlock enabled (syscall probe)
  * Landlock V6
  * Enforcing Landlock V6 access rights and scopes
      - TCP network filtering
      - Signal and abstract UNIX socket scoping
  * Linux AF_UNIX mediation: off by default
    - For stricter IPC isolation, set linux.af_unix_mediation = "pathname"
  * 46 dangerous commands blocked by default:
      apt, apt-get, chattr, chgrp, chmod, chown, cp, dd, ...
  * Network access: allowed by default (use --block-net to disable)
```

Landlock ABI 6. The "dangerous commands" list (`rm`, `cp`, `mv`, `npm`,
`kill`, …) is the deprecated `commands.deny`, which the schema documents as
"Startup-only … Not enforced for child processes". The agent's `bash` tool
ran `rm in.txt && echo rm-ok; cp README.md r2 && echo cp-ok` and printed both
lines. The list does not get in Pi's way, and it gives no protection either.

### 2. The real daemon under `nono run`

Static profile `pichamber-profile.json` (the final version adds `linux`, see
step 3):

```json
{
  "extends": "default",
  "meta": { "name": "pichamber-sandbox" },
  "groups": {
    "include": ["node_runtime", "git_config", { "name": "linux_sysfs_read", "when": "linux" }],
    "exclude": ["system_write_linux"]
  },
  "security": { "signal_mode": "isolated", "capability_elevation": false },
  "workdir": { "access": "none" },
  "filesystem": {
    "allow_file": ["/dev/null", "/dev/zero", "/dev/full", "/dev/tty"],
    "allow": ["/dev/pts", "/proc/self/fd", "/dev/fd"]
  }
}
```

`system_write_linux` (pulled in by `default`) grants read+write on all of
`/tmp`. The profile excludes that group, adds back the device files it
carried, and the launch sets `TMPDIR` to a private folder.

Launch, with environment `NONO_NO_SAVE_PROMPT=1 NONO_NO_UPDATE_CHECK=1
TMPDIR=<sandbox>/tmp`:

```
nono run -s --profile ~/exp/pichamber-profile.json --no-rollback --no-audit-integrity --no-diagnostics \
  --allow ~/code/projA \
  --allow ~/.config/pcx/pi/sandbox/projA/agent \
  --allow ~/.config/pcx/pi/sandbox/projA/tmp \
  --allow ~/.config/pcx/pi/daemons/sbx-projA \
  --allow-unix-socket-dir-bind /run/user/1000/pichamber/pi-daemons/sbx-projA \
  --read-file ~/.pi/agent/settings.json --read-file ~/.pi/agent/auth.json \
  --read-file ~/.pi/agent/models.json --read-file ~/.pi/agent/trust.json \
  --read ~/.pi/agent/extensions \
  --allow ~/.pi/agent/sessions/--home-tester-code-projA-- \
  --allow ~/.pi/agent/.pichamber/locks/sessions \
  --read /opt/node --read /opt/pichamber \
  -- /opt/node/bin/node …/session-daemon/daemon-process.js --endpoint /run/user/1000/pichamber/pi-daemons/sbx-projA/daemon.sock \
     --credential-file … --state-file … --cwd ~/code/projA --profile-key sbx-projA … --agent-dir ~/.config/pcx/pi/sandbox/projA/agent
```

Results:

- **No prompt, no hang.** The spawner exited normally, the log file stayed
  empty (0 bytes) with `-s`, and the state sidecar appeared after 10.1-11.4 s
  over five starts (baseline 8.4-9.9 s; emulated, so only the order of
  magnitude means anything).
- **PIDs.** `{"spawnerPid":1060,"childPid":1067,…}` then
  `{"statePid":1068,"state":"ready"}`, and `runtime.health` returned
  `{"daemonPid":1068}`. `ps -o pid,ppid,sid`:
  `1067 1 1067 nono run …` and `1068 1067 1067 /opt/node/bin/node
  …daemon-process.js`. The spawner gets nono's PID, and the daemon is nono's
  child with its own host PID, in the same session (nono did not call
  `setsid` again). The state sidecar and health agree, so
  `health.daemonPid === state.pid` holds. `nono ps` lists the same pair
  (`supervisor_pid` 2924, `child_pid` 2927 in a later run) in
  `~/.local/state/nono/sessions/<id>.json`.
- **Socket bind** in the `--allow-unix-socket-dir-bind` folder worked, and
  an unsandboxed client connected and authenticated.
- **Turns.** `sessions.create` returned model
  `{"providerId":"fake","modelId":"fake-model"}`, and the fake server logged
  `auth= Bearer fake-…`. Bash tool results, one per prompt:

  | Command (inside the sandbox) | Output |
  |---|---|
  | `echo inside > in.txt && cat in.txt; pwd` | `inside` `/home/tester/code/projA` |
  | `echo x > ~/outside/w.txt` / `cat ~/outside/file.txt` | `Permission denied` (rc 1) for both |
  | `echo x > /tmp/w.txt` / `echo y > $TMPDIR/t.txt` | `/tmp/w.txt: Permission denied`; `tmpok` |
  | `ls ~/.pi/agent/sessions/`, `ls …/--home-tester-code-projB--`, `cat ~/code/projB/notes.txt` | `Permission denied` for all three |
  | `echo pwn >> ~/.pi/agent/settings.json`, `mkdir ~/.pi/agent/extensions/evil` | `Permission denied` for both |
  | `cat ~/.pi/agent/auth.json` | readable (`{"fake":{"type":"api…`): read-only by design, open question 4 |
  | `cat ~/.config/pcx/pi/daemons/base/session-daemon.key` (main daemon's credential) | `Permission denied` |

  Denials appear as `EACCES` ("Permission denied"), not `EROFS`.
- **Stop paths** (separate runs; the spawner waited on nono's exit):

  | Action | Result |
  |---|---|
  | SIGTERM to the daemon PID | `nono exit {"code":0,"signal":null} after 629 ms`; socket and state file removed |
  | SIGTERM to the nono PID | `{"code":0,"signal":null} after 640 ms`; daemon gone (`ESRCH`); socket and state removed |
  | IPC `runtime.shutdown` `{serverInstanceId, daemonId}` | `{"shutdown":true}`, nono `code 0` after 690 ms; cleaned up |
  | SIGKILL to the nono PID | nono `signal SIGKILL`; **daemon still alive**, socket and state left behind |

  The supervisor's startup-timeout path (SIGTERM to `child.pid`) therefore
  works under `nono run`. A hard kill of nono orphans the daemon, as with
  bwrap without `--die-with-parent`, so the supervisor must keep using
  `state.pid` for stop and liveness.

### 3. The shadow agent folder

Layout created per project by PiChamber (here by a shell script):

```
~/.config/pcx/pi/sandbox/projA/agent/          (granted --allow)
  settings.json  -> ~/.pi/agent/settings.json  (target --read-file)
  auth.json      -> ~/.pi/agent/auth.json      (target --read-file)
  models.json    -> ~/.pi/agent/models.json    (target --read-file)
  trust.json     -> ~/.pi/agent/trust.json     (target --read-file)
  extensions     -> ~/.pi/agent/extensions     (target --read)
  sessions/--home-tester-code-projA-- -> ~/.pi/agent/sessions/--home-tester-code-projA--   (target --allow)
  .pichamber/locks/sessions           -> ~/.pi/agent/.pichamber/locks/sessions             (target --allow)
```

- **Landlock follows the symlinks.** A symlink in a granted folder leads to
  a target with its own grant, and the access check applies to the target.
  Pi loaded `defaultProvider`/`defaultModel` from `settings.json`, the
  provider from `models.json`, and the key from `auth.json`, all through the
  links.
- **Lock folders land in the shadow.** Pi calls `lockfile.lockSync(path,
  { realpath: false })` (`auth-storage.js:50`, `settings-manager.js:132`),
  so the `.lock` folder goes beside the symlink, not beside the target. An
  unsandboxed `fs.watch` on the shadow folder saw `rename trust.json.lock`
  and `rename settings.json.lock` during session create and `setThinking`,
  and nothing under the real `~/.pi/agent`. No `auth.json.lock` showed up
  in these runs: the key was read without the write lock, which matches the
  successful turns. Pi also created its own `models-store.json` in the
  shadow, which is the right place for it.
- **Writes to the real settings fail softly.** `sessions.setThinking
  {thinking: "high"}` returned `{}` and published `session.thinking
  {"thinking":"high"}`, and the next turn ran. The real file was unchanged
  (`real settings unchanged: true
  {"defaultProvider":"fake","defaultModel":"fake-model","defaultThinkingLevel":"off"}`),
  and the daemon stayed healthy.
- **Other projects' sessions** were unreadable (table above), as were
  `ls ~/.pi/agent/sessions/` and the other project's folder.
- **Leases.** A lease file
  (`.pichamber/locks/sessions/5ff9ff94….json`) was written through the
  linked lease folder.

**New problem: file grants are pinned to the inode.** Landlock attaches a
`--read-file` rule to the file that existed when the sandbox started. When
the real file is replaced by rename (write a temp file, then rename), the
running sandbox loses read access:

```
nono run … --read-file $R/models.json --read-file $R/settings.json -- sh -c "sleep 3; head -c 30 $R/models.json; …"
# meanwhile, outside: echo '{…}' > $R/settings.json   (in place)   and   sed -i … $R/models.json   (rename)
head: cannot open '/home/tester/.pi/agent/models.json' for reading: Permission denied
{"defaultProvider":"fake","def   rc=0
```

A fresh sandbox reads the new `models.json` fine. This bit in practice:
after a `sed -i` on `models.json`, the running sandboxed daemon created new
sessions with model `{"providerId":"unknown","modelId":"unknown"}`.
PiChamber's own model editor writes `models.json` by temp + rename
(`lib/pi/model-config-store.js:245-246`, `:280-281`, `:294-295`), and so do
most editors. Pi's `auth.json` and `settings.json` writes are in place
(`writeFileSync`) and keep working. Options:

1. Restart (or recycle at the next idle edge) every sandboxed daemon after
   PiChamber writes `models.json`, `settings.json`, `auth.json`, or
   `trust.json`, and when an outside change to them is detected. The daemon
   already reloads resources on change, so this is a restart trigger rather
   than new code.
2. Copy the files into the shadow instead of linking them, and recopy on
   change. That loses Pi's live reload of the real file and adds a sync
   step.
3. Grant read on a folder holding only these files. That needs Pi's config
   to move into a subfolder, which Pi does not support.

Option 1 is the simplest. A folder grant on `~/.pi/agent` with a deny on
`sessions/` is not possible: nono refuses to start, fail closed:

```
nono: Sandbox initialization failed: Landlock deny-overlap is not enforceable on Linux. Refusing to start with conflicting policy.
- deny '/home/tester/.pi/agent/sessions' overlaps allowed parent '/home/tester/.pi/agent' (source: profile)
```

**Static file vs per-launch flags.** Keep the profile file static and ship
it with PiChamber: groups, `security`, `linux.af_unix_mediation`,
`workdir: none`, device files. Its hash goes into the launcher identity.
Pass every path as a per-launch flag built from the structured grant list:
project and worktree folders (`--allow`), shadow folder and private tmp
(`--allow`), the real config files (`--read-file`) and `extensions/`,
`prompts/`, `themes/`, `skills/`, `tools/`, `bin/` (`--read`), the real
`sessions/<encoded cwd>` and the lease folder (`--allow`), the sandbox
profile folder (`--allow`), the runtime folder
(`--allow-unix-socket-dir-bind`), the real Node folder and the PiChamber
install (`--read`), and network flags. That way PiChamber never writes
paths into a JSON file in the data folder, and one profile file serves all
projects. `nono profile validate` checks the static file:
`[ok] All 20 group references valid`. A profile cannot `extend` a file
path (`invalid base profile name '/home/tester/exp/pichamber-profile.json'`),
only a named profile, so variants must be full copies.

### 4. Escape checks

All checks used the static profile with `--read /opt/node --read ~/exp`
and `node netprobe.mjs …` (a small `net.connect`/`fetch`/`kill` probe),
unless they ran as a bash tool call in the daemon.

**(a) Default network: loopback is open.**
`nono run $P -- node netprobe.mjs tcp 127.0.0.1 18080` gives
`CONNECTED`, and `fetch https://example.com/` gives `HTTP 200`. The fake
provider on 127.0.0.1 itself worked from inside. Finding 4.1 is confirmed
for nono: without proxy mode, a sandboxed agent reaches PiChamber's HTTP
server.

**(b) Proxy mode (`--allow-domain example.com`).** nono sets
`HTTP(S)_PROXY=http://<user>:<token>@127.0.0.1:<port>`,
`NO_PROXY=localhost,127.0.0.1`, `NONO_PROXY_TOKEN`, and
**`NODE_USE_ENV_PROXY=1` on Node 24** (the docs read as Node 26+ only).

| Probe | Result |
|---|---|
| `tcp 127.0.0.1 18080` (direct) | `EACCES connect EACCES 127.0.0.1:18080` |
| `tcp <example.com IP> 443` (direct) | `EACCES` |
| Node 24.22 `fetch https://example.com/` (with and without an explicit `NODE_USE_ENV_PROXY=1`) | `HTTP 200` (through the proxy) |
| `fetch https://pi.dev/` (not allowlisted) | `FAIL … Request was cancelled.` (proxy 403) |
| `fetch http://127.0.0.1:18080/…` (`NO_PROXY` sends it direct) | `EACCES` |
| `curl --noproxy "" http://127.0.0.1:18080/v1/x` (plain HTTP through the proxy) | `403` |
| `curl --noproxy "" -p http://127.0.0.1:18080/…` (CONNECT 127.0.0.1) | `CONNECT tunnel failed, response 403` |
| same with `localhost:18080` | `CONNECT tunnel failed, response 403` |
| `--block-net`, `tcp 127.0.0.1 18080` | `EPERM` |

With a real listener on 127.0.0.1:3001 standing in for the PiChamber
server, a bash tool call in the proxied daemon got `curl: (7) Failed to
connect to 127.0.0.1 port 3001` directly and `403` through the proxy. The
audit log recorded `"decision":"deny","denial_category":"host_denied",
"target":"127.0.0.1","port":3001,"reason":"host 127.0.0.1:3001 is not in the
allowlist"`. **Proxy mode closes the loopback escape.**

Pi's own provider traffic goes through the proxy. A second provider
`remote` (`baseUrl https://example.com/v1`, `api openai-completions`) chosen
with `sessions.setModel {model: {providerId: "remote", modelId:
"remote-model"}}` failed with
`ASSISTANT_ERROR … 405 <!doctype html>…<title>Example Domain</title>`, the
real example.com's answer. Direct connects are `EACCES` in this mode, so the
request went through the proxy. Pi's OpenAI SDK honours the environment
proxy on Node 24.22.

**Allowing a local provider port.** `--open-port 18080` and
`--allow-connect-port 18080` both let `tcp 127.0.0.1 18080` connect while
`tcp 127.0.0.1 22` stayed `EACCES`, in proxy mode and without it. A full
daemon with `--allow-domain example.com --allow-connect-port 18080` ran a
turn against the local fake provider and reached example.com from the bash
tool (`200`). Two caveats:

- Landlock TCP rules match the **port only, on any host**. Without proxy
  mode, `--allow-connect-port 18080` made `tcp 10.0.2.2 18080` (the QEMU
  host) return `ECONNREFUSED`, which means the connect was allowed. Any
  local service on that port (including PiChamber itself, if the ports
  ever coincide) becomes reachable.
- In proxy mode, `--allow-connect-port 443` let `tcp <example.com IP> 443`
  connect **directly**, past the proxy and its allowlist (without the flag:
  `EACCES`). PiChamber must never pass `--allow-connect-port` or
  `--open-port` for 80 or 443, and should treat any connect-port grant as
  "this port on every host". Use `--allow-connect-port` (dial only) rather
  than `--open-port` (dial and listen).

**(c) Pathname Unix sockets.** An unsandboxed listener at
`~/outside/other.sock` and the main (unsandboxed) daemon's socket
`/run/user/1000/pichamber/pi-daemons/base/daemon.sock`:

| | default profile | `"linux": {"af_unix_mediation": "pathname"}` |
|---|---|---|
| `unix ~/outside/other.sock` | `CONNECTED` | `EACCES` |
| `unix …/pi-daemons/base/daemon.sock` | `CONNECTED` | `EACCES` |
| abstract `\0pc-abstract-test` (unsandboxed listener; `CONNECTED` from outside) | `ECONNREFUSED` | `EACCES` |
| own socket `…/pi-daemons/sbx-projA/daemon.sock` (from a bash tool call) | — | `CONNECTED` |

With pathname mediation the real daemon still started (ready in 11.4 s),
bound its socket through `--allow-unix-socket-dir-bind`, accepted
unsandboxed clients, and ran turns. **Use `af_unix_mediation: "pathname"`**:
it blocks the sandbox from the main daemon's socket and every other
socket, so the credential file is no longer the only lock (finding 4.2).
Abstract sockets are already blocked by the default `ipc_mode`. Not tested:
the open-request socket (`open-url.sock`) under mediation; it would need an
`--allow-unix-socket <path>` grant.

**(d) Signals.** From a bash tool call in the sandboxed daemon
(`signal_mode: isolated`):

```
kill 837  -> EPERM      (837: the unsandboxed fake provider, same uid)
kill 1    -> EPERM
kill 999999 -> ESRCH
kill 2226 -> alive (ok) (the sandboxed daemon itself, same sandbox)
```

`kill(pid, 0)` across the boundary returns `EPERM` for live processes and
`ESRCH` for missing ones, so `isPidAlive` (EPERM means alive) keeps working
for the owner-server check and for leases. This was inferred above and is
now verified. The agent can signal its own daemon, which only hurts that
project's sessions.

**(e) `/proc/<pid>/root` as non-root.** Outside the sandbox, the same user
(Yama `ptrace_scope` 0) can write through it:
`echo ctl > /proc/837/root/home/tester/outside/proc-ctl.txt` succeeded. This
confirms that the bwrap escape in E2 needs no root. Inside nono:

```
echo esc > /proc/837/root/home/tester/outside/proc-escape.txt  -> Permission denied
cat /proc/837/root/home/tester/outside/file.txt                -> Permission denied
ls /proc/837/root/                                             -> Permission denied
head -c 40 /proc/837/environ                                   -> Permission denied
ls -l /proc/837/cwd                                            -> cannot read symbolic link: Permission denied
cat /proc/837/cmdline                                          -> node /home/tester/exp/fake-openai.mjs 18080
```

With `--allow ~/outside` granted, a direct write there worked (rc 0), but
the write through `/proc/837/root/…` was still denied. Landlock blocks
ptrace-mode access to processes outside the sandbox's domain, whatever the
path grants say. **nono is not exposed to the `/proc/<pid>/root` escape.**
Other processes' command lines stay readable, so never put secrets in argv
(PiChamber already passes the credential as a file).

### 5. Audit and state files

Each `nono run` creates, under `~/.local/state/nono/` (even with
`--no-audit-integrity`):

- `audit/<16-hex session id>/audit-events.ndjson`: hash-chained events
  (`session_started` with the full argv, `network` per proxy decision,
  `session_ended` with the exit code). Events are appended **live**: a
  running proxied daemon's file had 3 lines (start + 2 network events)
  before it stopped.
- `audit/<id>/session.json`: written at the end, with `command`,
  `exit_code`, `network_events` (each allow and deny with target, port, and
  reason), and `audit_integrity: null`.
- `audit/<id>/platform-audit-origin.json`.
- `audit/ledger.ndjson`: one chained line per finished session (28 lines
  after 30 runs).
- `sessions/<id>.json`: the `nono ps` record (`supervisor_pid`, `child_pid`,
  `status`, `command`, `profile`, `network`).
- `update-check.json`: written by the plain `nono setup` run, which did not
  have `NONO_NO_UPDATE_CHECK=1`.

32 audit folders built up over the session with no cleanup. The two killed
runs (the SIGKILL test and a still-running daemon) have no `session.json`.
`nono audit cleanup` exists. PiChamber should either pass `--no-audit` or
run `nono audit cleanup` on a schedule, because a proxied daemon that runs
for days grows one `audit-events.ndjson` without bound. The daemon's own
log file (stdout/stderr) stayed empty with `-s`.

### What this changes in the plan

- **Confirmed:** `nono run` works for the detached daemon with no prompt;
  PID and signal behaviour match finding 1, SIGTERM to either PID is clean,
  and `runtime.shutdown` works. The shadow agent folder with symlinks works
  under Landlock. Proxy mode blocks loopback, both direct and through
  CONNECT. Pi's Node 24 fetch uses the proxy. `kill(pid, 0)` gives `EPERM`
  across the boundary. nono has no `/proc/<pid>/root` escape.
- **Changed:**
  - Add `linux.af_unix_mediation: "pathname"` to the profile; it works with
    the daemon's socket.
  - Exclude `system_write_linux` and set a private `TMPDIR`; the `default`
    profile otherwise shares `/tmp`.
  - The real config file grants are inode-pinned, so sandboxed daemons must
    restart after config files are replaced (new phase 3 item).
  - Connect-port grants are port-wide, never for 80 or 443, and bypass the
    proxy for that port.
  - nono's command deny list does not apply to child processes.
- **Still open:**
  - the whole PiChamber server (supervisor plus routes) with a real
    launcher seam
  - `open-url.sock` under pathname mediation
  - worktree grants and the shared `.git`
  - OAuth refresh with a read-only `auth.json`
  - nono on WSL2 and macOS
  - audit file rotation beyond `nono audit cleanup`

Commands and scripts used live in the VM under `/home/tester/exp/`
(`spawn.mjs`, `client.mjs`, `client2.mjs`, `client3.mjs`, `sigtest.mjs`,
`netprobe.mjs`, `fake-openai.mjs`, `pichamber-profile*.json`). The VM was
left running.
