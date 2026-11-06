# Server Browser

The **Server** Browser route (see `GLOSSARY.md`) runs pages in a headless
Chrome on the PiChamber server and streams them to the device. Pages use the
server's network, so `localhost` reaches the server's dev servers from any
device. They run in Chrome's own profile, never on PiChamber's origin, so a
page cannot act as the signed-in person in PiChamber. Agents have no access to
this browser.

The **This device** route does not use this module: the desktop app shows a
native webview and other runtimes an iframe. `PreviewPane` still uses the
preview proxy (`../preview/proxy-runtime.js`); this module does not.

## Ownership

- `chrome-executable.js`: finds Chrome or Chromium (`PICHAMBER_BROWSER_CHROME`,
  then `CHROME`, then `PATH` and standard install locations, then the newest
  full Chromium in the Playwright cache) and the install commands shown when
  none is found. PiChamber never downloads or installs a browser.
- `browser-process.js`: launches Chrome with `--remote-debugging-pipe` and
  classifies launch failures (missing library, sandbox refused as root, no
  user namespaces, unknown).
- `cdp.js`: the DevTools protocol over the pipe (NUL-delimited JSON on fd 3/4)
  with flat sessions and per-command timeouts.
- `server-browser.js`: one Chrome per server, its profile, tabs keyed by the
  client's tab key, popups, downloads, uploads, idle shutdown, and the
  sandbox setting (`settings.json`).
- `browser-tab.js`: one page: screencast, input, navigation and history,
  dialogs, file choosers, inspect, clipboard, and the
  server-network rule.
- `dev-servers.js`: lists web servers listening on the server's loopback
  interface for the browser's blank page.
- `frame-policy.js`: whether a public site refuses to be shown in an iframe
  (X-Frame-Options, CSP `frame-ancestors`), for the **This device** browser
  on the web.
- `runtime.js`: HTTP routes and the viewer WebSocket.

Files live under `<dataDir>/server-browser/`: `profile/` (cookies, logins,
site data), `downloads/`, `uploads/`, and `settings.json`, all owner-only.

## Routes

- `GET /api/server-browser/status`: whether Chrome is available, and why not.
- `PUT /api/server-browser/settings`: `{ allowNoSandbox }`.
- `POST /api/server-browser/clear-data`: stops Chrome (waiting for a launch
  in progress) and deletes the profile; Chrome does not start again until the
  profile is gone. Viewers reconnect and their pages reload, signed out.
- `DELETE /api/server-browser/tabs/:key`: closes a tab's page (the client
  calls this when a Browser page or the Browser panel tab closes).
- `POST /api/server-browser/uploads?name=`: stores a file for a page's file
  chooser (up to 512 MB); returns its id. Uploads are deleted after an hour.
- `GET /api/server-browser/downloads/:id`: a finished download.
- `GET /api/server-browser/dev-servers?directory=`: web servers on the
  server, the project's own first. Each entry has the port, page title,
  process name, and whether the process runs inside `directory`; never
  command lines or paths. Linux reads `/proc`; macOS runs `lsof`; Windows
  reports `supported: false`. Ports below 1024, PiChamber's own process and
  port, and ports that do not answer HTTP are left out. Results are cached
  for 3 seconds.

- `GET /api/server-browser/frame-policy?url=&origin=`: `refused` (with the
  header that refused), `allowed`, or `unknown` for a page shown in an
  iframe on `origin`. The web **This device** browser replaces the page with
  an explanation only on `refused`. Only public addresses are fetched: the
  URL, every redirect, and every resolved IP address must be outside the
  server's network (`isServerNetworkHost`), or the answer is `unknown`. It
  reads response headers only (5-second timeout, 5 redirects) and caches
  answers for a minute.

## Viewer Protocol

Viewers connect to `/api/server-browser/ws?tab=<key>&url=<start>` through
`openRuntimeWebSocket` with a URL token; the path is on the URL-token and
relay WebSocket allowlists. The tab key is derived from the directory and
the Browser page id (`serverBrowserTabKey`), so every device viewing the
same page shares one server page.

Binary server messages are frames: a 4-byte big-endian header length, a JSON
header (`seq`, `width`, `height`, `offsetTop`, `pageScaleFactor`), then a
JPEG. Each viewer acknowledges a frame (`{ type: 'ack' }`) once it is on
screen; at most two frames are in flight per viewer, so a slow device gets
fewer frames instead of a backlog. A viewer disconnects shortly after its page
is hidden (the window is in the background, the panel is closed, or another
Browser page is active) and reconnects when it is shown; the server page stays
open meanwhile. Chrome draws about 60 frames a second for a second after any
viewer input and about 30 otherwise, so a page that animates on its own does
not keep the server busy at the full rate. The server has no GPU: Chrome draws
on the CPU, and effects such as `backdrop-filter` cost far more there than in
a desktop browser.

Text messages from the server: `state` (address, title, loading, history,
crashed), `cursor`, `dialog` / `dialog-closed`, `file-chooser`
/ `file-chooser-closed`, `download`, `clipboard`, `inspect-hover`,
`inspect-pick`, `notice`, and `unavailable`.

Messages from the viewer: `viewport`, `mouse`, `key`, `text`,
`navigate`, `back`, `forward`, `reload`, `stop`, `dialog`, `file-chooser`,
`inspect`, and `ack`. They apply in arrival order; acks skip the queue.
Mouse moves and wheel events never wait for Chrome: while one is on its way
to the page, newer moves replace it and newer wheel movement is added up into
one event (a change of modifiers starts a new one). Chrome answers a wheel
event only after the page handles it, so sending each one in turn made busy
pages scroll seconds behind a trackpad. Any other mouse input first waits
for the moves and wheel movement before it.

Close codes: 4000 tab closed, 4001 Chrome exited, 4002 Chrome restarting,
4003 unavailable (the client shows setup help), 4004 bad request (the client
stops). The client reconnects after anything else with backoff; the server
reopens the tab at its last address.

## Invariants

- **Server-network rule.** A public page cannot load a server-local or
  private address in the main frame or a subframe, by link, script, or
  redirect. A public page's load of a name (not an IP address) is also
  checked against every address the name resolves to; a name that does not
  resolve within 5 seconds does not load, and Chrome shows its error page. A
  name that resolves differently on Chrome's own lookup (DNS rebinding) is
  not caught. Loads the
  person asked for (typed address, back, forward, reload) pass until that
  address commits; a later load from the page is checked again. A blocked
  load is cancelled (`Aborted`), the address shown returns to the last
  committed one, and viewers get one `blocked-server-network` notice.
  Subresource requests are not checked.
- **Popups** are held before they load anything (`Target.setAutoAttach`
  with `waitForDebuggerOnStart`). Their first document request is cancelled,
  the popup closes, and its address loads in the opener's tab under the same
  rule as a followed link. The new page has no `window.opener`.
- **Page swaps.** Commands to a page retry for up to 3 seconds while Chrome
  swaps its renderer ("Not attached to an active page").
- **Error pages** show the address that failed (`unreachableUrl`), not
  `chrome-error://`.
- **Keyboard.** Paste uses the device's clipboard (sent as `text`); a copy in
  the page sends `clipboard` to the device, since headless Chrome has none.
- **Lifecycle.** A tab with no viewers stays open for 10 minutes; at most 6
  such pages stay open and 16 in total. Chrome exits 5 minutes after its last
  page closes and restarts on demand, and is stopped if its setup after launch
  fails. Reopened tabs load their remembered address.
- **Sandbox.** Chrome runs without its sandbox only after the person allows
  it in the setup panel (`settings.json`) or `PICHAMBER_BROWSER_NO_SANDBOX=1`
  is set. The panel offers it when Chrome refuses its sandbox as root or
  cannot create one (no user namespaces).
- **Downloads.** Headless Chrome has no PDF viewer, so PDFs arrive as
  downloads. The newest 50 downloads are kept.

## Limits

No audio, no extensions, no DRM video. Pages see the running Chrome's user
agent and client hints without the `HeadlessChrome` marker, which many sites
refuse.
