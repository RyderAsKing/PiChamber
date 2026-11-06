# Open requests

## Purpose

When a tool on the server machine wants to show the person a URL (an extension starting a review page, `gh auth login --web`, Python's `webbrowser`), PiChamber shows it on the person's devices instead of opening a browser on the server. The mechanism is generic: anything that honors `$BROWSER` takes part, with no per-tool code. See `GLOSSARY.md` ("Open request").

## Flow

1. `daemon-process.js` calls `ensureOpenUrlBrowser` (`browser-env.js`) before any session starts. It writes an owner-only launcher script and points `$BROWSER` at it, keeping the previous value in `PICHAMBER_ORIGINAL_BROWSER` and the intake path in `PICHAMBER_OPEN_URL_SOCKET`. Every bash command and in-process extension inherits that environment. A watchdog (`watchOpenUrlBrowser`) re-checks the launcher every minute for the life of the daemon.
2. The launcher runs `browser-handler.mjs` with the URL arguments. Each http(s) URL is posted to the intake together with `PI_SESSION_ID` when the caller is a bash command.
3. `intake.js`, bound by the PiChamber server (`index.js`) on `<runtimeDir>/open-url.sock`, asks the daemon to publish (`openUrl.publish`). The daemon attributes the request (`session-daemon/open-request.js`) and publishes `session.openUrl` on that session's event stream.
4. Devices ask the person whether to open it (`packages/ui/src/components/chat/OpenRequestAlerts.tsx`). Nothing opens without a click.
5. The intake answers `{ delivered }`. `delivered` is true only when a device holds a live `/api/pi/events` stream and the daemon published. Otherwise the handler falls back to the original `$BROWSER` list, then `open` (macOS) or `xdg-open`, with `$BROWSER` restored in that child's environment so it cannot loop back.

Extensions in PiChamber can call `ctx.ui.openUrl(url)` (gate with `isPiChamber(ctx)`). It runs the same handler in-process with the exact session id and resolves whether the URL was shown or opened.

## Invariants

- The intake is a Unix socket in the profile's private runtime directory (directory `0700`, socket `0600`). Filesystem permissions are the only access check; no token is involved. The HTTP app, its auth middleware, and the relay cannot reach it.
- Only http(s) URLs up to 4096 characters are published. Anything else (a file path, `file:` URL) goes straight to the fallback.
- A request is never both published and opened on the server: with no connected device the intake skips the daemon.
- Attribution is exact for bash commands (`PI_SESSION_ID`, when that session is resident). Otherwise the sole busy resident session owns it. Otherwise it rides on the most recently active session with `attributed: false`, and devices only show a notice.
- `session.openUrl` is never stored in a transcript. The daemon replay log may resend it; the public projection stamps `serverNow` so devices judge age on the server's clock and ignore stale ones.
- The launcher only lives in a directory owned by this user, not a symlink, and writable by nobody else. Candidates, in order: the intake socket's directory, the daemon's private profile directory, then a fresh `mkdtemp` directory under the system temp directory. The launcher is written through an exclusive temp file and verified (owner, mode, exact contents) before `$BROWSER` points at it.
- Recovery: the daemon's watchdog reinstalls the launcher when it is missing or changed (temp cleaners, logout removing `XDG_RUNTIME_DIR`). If no candidate is usable, `$BROWSER` goes back to the user's original value and the PiChamber variables are removed. The server likewise re-binds the intake socket when its path disappears. A reboot ends the daemon; the next daemon installs everything afresh, so nothing on disk needs to survive one.
- Windows does nothing: `$BROWSER` is not installed and the intake does not start. Tools there open the system browser as before.

## Known limits

- A reused daemon keeps the environment it started with. A daemon started by an older PiChamber has no `$BROWSER` handler until it restarts.
- The launcher path must contain no whitespace, quotes, or `:`, because many tools split `$BROWSER` on them. When the runtime and profile directories contain one (macOS "Application Support"), the launcher lives under the system temp directory; if that is unsafe too, the feature stays off.
- Commands already running keep the `$BROWSER` they started with. If the watchdog moves or removes the launcher, only commands started afterwards see the change.
- A background browser tab counts as a connected device, so the server will not open the URL itself while one is open.
- Tools that call `open` or `xdg-open` directly, without `$BROWSER`, are not intercepted.
- Only Pi runtimes are attributed; sessions owned by other engines receive unattributed requests.
