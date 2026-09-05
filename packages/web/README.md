# @pi-chamber/web

PiChamber's web server and browser UI for the Pi coding-agent runtime.

## Run

```bash
pichamber serve
```

In an interactive terminal, `pichamber serve` guides you through access, port,
authentication, browser UI versus API-only content, and background versus
foreground process mode. It shows a review before starting. The server starts
warming the local Pi session daemon as soon as HTTP is listening, serves the
browser UI, and exposes authenticated Pi routes under `/api/pi/*`. HTTP
readiness does not wait for Pi provider/model initialization; early Pi requests
share the supervisor's in-flight startup.

For scripts and non-interactive shells, pass the setup flags explicitly:

```bash
pichamber serve --port 3000 --ui-password <password>
pichamber serve --port 8080 --lan --ui-password <password>
pichamber serve --port 3000 --api-only --ui-password <password>
pichamber connect-url --port 3000 --qr
pichamber stop --port 3000
```

`--quiet` and `--json` never prompt. Use `pichamber stop --force` when a broad
stop should skip confirmation, and `pichamber logs --no-follow` for a one-time
log tail. Use `pichamber update --yes` to update without the interactive review.

Use `--api-only` for a host intended to be paired from a PiChamber desktop or mobile client. LAN-bound servers require a UI password unless the explicit unsafe-development override is set.

See the [CLI guide](../docs/content/docs/cli.mdx) for guided startup, updates,
tunnels, logs, pairing, and machine-readable output.

## Runtime contract

- Pi session state and actions are served only through `/api/pi/*`.
- `POST /api/pi/attachments` accepts raw `application/octet-stream` bodies with bounded `X-PiChamber-Filename` and `X-PiChamber-Mime` metadata. It returns opaque attachment metadata plus `expiresAt`; filesystem paths remain private. The legacy base64 JSON body remains available for persisted clients. `DELETE /api/pi/attachments/:id` removes an unused upload. Prompt routes accept at most 20 attachment IDs and retire accepted uploads from the active 32-upload map while retaining their files until the one-hour expiry.
- PiChamber-owned UI settings, snippets, custom themes, and updates use `/api/pi/ui-settings`, `/api/pi/snippets`, `/api/pi/themes`, `/api/pi/update-check`, and `/api/pi/update-install`; removed `/api/config/*` and `/api/pichamber/*` aliases are not required. Snippets persist in the PiChamber data root (`snippets.json`) and expand through literal `#name` replacement; Pi prompt templates remain Pi-owned `/name` commands in Pi's global and trusted-project prompt directories, discovered through the active runtime's resource loader and exposed through `/api/pi/resources`, `/api/pi/resources/prompts`, and `/api/pi/commands`. Pi skills invoke as `/skill:name` (bare `/name` never invokes a skill) and extension commands use their registered `/name` (including Pi-generated suffixes); `/api/pi/commands` exposes prompts as `name`, skills as `skill:name`, and extensions under their invocation names, executed via Pi's `session.prompt()` with extension-first precedence. Snippet, prompt-template, skill, and extension-command concepts stay distinct with separate Settings pages, stores, persistence, and caches; they share only `/` autocomplete presentation. New-session starters are pinned Pi prompt templates that insert `/name ` for editing (never submit or expand in PiChamber); legacy skill starters are removed without conversion.
- Final-only speech-to-text uses authenticated `/api/stt/*` routes and `/api/stt/ws`. Local model inference runs in a forked worker, while remote provider credentials remain in server configuration.
- Browser and paired clients authenticate with UI sessions or scoped client credentials.
- `connect-url` creates a one-time pairing link; credentials are not written to URLs or logs.
- The server owns the Pi daemon lifecycle and stops its locally managed daemon during shutdown.

## Development

```bash
bun run --cwd packages/web build
bun run --cwd packages/web type-check
bun run --cwd packages/web test
```

Build flags:

- `VITE_REACT_COMPILER=1` re-enables the `babel-plugin-react-compiler` pass for
  release builds. It is opt-in because the pass costs ~25s of the ~52s
  production build; the default build ships without compiler memoization.
- `VITE_ENABLE_REACT_SCAN=1` injects the react-scan dev script into the page.
