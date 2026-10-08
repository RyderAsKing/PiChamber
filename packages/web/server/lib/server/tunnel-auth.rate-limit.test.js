import { describe, expect, it } from 'vitest';
import { createTunnelAuth } from './tunnel-auth.js';

const SOCKET_MAX = 20 * 5; // CONNECT_RATE_LIMIT_MAX_ATTEMPTS x socket multiplier

const connectReq = (xff, socketIp) => ({
  headers: { 'x-forwarded-for': xff },
  socket: { remoteAddress: socketIp },
});

const stubRes = () => ({ setHeader() {} });

const activateWithBootstrap = (tunnel) => {
  tunnel.setActiveTunnel({ tunnelId: 't1', publicUrl: 'https://example.trycloudflare.com', mode: 'managed' });
  return tunnel.issueBootstrapToken({ ttlMs: 60_000 });
};

describe('connect rate limit socket bucket (F1)', () => {
  it('locks out XFF rotation from one socket after the socket threshold', () => {
    const tunnel = createTunnelAuth();
    activateWithBootstrap(tunnel);
    const res = stubRes();
    for (let i = 0; i < SOCKET_MAX; i++) {
      const out = tunnel.exchangeBootstrapToken({
        req: connectReq(`203.0.113.${(i % 250) + 1}`, '198.51.100.81'),
        res,
        token: 'wrong-token',
        sessionTtlMs: 1000,
      });
      expect(out).toMatchObject({ ok: false, reason: 'invalid-token' });
    }
    const locked = tunnel.exchangeBootstrapToken({
      req: connectReq('203.0.113.250', '198.51.100.81'),
      res,
      token: 'wrong-token',
      sessionTtlMs: 1000,
    });
    expect(locked).toMatchObject({ ok: false, reason: 'rate-limited' });
    expect(locked.retryAfter).toBeGreaterThan(0);
  });

  it('keeps distinct sockets independent', () => {
    const tunnel = createTunnelAuth();
    activateWithBootstrap(tunnel);
    const res = stubRes();
    // Exhaust the per-client bucket for one XFF on socket A (20 attempts).
    for (let i = 0; i < 20; i++) {
      const out = tunnel.exchangeBootstrapToken({
        req: connectReq('198.51.100.82', '192.0.2.21'),
        res,
        token: 'wrong-token',
        sessionTtlMs: 1000,
      });
      expect(out).toMatchObject({ ok: false, reason: 'invalid-token' });
    }
    const locked = tunnel.exchangeBootstrapToken({
      req: connectReq('198.51.100.82', '192.0.2.21'),
      res,
      token: 'wrong-token',
      sessionTtlMs: 1000,
    });
    expect(locked).toMatchObject({ ok: false, reason: 'rate-limited' });
    // A different socket with a fresh XFF is unaffected.
    const other = tunnel.exchangeBootstrapToken({
      req: connectReq('198.51.100.83', '192.0.2.22'),
      res,
      token: 'wrong-token',
      sessionTtlMs: 1000,
    });
    expect(other).toMatchObject({ ok: false, reason: 'invalid-token' });
  });
});
