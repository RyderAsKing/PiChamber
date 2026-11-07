import { describe, expect, test } from 'bun:test';

import { applyPiEvent, createReducerState, dropExtensionSurface, type PiReducerState } from './event-reducer';
import type { PiExtensionSurfaceMeta, PiSessionEvent } from './protocol';

const event = <T extends PiSessionEvent['name']>(
  name: T,
  sequence: number,
  payload: Extract<PiSessionEvent, { name: T }>['payload'],
): Extract<PiSessionEvent, { name: T }> => ({
  protocolVersion: 1,
  kind: 'event',
  name,
  sequence,
  sessionId: 'sess-1',
  directory: '/work',
  payload,
} as Extract<PiSessionEvent, { name: T }>);

const meta = (overrides: Partial<PiExtensionSurfaceMeta> = {}): PiExtensionSurfaceMeta => ({
  surfaceId: 'custom-1',
  title: '/pick',
  mode: 'inline',
  capturing: true,
  hidden: false,
  focused: true,
  z: 1,
  ...overrides,
});

const frameCommon = { cursor: null, layout: null, visible: true, columns: 80, screenColumns: 120, rows: 30 };

const surface = (state: PiReducerState, surfaceId = 'custom-1') => (
  state.bySession.get('sess-1')?.extensionSurfaces?.get(surfaceId)
);

const opened = (): PiReducerState => {
  let state = applyPiEvent(createReducerState(), event('extension.custom', 1, meta())).state;
  state = applyPiEvent(state, event('extension.custom.frame', 2, {
    surfaceId: 'custom-1', version: 1, length: 3, lines: ['a', 'b', 'c'], cells: { 1: { 0: 2 } }, ...frameCommon,
  })).state;
  return state;
};

describe('custom() surfaces', () => {
  test('applies metadata, a full frame and a matching patch', () => {
    let state = opened();
    expect(surface(state)?.frame?.lines).toEqual(['a', 'b', 'c']);
    expect(surface(state)?.frame?.cells).toEqual([undefined, { 0: 2 }, undefined]);

    state = applyPiEvent(state, event('extension.custom.frame', 3, {
      surfaceId: 'custom-1', version: 2, base: 1, length: 4, changes: [{ index: 1, line: 'B' }, { index: 3, line: 'd' }], ...frameCommon,
    })).state;
    expect(surface(state)?.frame?.lines).toEqual(['a', 'B', 'c', 'd']);
    expect(surface(state)?.frame?.cells).toEqual([undefined, undefined, undefined, undefined]);
    expect(surface(state)?.frame?.version).toBe(2);

    // A metadata update keeps the frame.
    state = applyPiEvent(state, event('extension.custom', 4, meta({ focused: false }))).state;
    expect(surface(state)?.focused).toBe(false);
    expect(surface(state)?.frame?.lines).toEqual(['a', 'B', 'c', 'd']);
  });

  test('marks the surface stale when a patch does not match the held frame', () => {
    let state = opened();
    state = applyPiEvent(state, event('extension.custom.frame', 3, {
      surfaceId: 'custom-1', version: 3, base: 2, length: 3, changes: [{ index: 0, line: 'x' }], ...frameCommon,
    })).state;
    expect(surface(state)?.stale).toBe(true);
    expect(surface(state)?.frame?.lines).toEqual(['a', 'b', 'c']);

    state = applyPiEvent(state, event('extension.custom.frame', 4, {
      surfaceId: 'custom-1', version: 4, length: 1, lines: ['fresh'], ...frameCommon,
    })).state;
    expect(surface(state)?.stale).toBe(false);
    expect(surface(state)?.frame?.lines).toEqual(['fresh']);
  });

  test('ignores old frames and frames for unknown surfaces', () => {
    let state = opened();
    state = applyPiEvent(state, event('extension.custom.frame', 3, {
      surfaceId: 'custom-1', version: 1, length: 1, lines: ['old'], ...frameCommon,
    })).state;
    expect(surface(state)?.frame?.lines).toEqual(['a', 'b', 'c']);
    state = applyPiEvent(state, event('extension.custom.frame', 4, {
      surfaceId: 'custom-9', version: 1, length: 1, lines: ['?'], ...frameCommon,
    })).state;
    expect(surface(state, 'custom-9')).toBeUndefined();
  });

  test('dismiss removes the surface and the map when it was the last', () => {
    let state = opened();
    state = applyPiEvent(state, event('extension.custom.dismiss', 3, { surfaceId: 'custom-1', reason: 'done' })).state;
    expect(state.bySession.get('sess-1')?.extensionSurfaces).toBeUndefined();
  });

  test('a snapshot replaces the surfaces, and one without them clears them', () => {
    let state = opened();
    state = applyPiEvent(state, event('session.snapshot', 10, {
      snapshot: {
        sessionId: 'sess-1',
        directory: '/work',
        isStreaming: false,
        lifecycle: 'idle',
        queue: { steering: 0, followUp: 0 },
        lastSequence: 10,
        extensionSurfaces: [{
          ...meta({ surfaceId: 'custom-2', mode: 'overlay' }),
          frame: { surfaceId: 'custom-2', version: 5, length: 1, lines: ['o'], ...frameCommon },
        }],
      },
    } as never)).state;
    expect(surface(state)).toBeUndefined();
    expect(surface(state, 'custom-2')?.frame?.lines).toEqual(['o']);

    state = applyPiEvent(state, event('session.snapshot', 11, {
      snapshot: {
        sessionId: 'sess-1',
        directory: '/work',
        isStreaming: false,
        lifecycle: 'idle',
        queue: { steering: 0, followUp: 0 },
        lastSequence: 11,
      },
    } as never)).state;
    expect(state.bySession.get('sess-1')?.extensionSurfaces).toBeUndefined();
  });

  test('dropExtensionSurface removes a surface and is a no-op otherwise', () => {
    const state = opened();
    expect(dropExtensionSurface(state, 'sess-1', 'custom-9')).toBe(state);
    const next = dropExtensionSurface(state, 'sess-1', 'custom-1');
    expect(next.bySession.get('sess-1')?.extensionSurfaces).toBeUndefined();
    expect(surface(state)).toBeDefined();
  });
});
