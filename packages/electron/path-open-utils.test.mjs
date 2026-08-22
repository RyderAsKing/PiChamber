import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSafeExternalUrl, openExternalUrlIfSafe } from './path-open-utils.mjs';

test('isSafeExternalUrl accepts http and https URLs', () => {
  assert.equal(isSafeExternalUrl('http://127.0.0.1:3000/settings'), true);
  assert.equal(isSafeExternalUrl('https://github.com/RyderAsKing/PiChamber'), true);
});

test('isSafeExternalUrl rejects non-http schemes and malformed input', () => {
  for (const candidate of [
    'file:///etc/passwd',
    'ms-msdt:defender',
    'search-ms:query=x',
    'javascript:alert(1)',
    'ssh://host/key',
    'not a url',
    '',
    null,
    undefined,
    'https://',
  ]) {
    assert.equal(isSafeExternalUrl(candidate), false, `expected rejection: ${String(candidate)}`);
  }
});

test('openExternalUrlIfSafe forwards safe URLs to the shell', async () => {
  const opened = [];
  const shellLike = { openExternal: async (url) => { opened.push(url); } };
  const result = await openExternalUrlIfSafe(shellLike, 'https://example.test/page');
  assert.equal(result, true);
  assert.deepEqual(opened, ['https://example.test/page']);
});

test('openExternalUrlIfSafe never calls the OS handler for unsafe URLs', async () => {
  let called = false;
  const shellLike = { openExternal: async () => { called = true; } };
  for (const candidate of ['file:///etc/passwd', 'ms-msdt:x', 'javascript:void(0)', 'garbage']) {
    assert.equal(await openExternalUrlIfSafe(shellLike, candidate), false);
  }
  assert.equal(called, false);
});

test('openExternalUrlIfSafe propagates OS-handler failures after the allowlist passes', async () => {
  const shellLike = {
    openExternal: async () => { throw new Error('spawn failed'); },
  };
  await assert.rejects(
    () => openExternalUrlIfSafe(shellLike, 'https://example.test/'),
    /spawn failed/,
  );
});
