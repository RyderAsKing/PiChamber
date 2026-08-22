import { describe, expect, test } from 'vitest';
import {
  ALIAS_SCOPE_IDLE_TTL_MS,
  MAX_SCOPES,
  createMessageEntryAliases,
} from './message-entry-aliases.js';

const createSessionManager = (entryId, message) => ({
  getEntries: () => [{ type: 'message', id: entryId, message }],
  getEntry: (id) => (id === entryId ? { id: entryId } : undefined),
});

describe('message entry aliases', () => {
  test('retain + observeMessageEnd resolves the persisted Pi entry id', () => {
    const aliases = createMessageEntryAliases({ scheduleMicrotask: (fn) => fn() });
    const message = { role: 'assistant', content: 'hello' };
    const sessionManager = createSessionManager('entry-1', message);

    aliases.retain({ cwd: '/repo', sessionId: 's1', syntheticMessageId: 'asst-s1-7', message });
    // Before Pi persists the message there is no entry to find: the synthetic
    // id resolves to itself.
    const emptyManager = { getEntries: () => [], getEntry: () => undefined };
    expect(aliases.resolve({ cwd: '/repo', sessionId: 's1', requestedId: 'asst-s1-7', sessionManager: emptyManager })).toBe('asst-s1-7');
    expect(aliases.resolve({ cwd: '/repo', sessionId: 's1', requestedId: 'asst-s1-7' })).toBe('asst-s1-7');

    aliases.observeMessageEnd({
      cwd: '/repo',
      sessionId: 's1',
      syntheticMessageId: 'asst-s1-7',
      message,
      sessionManager,
    });

    expect(aliases.resolve({ cwd: '/repo', sessionId: 's1', requestedId: 'asst-s1-7', sessionManager })).toBe('entry-1');
    // Part-suffixed requests resolve through the same alias.
    expect(aliases.resolve({ cwd: '/repo', sessionId: 's1', requestedId: 'asst-s1-7:2', sessionManager })).toBe('entry-1');
  });

  test('clearSession drops only that scope', () => {
    const aliases = createMessageEntryAliases();
    const messageA = { role: 'user' };
    const messageB = { role: 'user' };
    aliases.retain({ cwd: '/a', sessionId: 's1', syntheticMessageId: 'u-a', message: messageA });
    aliases.retain({ cwd: '/b', sessionId: 's2', syntheticMessageId: 'u-b', message: messageB });

    aliases.clearSession({ cwd: '/a', sessionId: 's1' });

    expect(aliases.resolve({ cwd: '/a', sessionId: 's1', requestedId: 'u-a' })).toBe('u-a');
    // The other scope is untouched and still resolves through its alias.
    const managerB = createSessionManager('entry-b', messageB);
    aliases.observeMessageEnd({ cwd: '/b', sessionId: 's2', syntheticMessageId: 'u-b', message: messageB, sessionManager: managerB });
    expect(aliases.resolve({ cwd: '/b', sessionId: 's2', requestedId: 'u-b', sessionManager: managerB })).toBe('entry-b');
  });

  test(`idle scopes are pruned after ${ALIAS_SCOPE_IDLE_TTL_MS}ms once the retain threshold fires`, () => {
    let clock = 0;
    const now = () => clock;
    const aliases = createMessageEntryAliases({ now });

    aliases.retain({ cwd: '/old', sessionId: 'old', syntheticMessageId: 'u-old', message: { role: 'user' } });

    clock += ALIAS_SCOPE_IDLE_TTL_MS + 1;
    // Pruning is amortized into retain; crossing the threshold triggers one pass.
    for (let i = 0; i < 64; i += 1) {
      aliases.retain({ cwd: `/churn`, sessionId: `churn-${i}`, syntheticMessageId: `u-churn-${i}`, message: { role: 'user' } });
    }

    // The stale scope's alias is gone; resolve falls back to the raw id.
    expect(aliases.resolve({ cwd: '/old', sessionId: 'old', requestedId: 'u-old' })).toBe('u-old');
  });

  test('recent scopes survive idle pruning', () => {
    let clock = 0;
    const now = () => clock;
    const aliases = createMessageEntryAliases({ now });
    const message = { role: 'user' };

    aliases.retain({ cwd: '/fresh', sessionId: 'fresh', syntheticMessageId: 'u-fresh', message });
    clock += ALIAS_SCOPE_IDLE_TTL_MS + 1;
    for (let i = 0; i < 64; i += 1) {
      aliases.retain({ cwd: `/churn`, sessionId: `churn-${i}`, syntheticMessageId: `u-churn-${i}`, message: { role: 'user' } });
    }

    const manager = createSessionManager('entry-fresh', message);
    expect(aliases.resolve({ cwd: '/fresh', sessionId: 'fresh', requestedId: 'u-fresh', sessionManager: manager })).toBe('entry-fresh');
  });

  test(`scope count is capped at ${MAX_SCOPES}, evicting the oldest first`, () => {
    let clock = 0;
    const now = () => ++clock; // each retain stamps a fresher time
    const aliases = createMessageEntryAliases({ now });

    const overflow = 40;
    for (let i = 0; i < MAX_SCOPES + overflow; i += 1) {
      aliases.retain({ cwd: `/dir-${i}`, sessionId: `s-${i}`, syntheticMessageId: `u-${i}`, message: { role: 'user' } });
    }

    // Evicted (oldest) scopes fall back to raw ids without throwing…
    for (let i = 0; i < overflow; i += 1) {
      expect(aliases.resolve({ cwd: `/dir-${i}`, sessionId: `s-${i}`, requestedId: `u-${i}` })).toBe(`u-${i}`);
    }
    // …while the newest scope still holds its alias entry mapping.
    const newestIndex = MAX_SCOPES + overflow - 1;
    const newestMessage = { role: 'user', index: newestIndex };
    aliases.retain({ cwd: `/dir-late`, sessionId: `s-late`, syntheticMessageId: `u-late`, message: newestMessage });
    const manager = createSessionManager('entry-late', newestMessage);
    aliases.observeMessageEnd({ cwd: '/dir-late', sessionId: 's-late', syntheticMessageId: 'u-late', message: newestMessage, sessionManager: manager });
    expect(aliases.resolve({ cwd: '/dir-late', sessionId: 's-late', requestedId: 'u-late', sessionManager: manager })).toBe('entry-late');
  });
});
