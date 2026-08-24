import { describe, expect, it } from 'vitest';

import { applyUiCorsHeaders, isAllowedUiCorsOrigin, resolveAllowedCorsHeaders } from './cors.js';

describe('packaged UI CORS', () => {
  it('allows the Electron custom-scheme origin and loopback HMR origins', () => {
    expect(isAllowedUiCorsOrigin('pichamber-ui://app')).toBe(true);
    expect(isAllowedUiCorsOrigin('capacitor://localhost')).toBe(true);
    expect(isAllowedUiCorsOrigin('https://localhost')).toBe(true);
    expect(isAllowedUiCorsOrigin('http://localhost')).toBe(true);
    expect(isAllowedUiCorsOrigin('http://127.0.0.1:57123')).toBe(true);
    expect(isAllowedUiCorsOrigin('https://example.test')).toBe(false);
  });

  it('allows the workspace directory header used by packaged filesystem fetches', () => {
    expect(resolveAllowedCorsHeaders('x-pichamber-directory,authorization')).toBe('x-pichamber-directory,authorization');
    expect(resolveAllowedCorsHeaders('x-pichamber-directory')).toBe('x-pichamber-directory');
    expect(resolveAllowedCorsHeaders('x-evil')).toBe(
      'Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,x-pichamber-directory',
    );
  });

  it('answers Electron preflight with the requested directory header', () => {
    const headers = {};
    const res = { setHeader(name, value) { headers[name] = value; } };
    const ended = applyUiCorsHeaders({
      method: 'OPTIONS',
      headers: {
        origin: 'pichamber-ui://app',
        'access-control-request-headers': 'x-pichamber-directory,authorization',
      },
    }, res);
    expect(ended).toBe(true);
    expect(headers['Access-Control-Allow-Origin']).toBe('pichamber-ui://app');
    expect(headers['Access-Control-Allow-Headers']).toBe('x-pichamber-directory,authorization');
  });
});
