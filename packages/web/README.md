# @pichamber/web

PiChamber's web server and browser UI for the Pi coding-agent runtime.

## Run

```bash
pichamber serve --port 3000
```

The server starts the local Pi session daemon, serves the browser UI, and exposes authenticated Pi routes under `/api/pi/*`.

```bash
pichamber serve --port 8080
pichamber serve --lan --ui-password <password>
pichamber connect-url --port 3000 --qr
pichamber stop
```

Use `--api-only` for a host intended to be paired from a PiChamber desktop or mobile client. LAN-bound servers require a UI password unless the explicit unsafe-development override is set.

## Runtime contract

- Pi session state and actions are served only through `/api/pi/*`.
- PiChamber-owned UI settings, custom themes, and update metadata use `/api/pi/ui-settings`, `/api/pi/themes`, and `/api/pi/update-check`; removed `/api/config/*` and `/api/pichamber/*` aliases are not required.
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
