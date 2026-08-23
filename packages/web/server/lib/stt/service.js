import { rm } from 'node:fs/promises';

import { createSttConfigStore } from './config-store.js';
import { LOCAL_STT_MODEL_CATALOG, LOCAL_STT_MODEL_IDS, getLocalSttModelDir, isLocalSttModelId } from './local/model-catalog.js';
import { ensureLocalSttModel, inspectLocalSttModel } from './local/model-downloader.js';
import { SttWorkerClient } from './local/worker-client.js';
import { createLocalWorkerProvider } from './providers/local-worker-provider.js';
import { createOpenAICompatibleProvider } from './providers/openai-compatible-provider.js';

export function createSttService({ modelsDir, configFile }) {
  const configStore = createSttConfigStore({ file: configFile });
  const workerClient = new SttWorkerClient();
  const downloads = new Map();
  const verifiedModels = new Set();

  const startDownload = (modelId) => {
    const active = downloads.get(modelId);
    if (active?.state === 'downloading') return active.promise;
    const abortController = new AbortController();
    const state = { state: 'downloading', progress: 0, error: null, promise: null, abortController };
    state.promise = ensureLocalSttModel({
      modelsDir,
      modelId,
      signal: abortController.signal,
      onProgress: (downloaded, total) => { state.progress = total ? Math.min(100, Math.round(downloaded / total * 100)) : null; },
    }).then(() => {
      verifiedModels.add(modelId);
      downloads.delete(modelId);
    }).catch((error) => {
      state.state = 'error';
      state.error = error?.message || 'Model download failed';
    });
    downloads.set(modelId, state);
    return state.promise;
  };

  const modelStatus = async (modelId) => {
    const inspection = await inspectLocalSttModel(modelsDir, modelId);
    const download = downloads.get(modelId);
    return {
      id: modelId,
      description: LOCAL_STT_MODEL_CATALOG[modelId].description,
      sizeBytes: LOCAL_STT_MODEL_CATALOG[modelId].sizeBytes,
      installed: inspection.installed,
      corrupt: inspection.corrupt,
      downloading: download?.state === 'downloading',
      downloadProgress: download?.state === 'downloading' ? download.progress : null,
      downloadError: download?.state === 'error' ? download.error : null,
    };
  };

  const getStatus = async () => ({
    config: await configStore.readPublic(),
    models: await Promise.all(LOCAL_STT_MODEL_IDS.map(modelStatus)),
  });

  const createTranscriber = async (providerConfigId) => {
    const config = await configStore.read();
    if (!config.enabled) throw Object.assign(new Error('Dictation is disabled in Settings'), { code: 'STT_DISABLED' });
    const selectedId = typeof providerConfigId === 'string' && providerConfigId ? providerConfigId : config.providerConfigId;
    if (selectedId === 'local') {
      const modelId = config.localModelId;
      let inspection = await inspectLocalSttModel(modelsDir, modelId, { verifyChecksums: !verifiedModels.has(modelId) });
      if (inspection.installed) verifiedModels.add(modelId);
      if (!inspection.installed) {
        if (inspection.corrupt) await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true });
        void startDownload(modelId);
        throw Object.assign(new Error(inspection.corrupt ? 'The local speech model was corrupt and is being downloaded again' : 'The local speech model is downloading'), { code: inspection.corrupt ? 'MODEL_CORRUPT' : 'MODEL_DOWNLOADING' });
      }
      return createLocalWorkerProvider({ workerClient, modelsDir, modelId, language: config.language });
    }
    const provider = config.providers.find((entry) => entry.id === selectedId);
    if (!provider) throw Object.assign(new Error('STT provider configuration was not found'), { code: 'STT_NOT_CONFIGURED' });
    return createOpenAICompatibleProvider({ ...provider, language: config.language });
  };

  const requestModelDownload = async (modelId) => {
    if (!isLocalSttModelId(modelId)) throw new Error('Unknown STT model');
    const inspection = await inspectLocalSttModel(modelsDir, modelId);
    if (inspection.installed) return { ok: true, installed: true };
    if (inspection.corrupt) await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true });
    void startDownload(modelId);
    return { ok: true, installed: false };
  };

  const deleteModel = async (modelId) => {
    if (!isLocalSttModelId(modelId)) throw new Error('Unknown STT model');
    if (downloads.get(modelId)?.state === 'downloading') throw new Error('The model is downloading');
    verifiedModels.delete(modelId);
    downloads.delete(modelId);
    await rm(getLocalSttModelDir(modelsDir, modelId), { recursive: true, force: true });
    return { ok: true };
  };

  return {
    getStatus,
    updateConfig: async (changes) => configStore.publicConfig(await configStore.write(changes)),
    createTranscriber,
    requestModelDownload,
    deleteModel,
    shutdown: () => {
      for (const download of downloads.values()) download.abortController?.abort();
      workerClient.shutdown();
    },
  };
}
