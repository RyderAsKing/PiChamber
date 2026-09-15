# @pi-chamber/web

PiChamber server and browser UI for the [Pi coding agent](https://pi.dev). It serves the browser workspace and authenticated Pi routes, and owns its per-profile Pi session daemon.

## Requirements

Node.js 22 or newer, or Bun.

Background `pichamber serve` prefers Node.js 22 or newer and falls back to Bun when no supported Node is on PATH. Foreground mode runs in the current process. Startup services reuse the runtime executable that ran `startup enable` (the Node or Bun binary, not the package manager). Docker images launch via Bun in the image entrypoint, but background `serve` still applies the same automatic selection when a supported Node is installed in the container.

## Install

```sh
bun add -g @pi-chamber/web
```

Other package managers:

```sh
npm install -g @pi-chamber/web
pnpm add -g @pi-chamber/web
yarn global add @pi-chamber/web
```

Run without installing:

```sh
bunx @pi-chamber/web serve
npx @pi-chamber/web serve
pnpm dlx @pi-chamber/web serve
```

## Quick start

In an interactive terminal:

```sh
pichamber serve
```

The command walks through access, port, authentication, browser UI versus API-only, and background versus foreground mode, then shows a review before starting. Open the printed URL. Bare `pichamber` starts with default settings without the wizard.

For scripts and non-interactive shells, pass the setup flags explicitly:

```sh
pichamber serve --port 3000 --ui-password "choose-a-strong-password"
pichamber serve --port 3000 --lan --ui-password "choose-a-strong-password"
pichamber serve --port 3000 --api-only --ui-password "choose-a-strong-password"
```

## Commands

Run `pichamber --help` for the current flags.

| Command | What it does |
| --- | --- |
| `serve` | Start the server (guided setup in interactive terminals, with a review before starting) |
| `status` | Show running instances |
| `logs` | Tail logs (`--no-follow` for a one-time tail) |
| `stop` / `restart` | Stop or restart instances (broad stops confirm when more than one is affected; `--force` skips) |
| `startup` | Run at login or boot (`enable` is guided; `status` / `disable` to inspect or remove) |
| `tunnel` | Expose the server via Cloudflare Tunnel (`start` is guided; profiles cover repeatable runs) |
| `connect-url` | Create a one-time pairing link for another client (`--qr` in interactive terminals; starts the server if needed) |
| `update` | Install updates (reviews before changing anything; `--yes` skips confirmation, `--channel stable\|rc` overrides once) |
| `version` | Print the installed version |

## Scripts and automation

`--quiet` and `--json` never prompt, and non-interactive shells never prompt either. Supply required values as flags. `--json` emits JSON only; `--quiet` keeps one concise result line.

## Security

Servers reachable beyond this machine require a UI password. Pass `--ui-password` (omit the value to generate one) or set `PICHAMBER_UI_PASSWORD`. Prefer `--lan` only on a trusted network.

## Docs

Full guides live in the PiChamber repository:

- [Install](https://github.com/RyderAsKing/PiChamber/blob/main/packages/docs/content/docs/install.mdx)
- [Quick start](https://github.com/RyderAsKing/PiChamber/blob/main/packages/docs/content/docs/quickstart.mdx)
- [CLI guide](https://github.com/RyderAsKing/PiChamber/blob/main/packages/docs/content/docs/cli.mdx)
- [Releases](https://github.com/RyderAsKing/PiChamber/releases/latest)

## License

MIT. See [LICENSE](https://github.com/RyderAsKing/PiChamber/blob/main/LICENSE).
