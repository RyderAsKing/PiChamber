import { PCM_SAMPLE_RATE } from '../audio.js';

export function createLocalWorkerProvider({ workerClient, modelsDir, modelId, language }) {
  return {
    sampleRate: PCM_SAMPLE_RATE,
    async transcribe(pcm16) {
      return workerClient.transcribe({ pcm16, sampleRate: PCM_SAMPLE_RATE, modelsDir, modelId, language });
    },
    close() {},
  };
}
