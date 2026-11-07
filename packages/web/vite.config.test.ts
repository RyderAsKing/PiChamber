import { describe, expect, it } from 'vitest';

import config from './vite.config';

type Forward = (proxyReq: { setHeader: (name: string, value: string) => void }, req: { headers: Record<string, string> }) => void;

const forwardedHeaders = (path: '/api' | '/auth') => {
  const proxy = config.server?.proxy?.[path];
  const configure = typeof proxy === 'object' ? proxy.configure : undefined;
  const handlers = new Map<string, Forward>();
  configure?.({ on: (event: string, handler: Forward) => { handlers.set(event, handler); } } as never, {} as never);
  const sent = (event: string) => {
    const headers: Record<string, string> = {};
    handlers.get(event)?.({ setHeader: (name, value) => { headers[name] = value; } }, { headers: { host: '192.168.1.20:5180' } });
    return headers;
  };
  return { http: sent('proxyReq'), ws: sent('proxyReqWs') };
};

describe('Vite development proxy', () => {
  it('keeps the browser Origin on WebSocket upgrades, so the server can refuse other sites', () => {
    const apiProxy = config.server?.proxy?.['/api'];
    expect(apiProxy).toMatchObject({ ws: true });
    expect(typeof apiProxy === 'object' ? apiProxy.rewriteWsOrigin : undefined).toBeFalsy();
  });

  it('forwards the browser host on API requests and upgrades', () => {
    expect(forwardedHeaders('/api')).toEqual({
      http: { 'x-forwarded-host': '192.168.1.20:5180' },
      ws: { 'x-forwarded-host': '192.168.1.20:5180' },
    });
  });

  it('forwards the browser host on auth requests', () => {
    expect(forwardedHeaders('/auth').http).toEqual({ 'x-forwarded-host': '192.168.1.20:5180' });
  });
});
