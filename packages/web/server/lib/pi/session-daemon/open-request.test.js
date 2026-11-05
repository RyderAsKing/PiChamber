import { describe, expect, it } from 'vitest';

import { normalizeOpenRequestUrl, OPEN_REQUEST_MAX_URL_LENGTH, resolveOpenRequestSession } from './open-request.js';

describe('normalizeOpenRequestUrl', () => {
  it('accepts http(s) URLs and rejects everything else', () => {
    expect(normalizeOpenRequestUrl(' http://localhost:3000/review ')).toBe('http://localhost:3000/review');
    expect(normalizeOpenRequestUrl('https://example.com')).toBe('https://example.com/');
    expect(normalizeOpenRequestUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeOpenRequestUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeOpenRequestUrl('/relative')).toBeNull();
    expect(normalizeOpenRequestUrl(42)).toBeNull();
    expect(normalizeOpenRequestUrl(`http://a.test/${'x'.repeat(OPEN_REQUEST_MAX_URL_LENGTH)}`)).toBeNull();
  });
});

describe('resolveOpenRequestSession', () => {
  const residents = [
    { sessionId: 'a', directory: '/repo/a', busy: false },
    { sessionId: 'b', directory: '/repo/b', busy: true },
    { sessionId: 'c', directory: '/repo/c', busy: false },
  ];

  it('uses the requested session when it is resident', () => {
    expect(resolveOpenRequestSession({ requestedSessionId: 'c', residents })).toEqual({
      sessionId: 'c', directory: '/repo/c', attributed: true,
    });
  });

  it('falls back to the sole busy session when the requested one is unknown', () => {
    expect(resolveOpenRequestSession({ requestedSessionId: 'gone', residents })).toEqual({
      sessionId: 'b', directory: '/repo/b', attributed: true,
    });
  });

  it('rides on the most recent session, unattributed, when several are busy', () => {
    const allBusy = residents.map((row) => ({ ...row, busy: true }));
    expect(resolveOpenRequestSession({ residents: allBusy, recent: { sessionId: 'c' } })).toEqual({
      sessionId: 'c', directory: '/repo/c', attributed: false,
    });
  });

  it('rides on the first resident when nothing is busy or recent', () => {
    const idle = residents.map((row) => ({ ...row, busy: false }));
    expect(resolveOpenRequestSession({ residents: idle, recent: { sessionId: 'missing' } })).toEqual({
      sessionId: 'a', directory: '/repo/a', attributed: false,
    });
  });

  it('returns null with no resident sessions', () => {
    expect(resolveOpenRequestSession({ residents: [] })).toBeNull();
    expect(resolveOpenRequestSession({ requestedSessionId: 'a', residents: undefined })).toBeNull();
  });
});
