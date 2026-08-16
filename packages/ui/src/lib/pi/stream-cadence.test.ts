import { describe, expect, test } from 'bun:test';

import type { PiSessionEvent } from './protocol';
import { foldConsecutiveStreamDeltas, PiStreamCadence } from './stream-cadence';

const delta = (
  sequence: number,
  text: string,
  sessionId = 'sess-1',
  contentIndex = 0,
): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'assistant.message.delta',
  sequence,
  sessionId,
  directory: '/work',
  payload: { messageId: 'm1', contentIndex, delta: text },
});

const ended = (sequence: number): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'assistant.message.end',
  sequence,
  sessionId: 'sess-1',
  directory: '/work',
  payload: { messageId: 'm1', text: 'ab' },
});

describe('foldConsecutiveStreamDeltas', () => {
  test('concatenates adjacent same-part deltas and keeps the later sequence', () => {
    const folded = foldConsecutiveStreamDeltas([delta(1, 'a'), delta(2, 'b'), delta(3, 'c')]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.sequence).toBe(3);
    expect(folded[0]?.name === 'assistant.message.delta' && folded[0].payload.delta).toBe('abc');
  });

  test('folds cumulative snapshots without stuttering', () => {
    const folded = foldConsecutiveStreamDeltas([
      delta(1, 'Let'),
      delta(2, 'Let me look'),
      delta(3, 'Let me look at the tests'),
    ]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.name === 'assistant.message.delta' && folded[0].payload.delta).toBe(
      'Let me look at the tests',
    );
  });

  test('does not fold different content indexes or sessions', () => {
    const folded = foldConsecutiveStreamDeltas([
      delta(1, 'a', 'sess-1', 0),
      delta(2, 'b', 'sess-1', 1),
      delta(3, 'c', 'sess-2', 0),
    ]);
    expect(folded).toHaveLength(3);
  });
});

describe('PiStreamCadence', () => {
  test('publishes folded deltas on the scheduled frame', () => {
    const frames: Array<readonly PiSessionEvent[]> = [];
    const pending: FrameRequestCallback[] = [];
    const previousRaf = globalThis.requestAnimationFrame;
    const previousCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      pending.push(callback);
      return pending.length;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => {
      pending[id - 1] = () => undefined;
    }) as typeof cancelAnimationFrame;

    const cadence = new PiStreamCadence((events) => frames.push(events));
    cadence.push(delta(1, 'a'));
    cadence.push(delta(2, 'b'));
    expect(frames).toEqual([]);
    pending[0]?.(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.[0]?.name === 'assistant.message.delta' && frames[0][0].payload.delta).toBe('ab');

    cadence.dispose();
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancel;
  });

  test('flushes pending deltas before a boundary event and keeps order', () => {
    const frames: Array<readonly PiSessionEvent[]> = [];
    const pending: FrameRequestCallback[] = [];
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      pending.push(callback);
      return pending.length;
    }) as typeof requestAnimationFrame;

    const cadence = new PiStreamCadence((events) => frames.push(events));
    cadence.push(delta(1, 'a'));
    cadence.push(ended(2));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.map((event) => event.name)).toEqual([
      'assistant.message.delta',
      'assistant.message.end',
    ]);
    expect(frames[0]?.[0]?.name === 'assistant.message.delta' && frames[0][0].payload.delta).toBe('a');

    cadence.dispose();
    globalThis.requestAnimationFrame = previousRaf;
  });

  test('dispose flushes pending deltas instead of dropping them', () => {
    const frames: Array<readonly PiSessionEvent[]> = [];
    const previousRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      void callback;
      return 1;
    }) as typeof requestAnimationFrame;

    const cadence = new PiStreamCadence((events) => frames.push(events));
    cadence.push(delta(1, 'a'));
    cadence.dispose();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.[0]?.name === 'assistant.message.delta' && frames[0][0].payload.delta).toBe('a');

    globalThis.requestAnimationFrame = previousRaf;
  });
});
