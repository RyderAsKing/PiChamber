import { afterEach, describe, expect, test } from 'bun:test';

import { piClient } from '@/lib/pi/client';
import { getTabClientId } from '@/lib/pi/tab-client-id';
import type { PiExtensionSurfaceState } from '@/lib/pi/reducers/customSurfaceReducers';
import { claimSurfaceSize, closeSurface, closedElsewhere, reportSurfaceViewport, resetSurfaceViewport } from './surfaceTransport';

type Sent = { action: string; payload: Record<string, unknown> };

const original = piClient.sendExtensionSurface.bind(piClient);
const capture = (): Sent[] => {
  const sent: Sent[] = [];
  piClient.sendExtensionSurface = (async (action: string, payload: Record<string, unknown>) => {
    sent.push({ action, payload });
  }) as typeof piClient.sendExtensionSurface;
  return sent;
};

afterEach(() => {
  piClient.sendExtensionSurface = original;
});

const viewport = { columns: 44, screenColumns: 46, rows: 30 };

describe('surface size claims', () => {
  test('a claim made before the first measurement goes with it', () => {
    const sent = capture();
    claimSurfaceSize('s-1');
    expect(sent).toEqual([]);
    reportSurfaceViewport('s-1', viewport);
    expect(sent).toEqual([{ action: 'viewport', payload: { sessionId: 's-1', clientId: getTabClientId(), viewport, claim: true } }]);
    resetSurfaceViewport('s-1');
  });

  test('a waiting claim is dropped when the surfaces it was for close', () => {
    const sent = capture();
    claimSurfaceSize('s-2');
    // The pane unmounted (surfaces closed) before it measured.
    resetSurfaceViewport('s-2');
    reportSurfaceViewport('s-2', viewport);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.claim).toBeUndefined();
    resetSurfaceViewport('s-2');
  });

  test('a claim after measuring is sent at once with the measured size', () => {
    const sent = capture();
    reportSurfaceViewport('s-3', viewport);
    claimSurfaceSize('s-3');
    expect(sent.map((entry) => entry.payload.claim)).toEqual([undefined, true]);
    expect(sent[1]!.payload.viewport).toEqual(viewport);
    resetSurfaceViewport('s-3');
  });
});

describe('closed on another device', () => {
  const surface = (surfaceId: string, extra: Partial<PiExtensionSurfaceState> = {}) => ({
    surfaceId, title: '/pick', mode: 'overlay', capturing: true, hidden: false, focused: true, z: 1, frame: null, ...extra,
  }) as PiExtensionSurfaceState;

  test('a Close pressed elsewhere is news; one pressed here, done() and nested panels are not', async () => {
    capture();
    expect(closedElsewhere({ sessionId: 's-1', reason: 'cancelled', surface: surface('a') })).toBe(true);
    await closeSurface('s-1', 'b');
    expect(closedElsewhere({ sessionId: 's-1', reason: 'cancelled', surface: surface('b') })).toBe(false);
    // The same surface id in another session is still someone else's Close.
    expect(closedElsewhere({ sessionId: 's-2', reason: 'cancelled', surface: surface('b') })).toBe(true);
    expect(closedElsewhere({ sessionId: 's-1', reason: 'done', surface: surface('c') })).toBe(false);
    expect(closedElsewhere({ sessionId: 's-1', reason: 'session-closed', surface: surface('c') })).toBe(false);
    expect(closedElsewhere({ sessionId: 's-1', reason: 'cancelled', surface: surface('d', { parentId: 'a' }) })).toBe(false);
  });
});
