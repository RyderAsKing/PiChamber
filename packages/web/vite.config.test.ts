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
});
