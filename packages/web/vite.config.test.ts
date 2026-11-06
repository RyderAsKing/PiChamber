import { describe, expect, it } from 'vitest';

import config from './vite.config';

describe('Vite development proxy', () => {
  it('rewrites WebSocket origins to satisfy authenticated upstream origin checks', () => {
    const apiProxy = config.server?.proxy?.['/api'];

    expect(apiProxy).toMatchObject({
      rewriteWsOrigin: true,
      ws: true,
    });
  });

  it('forwards the browser host so the server knows its own UI', () => {
    const apiProxy = config.server?.proxy?.['/api'];
    const configure = typeof apiProxy === 'object' ? apiProxy.configure : undefined;
    let onProxyReq: ((proxyReq: { setHeader: (name: string, value: string) => void }, req: { headers: Record<string, string> }) => void) | undefined;
    configure?.({ on: (event: string, handler: typeof onProxyReq) => { if (event === 'proxyReq') onProxyReq = handler; } } as never, {} as never);
    const headers: Record<string, string> = {};
    onProxyReq?.({ setHeader: (name, value) => { headers[name] = value; } }, { headers: { host: '192.168.1.20:5180' } });
    expect(headers).toEqual({ 'x-forwarded-host': '192.168.1.20:5180' });
  });
});
