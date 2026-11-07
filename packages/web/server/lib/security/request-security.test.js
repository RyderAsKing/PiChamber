import { describe, expect, test } from 'bun:test';
import { createRequestSecurityRuntime } from './request-security.js';

const createRuntime = () => createRequestSecurityRuntime({
  readSettingsFromDiskMigrated: async () => ({}),
});

describe('request security runtime', () => {
  test('allows packaged client origins for remote client transports', async () => {
    const runtime = createRuntime();

    await expect(runtime.isRequestOriginAllowed({
      headers: {
        origin: 'pichamber-ui://app',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).resolves.toBe(true);

    await expect(runtime.isRequestOriginAllowed({
      headers: {
        origin: 'capacitor://localhost',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).resolves.toBe(true);

    // Android Capacitor WebView (androidScheme 'https') reports this origin.
    await expect(runtime.isRequestOriginAllowed({
      headers: {
        origin: 'https://localhost',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).resolves.toBe(true);

    await expect(runtime.isRequestOriginAllowed({
      headers: {
        origin: 'http://localhost',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).resolves.toBe(true);
  });

  test('rejects unknown origins', async () => {
    const runtime = createRuntime();

    await expect(runtime.isRequestOriginAllowed({
      headers: {
        origin: 'https://evil.example.com',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).resolves.toBe(false);
  });

  describe('cross-site requests', () => {
    const request = (headers, extra = {}) => ({ headers: { host: '127.0.0.1:3001', ...headers }, socket: {}, ...extra });

    test('allows requests without an Origin', async () => {
      await expect(createRuntime().isCrossSiteRequest(request({}))).resolves.toBe(false);
    });

    test('allows PiChamber itself, packaged clients, and loopback pages', async () => {
      const runtime = createRuntime();
      for (const origin of ['http://127.0.0.1:3001', 'http://localhost:3001', 'pichamber-ui://app', 'capacitor://localhost', 'http://localhost:5180', 'http://127.0.0.1:4000']) {
        await expect(runtime.isCrossSiteRequest(request({ origin }))).resolves.toBe(false);
      }
    });

    test('allows a request the browser marks same-origin behind a proxy that rewrote Host', async () => {
      await expect(createRuntime().isCrossSiteRequest(request({
        origin: 'http://192.168.1.20:5180',
        'sec-fetch-site': 'same-origin',
      }))).resolves.toBe(false);
    });

    test('refuses other sites, opaque origins, and a forged same-site claim', async () => {
      const runtime = createRuntime();
      await expect(runtime.isCrossSiteRequest(request({ origin: 'https://evil.example.com' }))).resolves.toBe(true);
      await expect(runtime.isCrossSiteRequest(request({ origin: 'null' }))).resolves.toBe(true);
      await expect(runtime.isCrossSiteRequest(request({ origin: 'https://evil.example.com', 'sec-fetch-site': 'same-site' }))).resolves.toBe(true);
    });

    const runGuard = async (req) => {
      const runtime = createRuntime();
      const result = { next: false, status: null, body: null };
      await new Promise((resolve) => {
        const res = {
          status(code) { result.status = code; return this; },
          json(body) { result.body = body; resolve(); return this; },
        };
        runtime.rejectCrossSiteRequests(req, res, () => { result.next = true; resolve(); });
      });
      return result;
    };

    test('the HTTP guard refuses a state-changing request from another site', async () => {
      const result = await runGuard(request({ origin: 'https://evil.example.com' }, { method: 'POST', originalUrl: '/api/terminal/create' }));
      expect(result).toEqual({ next: false, status: 403, body: { error: 'Invalid origin' } });
    });

    test('the HTTP guard lets reads, own requests, and preview proxy traffic through', async () => {
      expect((await runGuard(request({ origin: 'https://evil.example.com' }, { method: 'GET', originalUrl: '/api/version' }))).next).toBe(true);
      expect((await runGuard(request({ origin: 'http://127.0.0.1:3001' }, { method: 'POST', originalUrl: '/api/terminal/create' }))).next).toBe(true);
      expect((await runGuard(request({}, { method: 'DELETE', originalUrl: '/api/terminal/abc' }))).next).toBe(true);
      expect((await runGuard(request({ origin: 'null' }, { method: 'POST', originalUrl: '/api/preview/proxy/t1/api/save' }))).next).toBe(true);
    });
  });
});
