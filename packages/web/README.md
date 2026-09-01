# @pi-chamber/web

PiChamber's web server and browser UI for the Pi coding-agent runtime.

## Run

```bash
pichamber serve --port 3000
```

The server starts warming the local Pi session daemon as soon as HTTP is listening, serves the browser UI, and exposes authenticated Pi routes under `/api/pi/*`. HTTP readiness does not wait for Pi provider/model initialization; early Pi requests share the supervisor's in-flight startup.

```bash
pichamber serve --port 8080
pichamber serve --lan --ui-password <password>
pichamber connect-url --port 3000 --qr
pichamber stop
```

Use `--api-only` for a host intended to be paired from a PiChamber desktop or mobile client. LAN-bound servers require a UI password unless the explicit unsafe-development override is set.

## Runtime contract

- Pi session state and actions are served only through `/api/pi/*`.
- `POST /api/pi/attachments` accepts raw `application/octet-stream` bodies with bounded `X-PiChamber-Filename` and `X-PiChamber-Mime` metadata. It returns opaque attachment metadata plus `expiresAt`; filesystem paths remain private. The legacy base64 JSON body remains available for persisted clients. `DELETE /api/pi/attachments/:id` removes an unused upload. Prompt routes accept at most 20 attachment IDs and retire accepted uploads from the active 32-upload map while retaining their files until the one-hour expiry.
- PiChamber-owned UI settings, custom themes, and update metadata use `/api/pi/ui-settings`, `/api/pi/themes`, and `/api/pi/update-check`; removed `/api/config/*` and `/api/pichamber/*` aliases are not required.
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
