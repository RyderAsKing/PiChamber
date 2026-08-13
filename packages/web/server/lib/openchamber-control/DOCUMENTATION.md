# PiChamber Control Service

## Purpose

This module owns the typed control contract shared by the PiChamber CLI and the managed OpenCode `openchamber` tool. Both adapters delegate to `createPiChamberControlService()`; neither adapter may call or spawn the other.

## Boundaries

- `service.js` validates and executes the fixed project, model, and session action allowlist.
- `actions.js` defines the agent-visible action metadata consumed by the managed tool.
- `routes.js` is the authenticated CLI HTTP adapter. It forwards one action, preserves status and partial-result details, and propagates request cancellation.
- `../agent-tool/runtime.js` is the managed-tool adapter. It wraps service results in the versioned native-tool envelope and uses a separate ephemeral loopback credential.
- `../openchamber-sessions/routes.js` owns session create, prompt, and fork operations.

## Invariants

- Session status and messages come from official directory-scoped OpenCode APIs. Message output includes only ordered `text` parts.
- Wait never treats an initial idle response as completion after dispatch. It requires observed activity or a newly completed assistant message.
- Timeout and cancellation are failures, never authoritative idle results.
- Validation that protects side effects runs before session creation or dispatch.
- Explicit `projectId` or `directory` scope takes precedence over the managed tool's current-session directory fallback; the fallback never creates a conflicting second scope.
- One failed directory status lookup produces `unknown` for only that directory and does not erase other session results.
- Destructive session/worktree deletion and project-path registration are not part of the action contract.
