import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findBrowserWebview } from './browser-webview.mjs';

const fakeContents = ({ type = 'webview', host = { isDestroyed: () => false } } = {}) => ({
  hostWebContents: host,
  isDestroyed: () => false,
  getType: () => type,
});

describe('findBrowserWebview', () => {
  const windows = { fromWebContents: (host) => (host.window ? {} : null) };
  const lookup = (contents) => ({ fromId: (id) => (id === 7 ? contents : null) });

  it('returns a webview hosted in a PiChamber window', () => {
    const contents = fakeContents({ host: { isDestroyed: () => false, window: true } });
    assert.equal(findBrowserWebview(lookup(contents), windows, 7), contents);
  });

  it('refuses other web contents and bad ids', () => {
    assert.throws(() => findBrowserWebview(lookup(fakeContents({ type: 'window' })), windows, 7), /Not a browser page/);
    assert.throws(() => findBrowserWebview(lookup(fakeContents({ host: { isDestroyed: () => false } })), windows, 7), /Not a browser page/);
    assert.throws(() => findBrowserWebview(lookup(null), windows, 8), /not found/);
    assert.throws(() => findBrowserWebview(lookup(null), windows, 'x'), /required/);
  });
});
