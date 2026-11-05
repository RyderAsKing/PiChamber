import { describe, expect, it, vi } from 'vitest';

import {
  buildFallbackEnv,
  handleBrowserArguments,
  isHttpUrl,
  openWithFallback,
  resolveFallbackCommands,
} from './browser-handler.mjs';

describe('isHttpUrl', () => {
  it('accepts only http(s)', () => {
    expect(isHttpUrl('http://localhost:1/x')).toBe(true);
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('/tmp/report.html')).toBe(false);
    expect(isHttpUrl('file:///tmp/report.html')).toBe(false);
  });
});

describe('resolveFallbackCommands', () => {
  it('expands the $BROWSER list and ends with the platform opener', () => {
    expect(resolveFallbackCommands({ originalBrowser: 'firefox:w3m %s', platform: 'linux' }))
      .toEqual(['firefox "$1"', 'w3m "$1"', 'xdg-open "$1"']);
    expect(resolveFallbackCommands({ originalBrowser: '', platform: 'darwin' })).toEqual(['open "$1"']);
  });
});

describe('buildFallbackEnv', () => {
  it('restores the original $BROWSER and removes PiChamber variables', () => {
    expect(buildFallbackEnv({
      BROWSER: '/run/pc/pichamber-open-url',
      PICHAMBER_ORIGINAL_BROWSER: 'firefox',
      PICHAMBER_OPEN_URL_SOCKET: '/run/pc/open-url.sock',
      HOME: '/home/a',
    })).toEqual({ BROWSER: 'firefox', HOME: '/home/a' });
    expect(buildFallbackEnv({ BROWSER: '/run/pc/pichamber-open-url', PICHAMBER_ORIGINAL_BROWSER: '' }))
      .toEqual({});
  });
});

describe('openWithFallback', () => {
  it('tries each command until one succeeds', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const env = { PICHAMBER_ORIGINAL_BROWSER: 'missing-browser', BROWSER: '/launcher' };
    await expect(openWithFallback({ target: 'http://x.test', env, platform: 'linux', run })).resolves.toBe(true);
    expect(run.mock.calls.map(([command]) => command)).toEqual(['missing-browser "$1"', 'xdg-open "$1"']);
    expect(run.mock.calls[0][2].BROWSER).toBe('missing-browser');
  });
});

describe('handleBrowserArguments', () => {
  const env = { PICHAMBER_OPEN_URL_SOCKET: '/run/pc/open-url.sock', PI_SESSION_ID: 'session-1' };

  it('hands http(s) URLs to the intake with the session id', async () => {
    const send = vi.fn().mockResolvedValue(true);
    const fallback = vi.fn();
    await expect(handleBrowserArguments({ args: ['http://localhost:4000/review'], env, send, fallback })).resolves.toBe(0);
    expect(send).toHaveBeenCalledWith({
      socketPath: '/run/pc/open-url.sock', url: 'http://localhost:4000/review', sessionId: 'session-1',
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back when no device received it, and for non-http targets', async () => {
    const send = vi.fn().mockResolvedValue(false);
    const fallback = vi.fn().mockResolvedValue(true);
    await expect(handleBrowserArguments({ args: ['http://x.test', '/tmp/report.html'], env, send, fallback })).resolves.toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls.map(([options]) => options.target)).toEqual(['http://x.test', '/tmp/report.html']);
  });

  it('exits non-zero when nothing could open the target', async () => {
    const send = vi.fn().mockResolvedValue(false);
    const fallback = vi.fn().mockResolvedValue(false);
    await expect(handleBrowserArguments({ args: ['http://x.test'], env, send, fallback })).resolves.toBe(1);
  });
});
