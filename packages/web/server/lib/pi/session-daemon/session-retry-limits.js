import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PI_FALLBACK_RETRY_LIMIT = 3;
const PI_MIN_RETRY_LIMIT = 0;
const PI_MAX_RETRY_LIMIT = 10;

const isValidRetryLimit = (value) => Number.isInteger(value) && value >= PI_MIN_RETRY_LIMIT && value <= PI_MAX_RETRY_LIMIT;

/**
 * Resolve the retry limit a new session should run with.
 *
 * Precedence: an explicit per-create payload value wins; otherwise the
 * PiChamber default-retry-limit sidecar setting applies. When neither is
 * configured the result is `undefined` and the caller must leave the runtime's
 * own retry settings untouched — Pi stays authoritative and its built-in
 * default (3) already matches the documented fallback.
 */
const resolveEffectiveRetryLimit = async ({ payloadRetryLimit, readSettingsFile = readFile, settingsPath } = {}) => {
  if (payloadRetryLimit !== undefined) {
    if (!isValidRetryLimit(payloadRetryLimit)) {
      throw new Error('The retry limit must be an integer between 0 and 10.');
    }
    return payloadRetryLimit;
  }

  if (settingsPath !== undefined) {
    try {
      const raw = await readSettingsFile(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (isValidRetryLimit(parsed?.defaultRetryLimit)) return parsed.defaultRetryLimit;
      if (parsed?.defaultRetryLimit !== undefined && parsed?.defaultRetryLimit !== null) {
        throw new Error('The retry limit must be an integer between 0 and 10.');
      }
    } catch (error) {
      // A malformed sidecar value must fail loudly; absence (ENOENT / empty
      // file) is the normal no-override case and resolves to undefined.
      if (error?.code === 'ENOENT') return undefined;
      if (error instanceof SyntaxError || error?.message?.includes('retry limit')) throw error;
      throw error;
    }
  }
  return undefined;
};

/** Convenience wrapper used by the daemon with its standard data-dir path. */
export const resolveEffectiveRetryLimitFromDataDir = async ({ payloadRetryLimit, dataDir }) => (
  resolveEffectiveRetryLimit({
    payloadRetryLimit,
    // An explicit payload value never reads the sidecar, so no path is needed.
    ...(payloadRetryLimit === undefined && dataDir !== undefined
      ? { settingsPath: join(dataDir, 'pi', 'settings.json') }
      : {}),
  })
);
