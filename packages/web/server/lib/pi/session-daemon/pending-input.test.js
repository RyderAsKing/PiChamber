import { describe, expect, it } from 'vitest';

import {
  MAX_PENDING_INPUT_COUNT,
  PENDING_INPUT_KINDS,
  createPendingInputIndex,
  normalizePendingInputSummary,
} from './pending-input.js';

describe('normalizePendingInputSummary', () => {
  it('passes null through as authoritatively nothing pending', () => {
    expect(normalizePendingInputSummary(null)).toBeNull();
  });

  it('returns undefined for malformed values', () => {
    expect(normalizePendingInputSummary(undefined)).toBeUndefined();
    expect(normalizePendingInputSummary('pending')).toBeUndefined();
    expect(normalizePendingInputSummary(42)).toBeUndefined();
    expect(normalizePendingInputSummary([])).toBeUndefined();
    expect(normalizePendingInputSummary({})).toBeUndefined();
    expect(normalizePendingInputSummary({ count: '1', kind: 'input', since: 5 })).toBeUndefined();
    expect(normalizePendingInputSummary({ count: 1.5, kind: 'input', since: 5 })).toBeUndefined();
    expect(normalizePendingInputSummary({ count: -1, kind: 'input', since: 5 })).toBeUndefined();
    expect(normalizePendingInputSummary({ count: 1, kind: 'input' })).toBeUndefined();
    expect(normalizePendingInputSummary({ count: 1, kind: 'input', since: 0 })).toBeUndefined();
    expect(normalizePendingInputSummary({ count: 1, kind: 'input', since: Number.NaN })).toBeUndefined();
    expect(normalizePendingInputSummary(null, undefined)).toBeNull();
  });

  it('normalizes a zero count to null', () => {
    expect(normalizePendingInputSummary({ count: 0, kind: 'input', since: 5 })).toBeNull();
  });

  it('clamps the count and copies only the three wire keys', () => {
    expect(normalizePendingInputSummary({
      count: 500, kind: 'approval', since: 7, sessionId: 's1', extra: true,
    })).toEqual({ count: MAX_PENDING_INPUT_COUNT, kind: 'approval', since: 7 });
    expect(MAX_PENDING_INPUT_COUNT).toBe(99);
    expect(PENDING_INPUT_KINDS).toEqual(['input', 'approval']);
  });

  it('normalizes unknown or missing kinds to input', () => {
    expect(normalizePendingInputSummary({ count: 2, kind: 'question', since: 9 })).toEqual({
      count: 2, kind: 'input', since: 9,
    });
    expect(normalizePendingInputSummary({ count: 2, since: 9 })).toEqual({
      count: 2, kind: 'input', since: 9,
    });
    expect(normalizePendingInputSummary({ count: 2, kind: 42, since: 9 })).toEqual({
      count: 2, kind: 'input', since: 9,
    });
  });

  it('returns a fresh object', () => {
    const value = { count: 1, kind: 'input', since: 3 };
    const normalized = normalizePendingInputSummary(value);
    expect(normalized).toEqual(value);
    expect(normalized).not.toBe(value);
  });
});

describe('createPendingInputIndex', () => {
  const setup = ({ nowStart = 1000 } = {}) => {
    const events = [];
    let now = nowStart;
    const settled = [];
    const index = createPendingInputIndex({
      publish: (event, payload, sessionId, directory) => events.push({ event, payload, sessionId, directory }),
      now: () => {
        now += 100;
        return now;
      },
      onHostedSessionSettled: (sessionId) => settled.push(sessionId),
    });
    return { events, settled, index };
  };

  it('derives the summary from the oldest hosted request', () => {
    const { events, index } = setup();
    index.open({ sessionId: 's1', directory: '/d', requestId: 'r1' });
    index.open({ sessionId: 's1', directory: '/d', requestId: 'r2', kind: 'approval' });
    expect(index.summaryFor('s1')).toEqual({ count: 2, kind: 'input', since: 1100 });
    expect(events.map((entry) => entry.event)).toEqual(['session.input', 'session.input']);
    expect(events[0].payload.pending).toEqual({ count: 1, kind: 'input', since: 1100 });
    expect(events[1].payload.pending).toEqual({ count: 2, kind: 'input', since: 1100 });
    expect(events[1].directory).toBe('/d');
  });

  it('ignores invalid ids and re-opening an existing request', () => {
    const { events, index } = setup();
    index.open({ sessionId: '', directory: '/d', requestId: 'r1' });
    index.open({ sessionId: 's1', directory: '/d', requestId: '' });
    index.open({ sessionId: 's1', directory: '', requestId: 'r1' });
    expect(index.summaryFor('s1')).toBeNull();
    index.open({ sessionId: 's1', directory: '/d', requestId: 'r1' });
    const before = events.length;
    index.open({ sessionId: 's1', directory: '/d', requestId: 'r1' });
    expect(events).toHaveLength(before);
    expect(index.summaryFor('s1')).toEqual({ count: 1, kind: 'input', since: 1100 });
  });

  it('closes requests and calls onHostedSessionSettled once when the last one closes', () => {
    const { events, settled, index } = setup();
    index.open({ sessionId: 's1', directory: '/d', requestId: 'r1' });
    index.open({ sessionId: 's1', directory: '/d', requestId: 'r2' });
    events.length = 0;
    index.close('s1', 'r1');
    expect(index.summaryFor('s1')).toEqual({ count: 1, kind: 'input', since: 1300 });
    expect(settled).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].payload.pending).toEqual({ count: 1, kind: 'input', since: 1300 });
    index.close('s1', 'r1');
    expect(events).toHaveLength(1);
    index.close('s1', 'r2');
    expect(index.summaryFor('s1')).toBeNull();
    expect(events).toHaveLength(2);
    expect(events[1].payload.pending).toEqual(null);
    expect(settled).toEqual(['s1']);
  });

  it('stores and clears engine summaries', () => {
    const { events, settled, index } = setup();
    expect(index.summaryFor('s9')).toBeNull();
    index.applyEngineSummary('s9', '/eng', { count: 3, kind: 'approval', since: 50 });
    expect(index.summaryFor('s9')).toEqual({ count: 3, kind: 'approval', since: 50 });
    expect(events).toHaveLength(1);
    index.applyEngineSummary('s9', '/eng', { count: 3, kind: 'approval', since: 50 });
    expect(events).toHaveLength(1);
    index.applyEngineSummary('s9', '/eng', null);
    expect(index.summaryFor('s9')).toBeNull();
    expect(events).toHaveLength(2);
    expect(events[1].payload.pending).toEqual(null);
    expect(settled).toEqual([]);
  });

  it('prefers hosted requests over engine summaries', () => {
    const { index } = setup();
    index.applyEngineSummary('s1', '/d', { count: 4, kind: 'approval', since: 10 });
    index.open({ sessionId: 's1', directory: '/d', requestId: 'r1' });
    expect(index.summaryFor('s1')).toEqual({ count: 1, kind: 'input', since: 1200 });
    index.close('s1', 'r1');
    expect(index.summaryFor('s1')).toEqual({ count: 4, kind: 'approval', since: 10 });
  });

  it('lists pending sessions sorted by oldest since', () => {
    const { index } = setup();
    index.open({ sessionId: 's2', directory: '/b', requestId: 'r1' });
    index.open({ sessionId: 's1', directory: '/a', requestId: 'r1' });
    index.applyEngineSummary('s3', '/c', { count: 1, kind: 'input', since: 50 });
    const list = index.list();
    expect(list.map((entry) => entry.sessionId)).toEqual(['s3', 's2', 's1']);
    expect(list[0]).toEqual({ sessionId: 's3', directory: '/c', pending: { count: 1, kind: 'input', since: 50 } });
  });

  it('forgets sessions silently and clears with null publication', () => {
    const { events, index } = setup();
    index.open({ sessionId: 's1', directory: '/d', requestId: 'r1' });
    index.applyEngineSummary('s2', '/e', { count: 1, kind: 'input', since: 5 });
    events.length = 0;
    index.forgetSession('s1');
    expect(index.summaryFor('s1')).toBeNull();
    expect(events).toHaveLength(0);
    index.clear();
    expect(index.summaryFor('s2')).toBeNull();
    expect(index.list()).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('session.input');
    expect(events[0].payload.pending).toBeNull();
    expect(events[0].sessionId).toBe('s2');
    expect(events[0].directory).toBe('/e');
  });

  it('publishes serverNow from the injected clock', () => {
    const events = [];
    let now = 5000;
    const index = createPendingInputIndex({
      publish: (event, payload, sessionId, directory) => events.push({ event, payload, sessionId, directory }),
      now: () => now,
    });
    index.open({ sessionId: 's1', directory: '/d', requestId: 'r1' });
    expect(events[0].payload.serverNow).toBe(5000);
    now = 6000;
    index.close('s1', 'r1');
    expect(events.at(-1).payload).toEqual({ pending: null, serverNow: 6000 });
  });

  it('reports hosted requests and tolerates a throwing settle callback', () => {
    const events = [];
    const index = createPendingInputIndex({
      publish: (event, payload, sessionId, directory) => events.push({ event, payload, sessionId, directory }),
      onHostedSessionSettled: () => {
        throw new Error('settle listener failed');
      },
    });
    expect(index.hasHostedRequests('s1')).toBe(false);
    index.open({ sessionId: 's1', directory: '/d', requestId: 'r1' });
    expect(index.hasHostedRequests('s1')).toBe(true);
    expect(() => index.close('s1', 'r1')).not.toThrow();
    expect(index.hasHostedRequests('s1')).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: 'session.input', payload: { pending: null } });
  });
});
