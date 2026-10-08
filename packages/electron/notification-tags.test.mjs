import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createNotificationTagRegistry, MAX_NOTIFICATION_TAG_ENTRIES } from './notification-tags.mjs';

describe('notification tag registry', () => {
  it('stores and takes handles by tag', () => {
    const registry = createNotificationTagRegistry();
    const handle = { closed: false, close() { this.closed = true; } };
    registry.set('pichamber:input:s1:123', handle);
    assert.equal(registry.size(), 1);
    assert.equal(registry.take('pichamber:input:s1:123'), handle);
    assert.equal(registry.size(), 0);
    assert.equal(registry.take('pichamber:input:s1:123'), undefined);
  });

  it('ignores blank tags and empty handles', () => {
    const registry = createNotificationTagRegistry();
    registry.set('', { close() {} });
    registry.set('   ', { close() {} });
    registry.set('tag', null);
    registry.set('tag', undefined);
    assert.equal(registry.size(), 0);
  });

  it('evicts the oldest entry past the bound', () => {
    const registry = createNotificationTagRegistry(2);
    const first = { id: 'first' };
    registry.set('a', first);
    registry.set('b', { id: 'b' });
    registry.set('c', { id: 'c' });
    assert.equal(registry.size(), 2);
    assert.equal(registry.get('a'), undefined);
    assert.equal(registry.get('b')?.id, 'b');
    assert.equal(registry.get('c')?.id, 'c');
  });

  it('re-setting a tag refreshes recency instead of growing', () => {
    const registry = createNotificationTagRegistry(2);
    registry.set('a', { id: 'a1' });
    registry.set('b', { id: 'b' });
    registry.set('a', { id: 'a2' });
    registry.set('c', { id: 'c' });
    assert.equal(registry.size(), 2);
    assert.equal(registry.get('a')?.id, 'a2');
    assert.equal(registry.get('b'), undefined);
    assert.equal(registry.get('c')?.id, 'c');
  });

  it('remove and clear drop entries', () => {
    const registry = createNotificationTagRegistry();
    registry.set('a', { id: 'a' });
    assert.equal(registry.remove('a'), true);
    assert.equal(registry.remove('a'), false);
    registry.set('b', { id: 'b' });
    registry.clear();
    assert.equal(registry.size(), 0);
  });

  it('exposes a sane default bound', () => {
    assert.ok(Number.isSafeInteger(MAX_NOTIFICATION_TAG_ENTRIES) && MAX_NOTIFICATION_TAG_ENTRIES > 0);
    const registry = createNotificationTagRegistry();
    for (let i = 0; i < MAX_NOTIFICATION_TAG_ENTRIES + 5; i += 1) {
      registry.set(`tag-${i}`, { id: i });
    }
    assert.equal(registry.size(), MAX_NOTIFICATION_TAG_ENTRIES);
  });
});
