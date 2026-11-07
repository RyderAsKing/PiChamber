import { afterEach, describe, expect, test } from 'bun:test';

import { PiSessionStore, type ExtensionSurfaceDismissal } from '@/apps/pi-session-store';
import type { PiSessionEvent } from '@/lib/pi/protocol';

interface StoreInternal {
  commitEvents: (events: readonly PiSessionEvent[]) => void;
}

const event = (name: PiSessionEvent['name'], sequence: number, payload: unknown): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name,
  sequence,
  sessionId: 's1',
  directory: '/repo',
  payload,
} as unknown as PiSessionEvent);

const meta = { surfaceId: 'custom-1', title: '/pick', mode: 'overlay', capturing: true, hidden: false, focused: true, z: 1 };

describe('extension surface dismissals', () => {
  let stores: PiSessionStore[] = [];
  afterEach(() => {
    for (const store of stores) store.dispose();
    stores = [];
  });

  const freshStore = () => {
    const store = new PiSessionStore();
    stores.push(store);
    const seen: ExtensionSurfaceDismissal[] = [];
    store.subscribeExtensionSurfaceDismissals((dismissal) => seen.push(dismissal));
    return { internal: store as unknown as StoreInternal, seen };
  };

  test('reports a held surface as it was before the dismiss, with the reason', () => {
    const { internal, seen } = freshStore();
    internal.commitEvents([event('extension.custom', 1, meta)]);
    internal.commitEvents([event('extension.custom.dismiss', 2, { surfaceId: 'custom-1', reason: 'cancelled' })]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: 's1', reason: 'cancelled', surface: { surfaceId: 'custom-1', title: '/pick' } });
  });

  test('ignores dismissals for surfaces this tab never held and replays it already applied', () => {
    const { internal, seen } = freshStore();
    internal.commitEvents([event('extension.custom.dismiss', 1, { surfaceId: 'custom-9', reason: 'cancelled' })]);
    internal.commitEvents([event('extension.custom', 2, meta), event('extension.custom.dismiss', 3, { surfaceId: 'custom-1', reason: 'done' })]);
    internal.commitEvents([event('extension.custom.dismiss', 3, { surfaceId: 'custom-1', reason: 'done' })]);
    expect(seen.map((dismissal) => dismissal.reason)).toEqual(['done']);
  });
});
