import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_LOCAL_STT_MODEL, isLocalSttModelId } from './local/model-catalog.js';

const DEFAULT_CONFIG = Object.freeze({ enabled: false, providerConfigId: 'local', language: '', localModelId: DEFAULT_LOCAL_STT_MODEL, providers: [] });
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const cleanString = (value, max = 512) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function normalizeProvider(value, previous) {
  const id = cleanString(value?.id, 64);
  if (!ID_PATTERN.test(id) || id === 'local') throw new Error('Invalid STT provider configuration id');
  const baseUrl = cleanString(value?.baseUrl, 2048);
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('STT provider URL must use HTTP or HTTPS');
  const model = cleanString(value?.model, 256);
  if (!model) throw new Error('STT provider model is required');
  let apiKey = previous?.apiKey || '';
  if (value?.clearApiKey === true) apiKey = '';
  else if (typeof value?.apiKey === 'string' && value.apiKey.trim()) apiKey = value.apiKey.trim().slice(0, 4096);
  return { id, label: cleanString(value?.label, 100) || id, baseUrl: parsed.toString(), model, apiKey };
}

function normalizeConfig(value) {
  const providers = Array.isArray(value?.providers)
    ? value.providers.slice(0, 8).map((entry) => normalizeProvider(entry))
    : [];
  const providerConfigId = value?.providerConfigId === 'local' || providers.some((provider) => provider.id === value?.providerConfigId)
    ? value.providerConfigId
    : 'local';
  return {
    enabled: value?.enabled === true,
    providerConfigId,
    language: cleanString(value?.language, 35),
    localModelId: isLocalSttModelId(value?.localModelId) ? value.localModelId : DEFAULT_LOCAL_STT_MODEL,
    providers,
  };
}

const publicConfig = (config) => ({
  ...config,
  providers: config.providers.map(({ apiKey, ...provider }) => ({ ...provider, apiKeyConfigured: Boolean(apiKey) })),
});

export function createSttConfigStore({ file, fs = { chmod, mkdir, readFile, rename, rm, writeFile } }) {
  let mutation = Promise.resolve();
  const read = async () => {
    try { return normalizeConfig(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) { if (error?.code === 'ENOENT') return { ...DEFAULT_CONFIG, providers: [] }; throw new Error('STT configuration is invalid'); }
  };
  const write = async (changes) => {
    const operation = mutation.then(async () => {
      const current = await read();
      let providers = current.providers;
      if (changes?.remoteProvider) {
        const id = cleanString(changes.remoteProvider.id, 64);
        const previous = providers.find((entry) => entry.id === id);
        const updated = normalizeProvider(changes.remoteProvider, previous);
        providers = [...providers.filter((entry) => entry.id !== id), updated].slice(-8);
      }
      if (typeof changes?.deleteProviderId === 'string') providers = providers.filter((entry) => entry.id !== changes.deleteProviderId);
      const next = normalizeConfig({ ...current, ...changes, providers });
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, file);
        if (process.platform !== 'win32') await fs.chmod(file, 0o600);
        return next;
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    mutation = operation.catch(() => {});
    return operation;
  };
  return { read, write, readPublic: async () => publicConfig(await read()), publicConfig };
}
