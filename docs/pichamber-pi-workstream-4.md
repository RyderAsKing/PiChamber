# PiChamber Pi Migration: Workstream 4 Implementation Record

## Status and scope

Workstream 4 integrates Pi providers and configuration without making the
private Pi daemon or its credentials browser-visible. It completes the
provider/settings scope from the [migration plan](./pichamber-pimigration.md):
Pi model discovery and authentication, Pi `settings.json` defaults,
credential-blind `models.json` editing, and PiChamber-owned defaults.

Project-trust dialogs, AGENTS.md, skills, templates, Magic Prompts, and
resource settings remain Workstream 5. Walkthrough execution remains
Workstream 6; this workstream only persists its PiChamber-owned model override.

## Ownership and contracts

| Owner | Data | Behavior |
| --- | --- | --- |
| Pi | `auth.json` | API keys and OAuth credentials are written by Pi's `ModelRuntime.login` and never returned to the browser. |
| Pi | `models.json` | `model-config-store.js` atomically writes a validated custom provider/model configuration. It preserves unrelated provider entries. Literal keys do not enter this file; `{env:NAME}` references may be persisted. Headers are write-only. |
| Pi | global/project `settings.json`, `trust.json` | The daemon reads and writes Pi default model/thinking settings through `SettingsManager`; it exposes a stable trust/default projection only. |
| PiChamber | PiChamber data root `pi/settings.json` | Atomic mode-`0600` sidecar for default session model/thinking and small/walkthrough model overrides. It never edits Pi settings or credentials. |

The browser calls authenticated `/api/pi/*` routes only. The routes project
allowlisted catalog, login, setting, and model configuration fields to the
private daemon IPC. Public responses exclude API keys, stored credentials,
provider headers, daemon endpoint/credential/PID, and filesystem paths.

## Provider behavior

- Provider catalog and auth status come from Pi's live model runtime.
- API-key authentication forwards the key once over authenticated private IPC.
  OAuth browser/device/manual-code flows use an expiring opaque login ID and
  public prompt/URL/device-code state only.
- Custom OpenAI-compatible providers are created or edited in Settings. The
  daemon rejects updates during a streaming turn, atomically writes Pi
  `models.json`, then rehydrates the idle runtime so model discovery is
  authoritative immediately.
- Browser requests have a 30-second client timeout and capture the runtime
  key; a remote runtime switch rejects stale responses rather than applying
  them to the current UI.

## Defaults precedence

New sessions apply an explicit UI model/thinking selection first, then an
explicit PiChamber sidecar default, then Pi's normal settings fallback. Small
and walkthrough model selections are stored for their owning follow-up flows;
they do not alter normal session creation. Existing session model/thinking
choices remain session-authoritative.

## Validation evidence

Focused validation completed for this workstream:

- `bun test packages/web/server/lib/pi/model-config-store.test.js packages/web/server/lib/pi/settings-store.test.js packages/web/server/lib/pi/session-daemon/session-daemon.test.js packages/web/server/lib/pi/routes.test.js`
- `bun test packages/ui/src/lib/pi/client.test.ts`
- `bun run type-check:ui`
- `bun run lint:ui`
- `bun run type-check:web`
- `bun run lint:web`
- `bun run build:web`
- `bun run dead-code` with report review
- `git diff --check`

Focused tests cover model-config atomicity/redaction, settings-sidecar
separation, daemon provider login/configuration/settings/trust behavior,
route credential/header redaction, and client request shapes. The existing
SSE test teardown explicitly closes its test-only connection before closing
its listener, so the focused route suite completes.

Manual visual validation is still unavailable in this environment because no
browser automation binary is installed. This is not a code-path blocker: the
settings components use the existing Settings primitives, i18n strings, and
theme tokens, but desktop/mobile screenshots remain follow-up evidence.
