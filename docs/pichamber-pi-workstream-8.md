# PiChamber Pi Migration: Workstream 8 Implementation Record

## Status and scope

This record documents the completed Workstream 8 (Update ownership) for the PiChamber Pi migration plan:

- **PiChamber Release Ownership**: PiChamber package releases own embedded Pi SDK updates.
- **Pi CLI Independence**: Separately installed Pi CLI executables remain independent and are never mutated or updated by PiChamber.
- **Electron Native Updater**: Electron retains native application update behavior (`electron-updater`).
- **Deployment-Aware Headless Update**: `pichamber update` CLI installs the new `@pichamber/web` package before stopping or restarting running instances, preventing instance destruction on failed updates.
- **Supervisor & Container Environment Safety**: Docker containers and systemd service units report/use their native image/package deployment mechanisms rather than running unsafe in-app package replacements.
- **OpenCode Upgrade Removal**: All separate OpenCode upgrade checks, routes (`POST /api/opencode/upgrade`, `GET /api/opencode/upgrade-status`), toasts (`OpenCodeUpdateToast`), binary upgrade capability logic (`upgrade-capability.js`), and settings controls are removed.

## Implemented architecture

| Component | Responsibility / Contract |
| --- | --- |
| Headless CLI Update | `packages/web/bin/lib/commands-update.js` checks for updates, guards Docker (`fs.existsSync('/.dockerenv')`) and systemd (`INVOCATION_ID`) environments, installs package before restart, and safely restarts instances only after success. |
| Server Update Route | `packages/web/server/lib/opencode/pichamber-routes.js` (`/api/openchamber/update-install`) rejects container mode in-app replacement with HTTP 409 and delegates to container image update workflows. |
| UI & About Dialog | `packages/ui/src/components/sections/pichamber/AboutSettings.tsx` and `AboutDialog.tsx` display PiChamber version and native update status without OpenCode upgrade calls or toasts. |
| Cleanup | Removed `upgrade-capability.js`, `routes-upgrade.test.js`, `OpenCodeUpdateToast.tsx`, `openCodeUpdateDedup.ts`, and related OpenCode upgrade settings. |

## Validation evidence

- `bun test packages/web/bin/lib/commands-update.test.js`
- `bun test packages/web/server/lib/opencode/pichamber-routes.test.js`
- `bun test packages/ui`
- `bun run type-check:web`
- `bun run type-check:ui`
- `bun run type-check:electron`
- `bun run lint:web`
- `bun run lint:ui`
- `bun run lint:electron`
- `bun run dead-code`
