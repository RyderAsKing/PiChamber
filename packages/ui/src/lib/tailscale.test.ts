import { describe, expect, mock, test } from 'bun:test';

// Bun's test mock declarations are intentionally untyped at this module boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runtimeFetch: any = mock(async () => new Response(JSON.stringify({ state: 'off' }), { status: 200 }));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch }));

const { getTailscaleStatus, updateTailscaleConfig, retryTailscale } = await import('@/lib/tailscale');
const { parsePairingConnectionPayload, buildPairingConnectionPayload, encodePairingConnectionPayload } = await import('@/lib/connectionPayload');
type TailscaleStatus = import('@/lib/tailscale').TailscaleStatus;
type TailscaleConfig = import('@/lib/tailscale').TailscaleConfig;

describe('tailscale client wrapper', () => {
  test('GETs status through runtimeFetch and validates the shape', async () => {
    runtimeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          installed: true,
          running: true,
          loggedIn: true,
          magicDnsName: 'm.ts.net',
          httpsCertsAvailable: null,
          config: { enabled: true, mode: 'private', httpsPort: 443 },
          state: 'active',
          url: 'https://m.ts.net',
          approvalUrl: null,
          errorCode: null,
          errorMessage: null,
        }),
        { status: 200 },
      ),
    );
    const status: TailscaleStatus = await getTailscaleStatus();
    expect(status.state).toBe('active');
    expect(status.url).toBe('https://m.ts.net');
    expect(String(runtimeFetch.mock.calls[0]?.[0])).toBe('/api/pichamber/tailscale/status');
  });

  test('PUTs partial config and surfaces error codes', async () => {
    const patch: Partial<TailscaleConfig> = { enabled: true, mode: 'public' };
    runtimeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Tailscale public (Funnel) access requires a UI password.', code: 'auth_required' }), { status: 403 }),
    );
    const error = await updateTailscaleConfig(patch).catch((e: Error) => e) as Error & { code?: string };
    expect(error.code).toBe('auth_required');
    const [, init] = runtimeFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual(patch);
  });

  test('POSTs retry', async () => {
    runtimeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ state: 'starting' }), { status: 200 }));
    const status: TailscaleStatus = await retryTailscale();
    expect(status.state).toBe('starting');
    const [path, init] = runtimeFetch.mock.calls.at(-1) as [string, RequestInit];
    expect(path).toBe('/api/pichamber/tailscale/retry');
    expect(init.method).toBe('POST');
  });
});

describe('tailscale pairing candidate', () => {
  test('round-trips a tailscale candidate and keeps priority order', () => {
    const link = encodePairingConnectionPayload(buildPairingConnectionPayload({
      pairingId: 'p1',
      secret: 's1',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.2:3000', priority: 10 },
        { type: 'tailscale', url: 'https://m.ts.net', mode: 'private', priority: 20 },
      ],
    }));
    const parsed = parsePairingConnectionPayload(link);
    expect(parsed?.candidates).toEqual([
      { type: 'lan', url: 'http://192.168.1.2:3000', priority: 10 },
      { type: 'tailscale', url: 'https://m.ts.net', mode: 'private', priority: 20 },
    ]);
  });

  test('drops the mode when it is not private/public', () => {
    const link = encodePairingConnectionPayload(buildPairingConnectionPayload({
      pairingId: 'p1',
      secret: 's1',
      candidates: [{ type: 'tailscale', url: 'https://m.ts.net', mode: 'weird' as never, priority: 20 }],
    }));
    expect(parsePairingConnectionPayload(link)?.candidates).toEqual([
      { type: 'tailscale', url: 'https://m.ts.net', priority: 20 },
    ]);
  });
});
