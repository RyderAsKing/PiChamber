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
  UNSUPPORTED_PLATFORM: 'PiChamber supports nono sandboxing on Linux servers only for now.',
  SANDBOX_NOT_PROBED: 'Sandboxing has not been checked yet.',
  PROVIDER_HOSTS_UNAVAILABLE: 'PiChamber could not read which model providers the sandbox should reach.',
  INVALID_SANDBOX_SETTING: 'This project\'s sandbox setting could not be read. Save it again.',
  SANDBOX_GRANT_REFUSED: 'This project cannot be sandboxed: its folder or one of its extra folders overlaps PiChamber\'s own data or Pi\'s settings folder.',
  SANDBOX_PROFILE_UNREADABLE: 'nono could not read PiChamber\'s sandbox profile.',
  SANDBOX_LAUNCH_FAILED: 'The sandbox failed to start.',
};

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
  if (code === 'SESSION_IN_USE' && session?.pendingSwitch) {
    return 'This session is finishing its turn before its project\'s sandbox setting applies. Send again when the turn ends.';
  }
  return null;
};
