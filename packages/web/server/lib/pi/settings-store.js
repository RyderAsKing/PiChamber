import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';

const THINKING_LEVELS = new Set(['off', 'low', 'medium', 'high', 'xhigh']);

const invalidSettings = () => {
  const error = new Error('PiChamber Pi settings are invalid.');
  error.code = 'PI_SETTINGS_INVALID';
  return error;
};

const normalizeModel = (value) => {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || typeof value.providerId !== 'string' || typeof value.modelId !== 'string'
    || value.providerId.trim().length === 0 || value.modelId.trim().length === 0
    || value.providerId.length > 256 || value.modelId.length > 512) {
    throw invalidSettings();
  }
  return { providerId: value.providerId.trim(), modelId: value.modelId.trim() };
};

const normalize = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSettings();
  const model = normalizeModel(value.defaultModel);
  const smallModel = normalizeModel(value.smallModel);
  const walkthroughModel = normalizeModel(value.walkthroughModel);
  const thinking = value.defaultThinking === null ? undefined : value.defaultThinking;
  if (thinking !== undefined && !THINKING_LEVELS.has(thinking)) throw invalidSettings();
  return {
    version: 1,
    ...(model ? { defaultModel: model } : {}),
    ...(smallModel ? { smallModel } : {}),
    ...(walkthroughModel ? { walkthroughModel } : {}),
    ...(thinking ? { defaultThinking: thinking } : {}),
  };
};

/**
 * PiChamber-owned new-session defaults. This is intentionally separate from
 * Pi's settings.json: Pi remains authoritative when no PiChamber override is
 * configured, and credentials never enter this sidecar.
 */
export const createPiSettingsStore = ({ file = join(resolvePiChamberDataDir(), 'pi', 'settings.json') } = {}) => {
  let writeChain = Promise.resolve();

  const read = async () => {
    try {
      return normalize(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1 };
      if (error?.code === 'PI_SETTINGS_INVALID') throw error;
      throw invalidSettings();
    }
  };

  const update = async (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalidSettings();
    const operation = writeChain.then(async () => {
      const current = await read();
      const next = normalize({
        ...current,
        ...(Object.hasOwn(patch, 'defaultModel') ? { defaultModel: patch.defaultModel } : {}),
        ...(Object.hasOwn(patch, 'defaultThinking') ? { defaultThinking: patch.defaultThinking } : {}),
        ...(Object.hasOwn(patch, 'smallModel') ? { smallModel: patch.smallModel } : {}),
        ...(Object.hasOwn(patch, 'walkthroughModel') ? { walkthroughModel: patch.walkthroughModel } : {}),
      });
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await rename(temporary, file);
      return next;
    });
    writeChain = operation.catch(() => {});
    return operation;
  };

  return { read, update };
};
