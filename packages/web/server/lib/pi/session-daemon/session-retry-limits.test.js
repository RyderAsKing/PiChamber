import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  PI_FALLBACK_RETRY_LIMIT,
  resolveEffectiveRetryLimitFromDataDir as resolveEffectiveRetryLimit,
} from './session-retry-limits.js';

const makeDataDir = (sidecar) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pichamber-retry-'));
  if (sidecar !== undefined) {
    mkdirSync(join(dataDir, 'pi'), { recursive: true });
    writeFileSync(join(dataDir, 'pi', 'settings.json'), JSON.stringify(sidecar));
  }
  return dataDir;
};

describe('resolveEffectiveRetryLimit', () => {
  test('explicit payload value wins and is validated', async () => {
    await expect(resolveEffectiveRetryLimit({ payloadRetryLimit: 7, dataDir: makeDataDir({ defaultRetryLimit: 2 }) })).resolves.toBe(7);
    await expect(resolveEffectiveRetryLimit({ payloadRetryLimit: -1, dataDir: undefined })).rejects.toThrow('between 0 and 10');
    await expect(resolveEffectiveRetryLimit({ payloadRetryLimit: 11, dataDir: undefined })).rejects.toThrow('between 0 and 10');
    await expect(resolveEffectiveRetryLimit({ payloadRetryLimit: 2.5, dataDir: undefined })).rejects.toThrow('between 0 and 10');
  });

  test('sidecar default applies when no explicit value is given', async () => {
    const dataDir = makeDataDir({ version: 1, defaultRetryLimit: 9 });
    await expect(resolveEffectiveRetryLimit({ dataDir })).resolves.toBe(9);
  });

  test(`no sidecar resolves to undefined so Pi stays authoritative (built-in fallback ${PI_FALLBACK_RETRY_LIMIT})`, async () => {
    // No settings file at all.
    await expect(resolveEffectiveRetryLimit({ dataDir: makeDataDir(undefined) })).resolves.toBeUndefined();
    // File exists but has no retry key.
    await expect(resolveEffectiveRetryLimit({ dataDir: makeDataDir({ version: 1 }) })).resolves.toBeUndefined();
    // null is treated as "no override", matching the store's normalize().
    await expect(resolveEffectiveRetryLimit({ dataDir: makeDataDir({ version: 1, defaultRetryLimit: null }) })).resolves.toBeUndefined();
  });

  test('a malformed sidecar value fails loudly instead of silently falling back', async () => {
    const badTypes = [3.5, -1, 11, 'five'];
    for (const defaultRetryLimit of badTypes) {
      const dataDir = makeDataDir({ version: 1, defaultRetryLimit });
      await expect(resolveEffectiveRetryLimit({ dataDir })).rejects.toThrow(/retry limit|JSON/i);
    }
    // Malformed JSON surfaces as a syntax error, not a silent undefined.
    const dataDir = mkdtempSync(join(tmpdir(), 'pichamber-retry-'));
    mkdirSync(join(dataDir, 'pi'), { recursive: true });
    writeFileSync(join(dataDir, 'pi', 'settings.json'), '{ not json');
    await expect(resolveEffectiveRetryLimit({ dataDir })).rejects.toThrow();
  });
});
