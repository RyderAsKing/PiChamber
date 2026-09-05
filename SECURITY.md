# Security policy

## Report a vulnerability

Please report security vulnerabilities privately. Do not open a public GitHub
issue, discussion, or pull request for a vulnerability.

**Email:** [security@pichamber.dev](mailto:security@pichamber.dev)

Include:

- the affected PiChamber version and runtime
- a short description of the impact
- reliable reproduction steps or a proof of concept
- any relevant configuration details that are safe to share

Remove passwords, provider keys, pairing links, client tokens, session content,
file contents, and personal data before sending a report. If email is not
available, use GitHub's private vulnerability reporting flow from the
[Security tab](https://github.com/RyderAsKing/PiChamber/security) when it is
enabled for the repository.

We will acknowledge a report within 48 hours when possible. The latest release
is the only supported security-fix line. There is no LTS or backport policy at
this time.

## Scope

PiChamber can expose a user's local workspace to any authenticated or paired
client. Reports are especially useful for issues involving:

- UI password sessions, client tokens, pairing tickets, QR links, and URL-scoped auth tokens
- the Pi session daemon, `/api/pi/*` routes, Pi configuration, provider credentials, and session data
- terminal PTYs, file operations, Git credentials, SSH integration, and worktree operations
- Cloudflare tunnels, private relay traffic, reverse-proxy handling, SSE, and WebSocket authentication
- Electron preload or main-process privilege boundaries, deep links, auto-update, and packaged startup
- attachment uploads, speech-to-text handling, and data stored in the PiChamber data directory

A successful login or pairing grants access to the server's sessions and
filesystem by design. Reports should distinguish an intended authenticated
operation from an authorization bypass or an unintended disclosure.
