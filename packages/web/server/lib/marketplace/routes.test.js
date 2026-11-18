import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

import { registerMarketplaceRoutes } from './routes.js';

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});

describe('marketplace routes', () => {
  let server;

  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    server = undefined;
  });

  const setup = async (service) => {
    const app = express();
    app.use(express.json());
    registerMarketplaceRoutes(app, { service });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    return { call };
  };

  it('rejects bad query params with 400', async () => {
    const service = {
      search: vi.fn(async () => ({ packages: [], nextFrom: null })),
      packageDetail: vi.fn(),
      versions: vi.fn(async () => ({ versions: {} })),
    };
    const { call } = await setup(service);
    expect(await call('GET', '/api/pi/marketplace/search?from=abc'))
      .toEqual({ status: 400, body: { error: { code: 'INVALID_MARKETPLACE_REQUEST' } } });
    expect(await call('GET', '/api/pi/marketplace/search?from=1.5'))
      .toEqual({ status: 400, body: { error: { code: 'INVALID_MARKETPLACE_REQUEST' } } });
    expect(await call('GET', '/api/pi/marketplace/search?pichamber=yes'))
      .toEqual({ status: 400, body: { error: { code: 'INVALID_MARKETPLACE_REQUEST' } } });
    expect(await call('GET', '/api/pi/marketplace/package'))
      .toEqual({ status: 400, body: { error: { code: 'INVALID_MARKETPLACE_REQUEST' } } });
    expect(service.search).not.toHaveBeenCalled();
    expect(service.packageDetail).not.toHaveBeenCalled();
  });

  it('maps service errors to 404 and 502', async () => {
    const notFound = { code: 'MARKETPLACE_PACKAGE_NOT_FOUND' };
    const unavailable = { code: 'MARKETPLACE_UNAVAILABLE' };
    const service = {
      search: vi.fn(async () => { throw notFound; }),
      featured: vi.fn(async () => { throw unavailable; }),
      packageDetail: vi.fn(async () => { throw notFound; }),
      versions: vi.fn(async () => { throw unavailable; }),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { call } = await setup(service);
      expect(await call('GET', '/api/pi/marketplace/search')).toEqual({ status: 404, body: { error: notFound } });
      expect(await call('GET', '/api/pi/marketplace/featured')).toEqual({ status: 502, body: { error: unavailable } });
      expect(await call('GET', '/api/pi/marketplace/package?name=pi-lens')).toEqual({ status: 404, body: { error: notFound } });
      expect(await call('GET', '/api/pi/marketplace/versions?names=a')).toEqual({ status: 502, body: { error: unavailable } });
    } finally {
      warn.mockRestore();
    }
  });

  it('answers unknown errors as unavailable with 502', async () => {
    const service = {
      search: vi.fn(async () => { throw new Error('boom'); }),
      featured: vi.fn(),
      packageDetail: vi.fn(),
      versions: vi.fn(),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { call } = await setup(service);
      expect(await call('GET', '/api/pi/marketplace/search')).toEqual({
        status: 502,
        body: { error: { code: 'MARKETPLACE_UNAVAILABLE' } },
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('passes pichamber=1 through as pichamberOnly', async () => {
    const service = {
      search: vi.fn(async () => ({ packages: [], nextFrom: null })),
      featured: vi.fn(async () => ({ packages: [], updated: null, source: 'builtin' })),
      packageDetail: vi.fn(async (name) => ({ name })),
      versions: vi.fn(async (names) => ({ versions: Object.fromEntries(names.map((name) => [name, '1.0.0'])) })),
    };
    const { call } = await setup(service);
    expect(await call('GET', '/api/pi/marketplace/search?q=lens&pichamber=1&from=20')).toEqual({
      status: 200,
      body: { packages: [], nextFrom: null },
    });
    expect(service.search).toHaveBeenCalledWith({ query: 'lens', from: 20, pichamberOnly: true });
    expect(await call('GET', '/api/pi/marketplace/package?name=pi-lens')).toEqual({
      status: 200,
      body: { name: 'pi-lens' },
    });
    expect(service.packageDetail).toHaveBeenCalledWith('pi-lens');
    expect(await call('GET', '/api/pi/marketplace/versions?names=a,b')).toEqual({
      status: 200,
      body: { versions: { a: '1.0.0', b: '1.0.0' } },
    });
    expect(service.versions).toHaveBeenCalledWith(['a', 'b']);
  });
});
