import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDockBadgeAggregator, originOfUrl } from './dock-badge.mjs';

describe('dock badge aggregator', () => {
  it('sums distinct origins and takes the max per origin', () => {
    const badge = createDockBadgeAggregator();
    assert.equal(badge.set(1, 'http://a', 2), 2);
    // Same origin reports the same count: max, not sum.
    assert.equal(badge.set(2, 'http://a', 2), 2);
    // A higher report from one window on the origin raises the origin max.
    assert.equal(badge.set(2, 'http://a', 3), 3);
    // A distinct origin adds to the total.
    assert.equal(badge.set(3, 'http://b', 1), 4);
  });

  it('lets an idle window clear without hiding another origin', () => {
    const badge = createDockBadgeAggregator();
    badge.set(1, 'http://a', 2);
    badge.set(2, 'http://b', 1);
    assert.equal(badge.set(1, 'http://a', 0), 1);
    assert.equal(badge.total(), 1);
  });

  it('drops a sender entry on remove and recomputes', () => {
    const badge = createDockBadgeAggregator();
    badge.set(1, 'http://a', 2);
    badge.set(2, 'http://b', 3);
    assert.equal(badge.total(), 5);
    assert.equal(badge.remove(2), 2);
    assert.equal(badge.total(), 2);
    assert.equal(badge.size(), 1);
  });

  it('normalizes non-finite and negative counts to zero', () => {
    const badge = createDockBadgeAggregator();
    assert.equal(badge.set(1, 'http://a', Number.NaN), 0);
    assert.equal(badge.set(1, 'http://a', -4), 0);
    assert.equal(badge.set(1, 'http://a', 2.7), 2);
    assert.equal(badge.total(), 2);
  });

  it('groups senders without an origin together', () => {
    const badge = createDockBadgeAggregator();
    badge.set(1, '', 2);
    badge.set(2, undefined, 3);
    assert.equal(badge.total(), 3);
  });

  it('derives origins from sender URLs', () => {
    assert.equal(originOfUrl('http://127.0.0.1:3123/?runtime=a'), 'http://127.0.0.1:3123');
    assert.equal(originOfUrl('http://127.0.0.1:4123/?runtime=b'), 'http://127.0.0.1:4123');
    assert.equal(originOfUrl(''), '__unknown__');
  });
});
