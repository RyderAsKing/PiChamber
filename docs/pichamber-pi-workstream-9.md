# PiChamber Pi Migration — Workstream 9 Completion Record

## Scope

Workstream 9 removes released OpenCode-runtime ownership and updates product documentation for the Pi-native cutover.

## Completed cleanup

- Removed unmounted server feature trees and UI stores that depended on the former runtime: event proxying, lifecycle/update state, catalog installation, quota, voice/dictation/TTS, walkthrough, managed worktrees, and the associated tests.
- Removed stale runtime URL proxying, URL-auth allowlist entries, directory-header encoding, and release workflow steps that invoked deleted CLI preparation scripts.
- Narrowed URL-token authentication to the Pi event stream and kept the existing bearer-token boundary for all other API routes.
- Removed OpenCode-specific settings, shortcuts, provider/config wording, metadata, environment setup, Docker mounts, and obsolete test fixtures.
- Replaced public docs with Pi-native installation, server, pairing, security, environment, and troubleshooting guidance; removed obsolete localized pages rather than publishing inaccurate translations.
- Preserved required PiChamber attribution and intentionally retained internal `pichamber-*` compatibility identifiers that are not an agent-runtime dependency.

## Validation

Validation for this cleanup is recorded with the pull request: focused runtime URL/auth tests, the web test suite, UI and web type checks, documentation validation, JavaScript syntax checks, and dead-code inspection.

## Follow-up boundary

This record closes deletion and documentation work for the Pi core release. Future PiChamber feature work must be designed and implemented as Pi-native capability work; it must not restore a legacy runtime, proxy, SDK contract, or configuration path.
