import type { PiPendingInputKind, PiPendingInputSummary } from '@/lib/pi/protocol';

/**
 * Shared session attention rank, used by every session list surface
 * (sidebar rows, collapsed folder/group rollups, project aggregate dots,
 * desktop and mobile switchers).
 *
 * Priority: needs input > working (busy/retry) > unread. Needs input shows
 * regardless of streaming or active state: a session that is waiting on the
 * user is actionable even while its turn indicator still spins, and listing
 * it in a sidebar/switcher is useful while the dock is collapsed or the
 * session is already open.
 */
type SessionAttention = 'needs-input' | 'working' | 'unread' | null;

interface SessionAttentionInput {
  /** Daemon pending-input summary. `null`/unknown means nothing known pending. */
  pendingInput?: PiPendingInputSummary | null | undefined;
  /** True while the session turn is running (`busy`/`retry`). */
  isStreaming: boolean;
  /** Unseen turn-complete/error count from the notification store. */
  unseenCount: number;
  /** True when any unseen item for the session is an error. */
  unseenHasError?: boolean;
  /** True when this session is the currently visible one. */
  isActive: boolean;
}

/** True when the daemon authoritatively reports open input requests. */
export const hasPendingInput = (
  pendingInput: PiPendingInputSummary | null | undefined,
): pendingInput is PiPendingInputSummary =>
  pendingInput != null && pendingInput.count > 0;

export const resolveSessionAttention = (input: SessionAttentionInput): SessionAttention => {
  if (hasPendingInput(input.pendingInput)) return 'needs-input';
  if (input.isStreaming) return 'working';
  // Unread follows the existing sidebar rule: only when the turn is settled
  // and the session is not the visible one.
  if (!input.isStreaming && !input.isActive && input.unseenCount > 0) return 'unread';
  return null;
};

/**
 * Accessible label for one session's pending input. `Needs approval` for
 * approval requests, `Needs input` otherwise; counts above one name the
 * number of open requests with explicit pluralization.
 */
export const formatNeedsInputLabel = (
  kind: PiPendingInputKind,
  count: number,
): string => {
  const base = kind === 'approval' ? 'Needs approval' : 'Needs input';
  if (count > 1) {
    return `${base} (${count} requests)`;
  }
  return base;
};

/** Accessible label for a collapsed surface hiding sessions needing input. */
export const formatSessionsNeedingInputLabel = (count: number): string => {
  if (count === 1) return 'A session needs input';
  return `${count} sessions need input`;
};
