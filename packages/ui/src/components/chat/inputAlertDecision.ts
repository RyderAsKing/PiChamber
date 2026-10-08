/**
 * Pure routing for newly opened pending-input requests.
 *
 * The dock strip already shows the state when the session is current and
 * the app is visible+focused, so that case stays quiet; a hidden/unfocused
 * app (or `always` mode for a background session) additionally raises an
 * OS notification, with the toast kept so it is waiting on return.
 */

type InputAlertDecision = 'none' | 'toast' | 'toast-and-notify';

/** Replay bursts after reconnect must not alert for ancient requests. */
export const PENDING_INPUT_MAX_ALERT_AGE_MS = 10 * 60 * 1000;

/** Shared toast id namespace for pending-input alerts (`pending-input:<sessionId>`). */
export const PENDING_INPUT_TOAST_ID_PREFIX = 'pending-input:';

export interface InputAlertContext {
  /** Whether the needing session is the currently visible one. */
  isCurrent: boolean;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** `document.hasFocus()`. */
  focused: boolean;
  /** The user's notification mode setting. */
  mode: 'always' | 'hidden-only';
  /** `Date.now() - pending.since` in ms. */
  ageMs: number;
}

export const decideInputAlert = (context: InputAlertContext): InputAlertDecision => {
  if (!Number.isFinite(context.ageMs) || context.ageMs < 0) return 'none';
  if (context.ageMs > PENDING_INPUT_MAX_ALERT_AGE_MS) return 'none';
  if (context.isCurrent && context.visible && context.focused) return 'none';
  if (!context.visible || !context.focused || (context.mode === 'always' && !context.isCurrent)) {
    return 'toast-and-notify';
  }
  return 'toast';
};
