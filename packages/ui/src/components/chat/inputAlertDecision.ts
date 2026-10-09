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
  /** Skew-corrected request age in ms (`Date.now()` minus the
   *  `toClientTimestamp`-resolved `pending.since`). Without a server clock
   *  sample this is the raw client/server difference, so small negative
   *  values are clamped to fresh instead of suppressing the alert. */
  ageMs: number;
}

export const decideInputAlert = (context: InputAlertContext): InputAlertDecision => {
  if (!Number.isFinite(context.ageMs)) return 'none';
  // `since` is a server timestamp, so a client clock behind the server (and
   // any path without a `serverNow` sample) can produce a slightly negative
   // age for a genuinely fresh request. Clamp to fresh instead of staying
   // quiet; the staleness guard above still suppresses true replay bursts.
  const ageMs = Math.max(0, context.ageMs);
  if (ageMs > PENDING_INPUT_MAX_ALERT_AGE_MS) return 'none';
  if (context.isCurrent && context.visible && context.focused) return 'none';
  if (!context.visible || !context.focused || (context.mode === 'always' && !context.isCurrent)) {
    return 'toast-and-notify';
  }
  return 'toast';
};
