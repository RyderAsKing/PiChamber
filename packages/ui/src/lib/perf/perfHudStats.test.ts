import { describe, expect, test } from 'bun:test';

import {
  createFrameStats,
  heapBytesToMb,
  percentile,
  selectTopCounters,
} from './perfHudStats';
import { buildPerfHudSnapshot } from './perfHudRuntime';

describe('perfHudStats', () => {
  test('percentile uses the ceiling rank', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 20], 95)).toBe(20);
    expect(percentile([8, 8, 8, 8, 50], 95)).toBe(50);
  });

  test('frame stats report fps and p95 over the sample window', () => {
    const frames = createFrameStats(1_000);
    frames.sample(0);
    frames.sample(16);
    frames.sample(32);
    frames.sample(48);
    const snapshot = frames.snapshot();
    expect(snapshot.samples).toBe(3);
    expect(snapshot.lastMs).toBe(16);
    expect(snapshot.p95Ms).toBe(16);
    expect(snapshot.fps).toBeGreaterThan(60);
    expect(snapshot.fps).toBeLessThan(70);
  });

  test('selectTopCounters drops zeros and keeps the largest values', () => {
    expect(selectTopCounters([
      { metric: 'ui.message_list.render', value: 12 },
      { metric: 'ui.header.render', value: 0 },
      { metric: 'ui.markdown_renderer.render', value: 40 },
      { metric: 'ui.chat_message.render', value: 9 },
    ], 2)).toEqual([
      { metric: 'ui.markdown_renderer.render', value: 40 },
      { metric: 'ui.message_list.render', value: 12 },
    ]);
  });

  test('heapBytesToMb rejects invalid values', () => {
    expect(heapBytesToMb(undefined)).toBe(null);
    expect(heapBytesToMb(-1)).toBe(null);
    expect(heapBytesToMb(8 * 1024 * 1024)).toBe(8);
  });
});

describe('buildPerfHudSnapshot', () => {
  test('copies only aggregate counters and omits session identifiers', () => {
    const snapshot = buildPerfHudSnapshot({
      fps: 60,
      frameMs: { last: 16, p95: 18 },
      longTasks: { count: 2, lastMs: 80, totalMs: 120 },
      heapUsedMb: 32,
    }, {
      getStreamSnapshot: () => ({
        enabled: true,
        startedAt: 1,
        lastUpdatedAt: 2,
        durationMs: 10,
        entries: [
          { metric: 'ui.message_list.render', count: 4, avg: 1, max: 1, total: 4, last: 1 },
        ],
      }),
      getSyncSnapshot: () => ({
        pipelineRawEvents: 9,
        pipelineCoalescedEvents: 0,
      } as never),
      getSessionLoadEventCount: () => 3,
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('ses_');
    expect(serialized).not.toContain('sessionId');
    expect(snapshot.stream).toEqual([{ metric: 'ui.message_list.render', value: 4 }]);
    expect(snapshot.sync[0]).toEqual({ metric: 'sync.pipelineRawEvents', value: 9 });
    expect(snapshot.sessionLoadEvents).toBe(3);
  });
});
