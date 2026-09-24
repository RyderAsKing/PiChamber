import { getPiSessionStore } from '@/apps/pi-session-store';
import { normalizePath } from '@/lib/pathNormalization';
import type { PiSessionId } from '@/lib/pi/types';
import { isNewSessionDraftActive } from '@/lib/router/session-intent';
import { useSessionUIStore } from '@/sync/session-ui-store';

type ScopedSession = { sessionId: PiSessionId | null; directory: string | null };

const sameDirectory = (a: string | null | undefined, b: string | null | undefined): boolean => (
  Boolean(a && b) && normalizePath(a ?? null) === normalizePath(b ?? null)
);

/**
 * Preferred session for an automatic folder focus (connect/reconnect or a
 * directory-store change). A null preference lets the list pick its first
 * row, so pass only a selection that already belongs to `directory`:
 * the visible chat identity, then the caller's scoped fallback, then the
 * store's remembered pick. An active draft keeps its blank-chat intent.
 *
 * A focus on the store's current folder is a no-op with a null preference;
 * keep it that way so a lagging UI identity cannot re-select an older session.
 */
export function focusPreferenceForDirectory(
  directory: string | null,
  fallback?: ScopedSession | null,
): PiSessionId | null {
  if (!directory) return null;
  const store = getPiSessionStore();
  if (sameDirectory(store.getState().directory, directory)) return null;
  const ui = useSessionUIStore.getState();
  if (isNewSessionDraftActive(ui.newSessionDraft, ui.currentSessionId)) return null;
  if (ui.currentSessionId && sameDirectory(ui.currentSessionDirectory, directory)) return ui.currentSessionId;
  if (fallback?.sessionId && sameDirectory(fallback.directory, directory)) return fallback.sessionId;
  return store.lastSelectedSessionForDirectory(directory);
}
