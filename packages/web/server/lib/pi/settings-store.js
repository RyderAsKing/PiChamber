import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';
import { isPiThinkingLevel } from './thinking-levels.js';

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

const parseThinkingModelKey = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 768) return undefined;
  const separator = value.indexOf('/');
  if (separator <= 0 || separator >= value.length - 1) return undefined;
  const providerId = value.slice(0, separator).trim();
  const modelId = value.slice(separator + 1).trim();
  if (!providerId || !modelId || providerId.length > 256 || modelId.length > 512) return undefined;
  return `${providerId}/${modelId}`;
};

const normalizeThinkingByModel = (value) => {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSettings();
  const entries = Object.entries(value);
  if (entries.length > 256) throw invalidSettings();
  const result = {};
  for (const [rawKey, level] of entries) {
    if (level === null || level === '') continue;
    const key = parseThinkingModelKey(rawKey);
    if (!key || !isPiThinkingLevel(level)) throw invalidSettings();
    result[key] = level;
  }
  return result;
};

const mergeThinkingByModel = (current, incoming) => {
  if (incoming === null) return {};
  if (incoming === undefined) return { ...current };
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw invalidSettings();
  const next = { ...current };
  for (const [rawKey, level] of Object.entries(incoming)) {
    const key = parseThinkingModelKey(rawKey);
    if (!key) throw invalidSettings();
    if (level === null || level === '') {
      delete next[key];
      continue;
    }
    if (!isPiThinkingLevel(level)) throw invalidSettings();
    next[key] = level;
  }
  return next;
};

const normalize = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSettings();
  const model = normalizeModel(value.defaultModel);
  const smallModel = normalizeModel(value.smallModel);
  const walkthroughModel = normalizeModel(value.walkthroughModel);
  const thinking = value.defaultThinking === null ? undefined : value.defaultThinking;
  if (thinking !== undefined && !isPiThinkingLevel(thinking)) throw invalidSettings();
  const thinkingByModel = normalizeThinkingByModel(value.defaultThinkingByModel);
  let fallbackThinking = thinking;
  if (fallbackThinking && model) {
    const key = `${model.providerId}/${model.modelId}`;
    if (!thinkingByModel[key]) thinkingByModel[key] = fallbackThinking;
    fallbackThinking = undefined;
  }
  return {
    version: 1,
    ...(model ? { defaultModel: model } : {}),
    ...(smallModel ? { smallModel } : {}),
    ...(walkthroughModel ? { walkthroughModel } : {}),
    ...(Object.keys(thinkingByModel).length > 0 ? { defaultThinkingByModel: thinkingByModel } : {}),
    ...(fallbackThinking ? { defaultThinking: fallbackThinking } : {}),
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
        defaultThinkingByModel: Object.hasOwn(patch, 'defaultThinkingByModel')
          ? mergeThinkingByModel(current.defaultThinkingByModel ?? {}, patch.defaultThinkingByModel)
          : (current.defaultThinkingByModel ?? {}),
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
