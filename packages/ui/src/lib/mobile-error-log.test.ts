import { describe, expect, mock, test } from 'bun:test';

mock.module('@/lib/platform', () => ({ isCapacitorApp: () => true }));

describe('mobile error diagnostics', () => {
  test('exports bounded entries without credentials, URLs, or paths', async () => {
    const { buildMobileErrorLog, recordMobileDiagnostic } = await import('./mobile-error-log');

    recordMobileDiagnostic('stream', {
      code: 'failed',
      detail: 'Authorization: Bearer super-secret-client-token https://192.168.0.203:10000/api /home/ryder/project',
    });

    const exported = buildMobileErrorLog();
    expect(exported).toContain('pichamber-mobile-diagnostics-v1');
    expect(exported).toContain('[path]');
    expect(exported).not.toContain('super-secret-client-token');
    expect(exported).not.toContain('192.168.0.203');
    expect(exported).not.toContain('/home/ryder/project');
  });
});
