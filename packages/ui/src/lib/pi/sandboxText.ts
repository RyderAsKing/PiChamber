/**
 * User-facing text for project sandboxes (#242). Reason codes come from the
 * server (`PiSandboxLauncherStatus.reason`, `PiProjectSandboxState.availability.reason`,
 * `PiRequestError.reason`); unknown codes fall back to a generic sentence so
 * a newer server never renders an empty or raw-code message.
 */

import type { PiSessionPendingSwitch } from './types';

const REASON_TEXT: Record<string, string> = {
  NOT_INSTALLED: 'nono is not installed on the server machine.',
  NO_LANDLOCK: 'The server machine\'s kernel does not support Landlock, which nono needs.',
  TOO_OLD: 'The installed nono is too old. Update nono on the server machine.',
  VERSION_UNKNOWN: 'PiChamber could not read the installed nono version.',
  SETUP_CHECK_FAILED: 'nono\'s setup check failed on the server machine.',
  UNSUPPORTED_PLATFORM: 'nono sandboxing needs a Linux, WSL2 or macOS server.',
  WSL_KERNEL_TOO_OLD: 'This WSL kernel is too old for nono to filter network traffic. Run wsl --update in Windows, then check again.',
  SANDBOX_LIMITS_NOT_ACCEPTED: 'Sandboxing on this server has a limit you have not accepted. Review it in Settings, Projects, Sandboxing.',
  SANDBOX_NOT_PROBED: 'Sandboxing has not been checked yet.',
  PROVIDER_HOSTS_UNAVAILABLE: 'PiChamber could not read which model providers the sandbox should reach.',
  INVALID_SANDBOX_SETTING: 'This project\'s sandbox setting could not be read. Save it again.',
  SANDBOX_GRANT_REFUSED: 'This project cannot be sandboxed: its folder or one of its extra folders overlaps PiChamber\'s own data or Pi\'s settings folder.',
  SANDBOX_PROFILE_UNREADABLE: 'nono could not read PiChamber\'s sandbox profile.',
  SANDBOX_PROFILE_INVALID: 'The custom sandbox profile on this server is not valid, so sandboxes do not start. Fix it or reset it in Settings, Projects, Sandboxing.',
  SANDBOX_LAUNCH_FAILED: 'The sandbox failed to start.',
  SANDBOX_SETTING_CHANGED: 'The sandbox setting changed while the sandbox was starting. Try again.',
  SANDBOX_WORKTREE_OUTSIDE_FOLDER: 'This worktree was made before its project was sandboxed, in a folder shared with another copy of the repository, so it cannot run in the sandbox. Remove it and create it again.',
  SANDBOX_SESSION_FOLDER_SHARED: 'Another project\'s path maps to the same Pi session folder as this one, so a sandbox cannot be kept to this project. Turn the sandbox off, or remove the other project.',
  SANDBOX_WORKTREE_IDS_UNREADABLE: 'PiChamber could not read its record of this project\'s worktrees on the server machine.',
  SANDBOX_SETTINGS_UNREADABLE: 'PiChamber could not read its sandbox settings on the server machine.',
  SANDBOX_PORT_REFUSED: 'One of this project\'s local ports cannot be allowed in a sandbox.',
  SANDBOX_INVALID_NETWORK: 'One of this project\'s allowed hosts or local ports is not valid.',
  SANDBOX_SHADOW_CONFLICT: 'A file in PiChamber\'s sandbox folder for this project is in the way. Remove it on the server machine.',
  DAEMON_START_TIMEOUT: 'The sandbox took too long to start. Try again.',
};

const LIMIT_TEXT: Record<string, { title: string; text: string }> = {
  UNIX_SOCKETS: {
    title: 'Unix sockets are not blocked',
    text: 'Code in the sandbox can ask local services such as the systemd user manager, D-Bus, an SSH or GPG agent, or Docker to run commands outside it.',
  },
  PROXY_PORT: {
    title: 'Allowed hosts can be bypassed',
    text: 'nono cannot check where connections on its proxy\'s port go, so code in the sandbox can send data to any server that listens on that port.',
  },
};

/** What a sandbox cannot enforce on the server machine: a short title and a
 *  sentence explaining it. */
export const sandboxLimitText = (limit: string): { title: string; text: string } => (
  Object.prototype.hasOwnProperty.call(LIMIT_TEXT, limit)
    ? LIMIT_TEXT[limit]
    : { title: 'Part of the policy is not enforced', text: 'The sandbox on this server cannot enforce part of its policy.' }
);

/** One sentence explaining why a sandbox cannot run. */
export const sandboxReasonText = (reason: string | undefined): string => {
  if (reason && Object.prototype.hasOwnProperty.call(REASON_TEXT, reason)) {
    return REASON_TEXT[reason];
  }
  return 'The sandbox is unavailable on the server machine.';
};

interface SessionSandboxState {
  sandboxed: boolean;
  pendingSwitch?: PiSessionPendingSwitch;
}

export interface SessionSandboxLabel {
  /** A closed lock while the session runs sandboxed; an open lock while it
   *  waits to change, the only time an unlocked state is shown. */
  icon: 'lock' | 'lock-unlock';
  /** Tooltip and screen-reader text. */
  text: string;
}

/**
 * Mark for one session's sandbox state, or null when it runs unsandboxed
 * with nothing pending. A pending switch wins: the session still runs the
 * old way until its turn ends.
 */
export const sessionSandboxLabel = (state: SessionSandboxState): SessionSandboxLabel | null => {
  if (state.pendingSwitch?.to === 'nono') {
    return { icon: 'lock-unlock', text: 'Moves into the sandbox after this turn' };
  }
  if (state.pendingSwitch?.to === 'off') {
    return { icon: 'lock-unlock', text: 'Leaves the sandbox after this turn' };
  }
  if (state.sandboxed) {
    return { icon: 'lock', text: 'Sandboxed' };
  }
  return null;
};

interface ErrorWithCode {
  code?: unknown;
  reason?: unknown;
}

/**
 * Whether a refusal is the server holding a session back while it finishes
 * a turn in the daemon it is leaving (`SESSION_IN_USE` with reason
 * `SESSION_SWITCHING`). Nothing ran, and the same send works once the
 * session has moved.
 */
export const isSessionSwitchingError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const { code, reason } = error as ErrorWithCode;
  return code === 'SESSION_IN_USE' && reason === 'SESSION_SWITCHING';
};

/**
 * Readable text for the two errors a sandboxed session can return on send:
 * `SANDBOX_UNAVAILABLE` (the project's sandbox cannot start) and
 * `SESSION_IN_USE` while the session has a pending switch (it is finishing a
 * turn before it moves). `SESSION_IN_USE` without a pending switch means
 * another PiChamber instance holds the session, so it is left to the caller.
 * Returns null for any other error so callers keep their own message.
 */
export const describeSandboxSendError = (
  error: unknown,
  session?: SessionSandboxState,
): string | null => {
  if (!error || typeof error !== 'object') return null;
  const { code, reason } = error as ErrorWithCode;
  if (code === 'SANDBOX_UNAVAILABLE') {
    return `This project is sandboxed, but its sandbox cannot start. ${sandboxReasonText(typeof reason === 'string' ? reason : undefined)}`;
  }
  if (code === 'SESSION_IN_USE' && (session?.pendingSwitch || reason === 'SESSION_SWITCHING')) {
    return 'This session is finishing its turn before its project\'s sandbox setting applies. Send again when the turn ends.';
  }
  return null;
};
