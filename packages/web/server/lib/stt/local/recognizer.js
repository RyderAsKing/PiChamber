import { existsSync } from 'node:fs';
import path from 'node:path';

import { pcm16Peak, pcm16ToFloat32, PCM_SAMPLE_RATE } from '../audio.js';
import { getLocalSttModelDir, getLocalSttModelSpec } from './model-catalog.js';
import { loadSherpaOnnxNode } from './sherpa-loader.js';

const required = (value, label) => {
  if (!existsSync(value)) throw new Error(`Missing ${label}`);
  return value;
};

export class SherpaRecognizer {
  constructor({ modelsDir, modelId, language, numThreads = 2 }) {
    const spec = getLocalSttModelSpec(modelId);
    const directory = getLocalSttModelDir(modelsDir, modelId);
    const modelConfig = spec.type === 'whisper'
      ? {
          whisper: {
            encoder: required(path.join(directory, spec.files.encoder), 'Whisper encoder'),
            decoder: required(path.join(directory, spec.files.decoder), 'Whisper decoder'),
            language: typeof language === 'string' ? language : '',
            task: 'transcribe',
            tailPaddings: -1,
          },
          tokens: required(path.join(directory, spec.files.tokens), 'tokens'),
          modelType: 'whisper', numThreads, provider: 'cpu', debug: 0,
        }
      : {
          transducer: {
            encoder: required(path.join(directory, spec.files.encoder), 'Parakeet encoder'),
            decoder: required(path.join(directory, spec.files.decoder), 'Parakeet decoder'),
            joiner: required(path.join(directory, spec.files.joiner), 'Parakeet joiner'),
          },
          tokens: required(path.join(directory, spec.files.tokens), 'tokens'),
          modelType: 'nemo_transducer', numThreads, provider: 'cpu', debug: 0,
        };
    const sherpa = loadSherpaOnnxNode();
    this.recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: PCM_SAMPLE_RATE, featureDim: 80 },
      modelConfig,
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
    });
  }

  transcribe(pcm16, sampleRate) {
    if (sampleRate !== PCM_SAMPLE_RATE) throw new Error(`Unsupported STT sample rate: ${sampleRate}`);
    if (!pcm16.byteLength) return '';
    const peak = pcm16Peak(pcm16);
    const gain = peak > 0 && peak < 19_660 ? Math.min(50, 19_660 / peak) : 1;
    const stream = this.recognizer.createStream();
    try {
      const samples = pcm16ToFloat32(pcm16, gain);
      if (stream.acceptWaveform.length <= 1) stream.acceptWaveform({ samples, sampleRate });
      else stream.acceptWaveform(sampleRate, samples);
      this.recognizer.decode(stream);
      const result = this.recognizer.getResult(stream);
      return String(result && typeof result === 'object' ? result.text ?? '' : result ?? '').trim();
    } finally { stream.free?.(); }
  }

  free() { this.recognizer?.free?.(); }
}
