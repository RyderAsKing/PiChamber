import { describe, expect, it } from 'vitest';

import {
  MAX_RECENT_NOTICES_PER_SESSION,
  MAX_RECENT_NOTICE_AGE_MS,
  MAX_RECENT_NOTICE_MESSAGE_CHARS,
  MAX_RECENT_NOTICE_SESSIONS,
  createRecentNoticeStore,
  normalizeRecentNotice,
} from './recent-notices.js';

describe('normalizeRecentNotice', () => {
  it('normalizes a complete notice', () => {
    expect(normalizeRecentNotice({
      id: 'n1', level: 'warning', message: 'hello', createdAt: 123,
    })).toEqual({ id: 'n1', level: 'warning', message: 'hello', createdAt: 123 });
  });

  it('rejects empty or missing messages', () => {
    expect(normalizeRecentNotice({ id: 'n1', level: 'info', message: '', createdAt: 1 })).toBeUndefined();
    expect(normalizeRecentNotice({ id: 'n1', level: 'info', createdAt: 1 })).toBeUndefined();
    expect(normalizeRecentNotice({ id: 'n1', level: 'info', message: 42, createdAt: 1 })).toBeUndefined();
    expect(normalizeRecentNotice(undefined)).toBeUndefined();
    expect(normalizeRecentNotice('hello')).toBeUndefined();
  });

  it('defaults unknown levels to info and fills id/createdAt', () => {
    const entry = normalizeRecentNotice({ level: 'urgent', message: 'hi', createdAt: 5 }, () => 9);
    expect(entry?.level).toBe('info');
    expect(typeof entry?.id).toBe('string');
    expect(entry?.id.length).toBeGreaterThan(0);
    const withoutCreated = normalizeRecentNotice({ message: 'hi' }, () => 9);
    expect(withoutCreated?.createdAt).toBe(9);
  });

  it('caps the message at 2000 characters', () => {
    expect(MAX_RECENT_NOTICE_MESSAGE_CHARS).toBe(2000);
    const entry = normalizeRecentNotice({ message: 'x'.repeat(2500), createdAt: 1 });
    expect(entry?.message).toHaveLength(2000);
  });
});

describe('createRecentNoticeStore', () => {
  const setup = (options = {}) => {
    let clock = options.nowStart ?? 1000;
    const store = createRecentNoticeStore({
      now: () => clock,
      ...options.store,
    });
    return { store, advance: (ms) => { clock += ms; }, clock: () => clock };
  };

  it('records and lists notices oldest first', () => {
    const { store } = setup();
    store.record('s1', { id: 'a', level: 'info', message: 'first', createdAt: 10 });
    store.record('s1', { id: 'b', level: 'error', message: 'second', createdAt: 20 });
    expect(store.listFor('s1')).toEqual([
      { id: 'a', level: 'info', message: 'first', createdAt: 10 },
      { id: 'b', level: 'error', message: 'second', createdAt: 20 },
    ]);
    expect(store.listFor('unknown')).toEqual([]);
    expect(store.listFor('')).toEqual([]);
  });

  it('caps notices per session, dropping the oldest', () => {
    const { store } = setup({ store: { maxPerSession: 3 } });
    for (let index = 0; index < 5; index += 1) {
      store.record('s1', { id: `n${index}`, message: `m${index}`, createdAt: 10 + index });
    }
    expect(store.listFor('s1').map((entry) => entry.id)).toEqual(['n2', 'n3', 'n4']);
    expect(MAX_RECENT_NOTICES_PER_SESSION).toBe(20);
  });

  it('prunes entries older than maxAgeMs at read time', () => {
    const { store, advance } = setup({ nowStart: 1_000, store: { maxAgeMs: 500 } });
    store.record('s1', { id: 'old', message: 'old', createdAt: 900 });
    store.record('s1', { id: 'new', message: 'new', createdAt: 1200 });
    advance(200);
    // now = 1200: 'old' (age 300) is still fresh.
    expect(store.listFor('s1').map((entry) => entry.id)).toEqual(['old', 'new']);
    advance(400);
    // now = 1600: 'old' (age 700) is stale and pruned.
    expect(store.listFor('s1').map((entry) => entry.id)).toEqual(['new']);
    expect(MAX_RECENT_NOTICE_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('evicts the least-recently-recorded session first', () => {
    const { store, advance } = setup({ store: { maxSessions: 2 } });
    store.record('s1', { message: 'one', createdAt: 1 });
    advance(10);
    store.record('s2', { message: 'two', createdAt: 2 });
    advance(10);
    store.record('s3', { message: 'three', createdAt: 3 });
    expect(store.listFor('s1')).toEqual([]);
    expect(store.listFor('s2')).toHaveLength(1);
    expect(store.listFor('s3')).toHaveLength(1);
    expect(MAX_RECENT_NOTICE_SESSIONS).toBe(128);
  });

  it('refreshing a session protects it from eviction', () => {
    const { store, advance } = setup({ store: { maxSessions: 2 } });
    store.record('s1', { message: 'one', createdAt: 1 });
    advance(10);
    store.record('s2', { message: 'two', createdAt: 2 });
    advance(10);
    store.record('s1', { message: 'one again', createdAt: 3 });
    advance(10);
    store.record('s3', { message: 'three', createdAt: 4 });
    expect(store.listFor('s2')).toEqual([]);
    expect(store.listFor('s1')).toHaveLength(2);
    expect(store.listFor('s3')).toHaveLength(1);
  });

  it('caps messages at 2000 characters and ignores empty messages', () => {
    const { store } = setup();
    expect(store.record('s1', { message: '' })).toBeUndefined();
    expect(store.record('s1', { message: 'x'.repeat(2500), createdAt: 1 })?.message).toHaveLength(2000);
    expect(store.record('s1', undefined)).toBeUndefined();
    expect(store.record('', { message: 'hi' })).toBeUndefined();
    expect(store.listFor('s1')).toHaveLength(1);
  });

  it('forgets one session and clears all', () => {
    const { store } = setup();
    store.record('s1', { message: 'one', createdAt: 1 });
    store.record('s2', { message: 'two', createdAt: 2 });
    store.forgetSession('s1');
    expect(store.listFor('s1')).toEqual([]);
    expect(store.listFor('s2')).toHaveLength(1);
    store.forgetSession('');
    store.clear();
    expect(store.listFor('s2')).toEqual([]);
  });
});
