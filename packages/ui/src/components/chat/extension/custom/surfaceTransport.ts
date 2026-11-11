import { getPiSessionStore, type ExtensionSurfaceDismissal } from '@/apps/pi-session-store';
import { toast } from '@/components/ui';
import { PiRequestError, piClient } from '@/lib/pi/client';
import type { PiExtensionSurfaceViewport } from '@/lib/pi/protocol';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getTabClientId } from '@/lib/pi/tab-client-id';

/**
 * Browser side of `ctx.ui.custom()` input. Keys go to the daemon in order:
 * one POST in flight per surface, and keys typed while it runs are batched
 * into the next one. A request carries at most 256 items and 65,536
 * characters in all, as the route and daemon require.
 */

const MAX_BATCH_ITEMS = 256;
export const MAX_SURFACE_INPUT_CHARS = 64 * 1024;

const surfaceClientId = getTabClientId;

const viewports = new Map<string, PiExtensionSurfaceViewport>();
/** Sessions whose next measurement claims the size (no measurement yet). */
const pendingClaims = new Set<string>();

const sameViewport = (a: PiExtensionSurfaceViewport | undefined, b: PiExtensionSurfaceViewport): boolean => (
  a !== undefined && a.columns === b.columns && a.screenColumns === b.screenColumns && a.rows === b.rows
);

const isNotOpen = (error: unknown): boolean => (
  error instanceof PiRequestError && error.code === 'EXTENSION_SURFACE_NOT_OPEN'
);

const scope = () => ({ runtimeKey: getRuntimeKey() });

const sendViewport = (sessionId: string, viewport: PiExtensionSurfaceViewport, claim: boolean): void => {
  void piClient
    .sendExtensionSurface('viewport', {
      sessionId,
      clientId: surfaceClientId(),
      viewport,
      ...(claim ? { claim: true } : {}),
    }, scope())
    .catch(() => {
      // No surface open any more, or the server is unreachable: the next
      // measurement after reconnect reports again.
      viewports.delete(sessionId);
    });
};

/**
 * Records this tab's measured viewport for a session and reports it when it
 * changed. Reporting alone does not claim the size; see `claimSurfaceSize`.
 */
export const reportSurfaceViewport = (sessionId: string, viewport: PiExtensionSurfaceViewport): void => {
  const claim = pendingClaims.delete(sessionId);
  if (!claim && sameViewport(viewports.get(sessionId), viewport)) return;
  viewports.set(sessionId, viewport);
  sendViewport(sessionId, viewport, claim);
};

/**
 * Makes this tab the one whose size the extension draws at, when the user
 * taps a surface or its dimmed pane. Keys and Close claim too, and the
 * daemon gives the size to the tab whose prompt opened the surface. Before
 * the first measurement the claim waits for it.
 */
export const claimSurfaceSize = (sessionId: string): void => {
  const viewport = viewports.get(sessionId);
  if (viewport) sendViewport(sessionId, viewport, true);
  else pendingClaims.add(sessionId);
};

/**
 * Forgets the last reported viewport so the next measurement is sent again,
 * and drops a claim still waiting for one: the surfaces it was made for are
 * gone, so it must not take the size for a later surface.
 */
export const resetSurfaceViewport = (sessionId: string): void => {
  viewports.delete(sessionId);
  pendingClaims.delete(sessionId);
};

interface InputQueue {
  pending: string[];
  inFlight: boolean;
}

const queues = new Map<string, InputQueue>();

const takeBatch = (pending: string[]): string[] => {
  const batch: string[] = [];
  let chars = 0;
  while (pending.length > 0 && batch.length < MAX_BATCH_ITEMS) {
    const next = pending[0]!;
    if (batch.length > 0 && chars + next.length > MAX_SURFACE_INPUT_CHARS) break;
    batch.push(pending.shift()!);
    chars += next.length;
  }
  return batch;
};

const drain = async (sessionId: string, surfaceId: string, queue: InputQueue): Promise<void> => {
  queue.inFlight = true;
  try {
    while (queue.pending.length > 0) {
      const items = takeBatch(queue.pending);
      try {
        await piClient.sendExtensionSurface('input', {
          sessionId,
          surfaceId,
          clientId: surfaceClientId(),
          ...(viewports.has(sessionId) ? { viewport: viewports.get(sessionId) } : {}),
          items,
        }, scope());
      } catch (error) {
        // Keys are not replayed later: a late Enter could confirm something
        // the user no longer sees.
        queue.pending.length = 0;
        if (isNotOpen(error)) getPiSessionStore().dropExtensionSurface(sessionId, surfaceId);
        else toast.error('Keys did not reach the extension. Try again.');
      }
    }
  } finally {
    queue.inFlight = false;
    queues.delete(`${sessionId}\u0000${surfaceId}`);
  }
};

/** Queues terminal input items (single keys or one bracketed paste each). */
export const sendSurfaceInput = (sessionId: string, surfaceId: string, items: string[]): void => {
  const accepted = items.filter((item) => item.length > 0 && item.length <= MAX_SURFACE_INPUT_CHARS);
  if (accepted.length === 0) return;
  const key = `${sessionId}\u0000${surfaceId}`;
  let queue = queues.get(key);
  if (!queue) {
    queue = { pending: [], inFlight: false };
    queues.set(key, queue);
  }
  queue.pending.push(...accepted);
  if (!queue.inFlight) void drain(sessionId, surfaceId, queue);
};

/** Surfaces this tab asked to close, so their dismissal is not news here. */
const closedHere = new Set<string>();
const MAX_CLOSED_HERE = 256;

/**
 * Whether a dismissal means another device closed a surface this tab showed:
 * the host ending it (`cancelled`, as the Esc button does to a surface that
 * cannot take keys) on a top-level surface, not pressed here. Nested panels go with their parent.
 */
export const closedElsewhere = (dismissal: ExtensionSurfaceDismissal): boolean => (
  dismissal.reason === 'cancelled'
  && !dismissal.surface.parentId
  && !closedHere.has(`${dismissal.sessionId}\u0000${dismissal.surface.surfaceId}`)
);

/**
 * The host Esc button. The daemon presses Esc once for the user, where a key
 * typed at the surface would go; the surface stays until the extension
 * closes it and its dismissal arrives. One that cannot take keys at all is
 * ended at once (`cancelled`).
 */
export const closeSurface = async (sessionId: string, surfaceId: string): Promise<void> => {
  closedHere.add(`${sessionId}\u0000${surfaceId}`);
  if (closedHere.size > MAX_CLOSED_HERE) closedHere.delete(closedHere.values().next().value as string);
  try {
    await piClient.sendExtensionSurface('close', {
      sessionId,
      surfaceId,
      clientId: surfaceClientId(),
      ...(viewports.has(sessionId) ? { viewport: viewports.get(sessionId) } : {}),
    }, scope());
  } catch (error) {
    if (isNotOpen(error)) {
      getPiSessionStore().dropExtensionSurface(sessionId, surfaceId);
      return;
    }
    toast.error('Could not close the extension surface. Try again.');
  }
};

/**
 * Picks a panel in a tab stack: the daemon focuses it as `handle.focus()`
 * would, and this tab sets the size (the user acted here).
 */
export const focusSurface = async (sessionId: string, surfaceId: string): Promise<void> => {
  try {
    await piClient.sendExtensionSurface('focus', {
      sessionId,
      surfaceId,
      clientId: surfaceClientId(),
      ...(viewports.has(sessionId) ? { viewport: viewports.get(sessionId) } : {}),
    }, scope());
  } catch (error) {
    if (isNotOpen(error)) return;
    toast.error('Could not switch to that panel. Try again.');
  }
};

const refreshing = new Set<string>();

/** Asks for full frames after a missed patch; one request per surface at a time. */
export const refreshSurface = (sessionId: string, surfaceId: string): void => {
  const key = `${sessionId}\u0000${surfaceId}`;
  if (refreshing.has(key)) return;
  refreshing.add(key);
  void piClient
    .sendExtensionSurface('refresh', { sessionId, surfaceId }, scope())
    // A refused refresh leaves the surface stale; its dismiss or the next
    // snapshot settles it.
    .catch(() => undefined)
    .finally(() => refreshing.delete(key));
};
