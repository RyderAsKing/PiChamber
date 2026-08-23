import path from 'node:path';

export const LOCAL_STT_MODEL_CATALOG = Object.freeze({
  'parakeet-tdt-0.6b-v2-int8': {
    type: 'nemo_transducer',
    description: 'NVIDIA Parakeet TDT v2, English',
    sizeBytes: 482_468_385,
    sha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
    archiveUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
  },
  'parakeet-tdt-0.6b-v3-int8': {
    type: 'nemo_transducer',
    description: 'NVIDIA Parakeet TDT v3, multilingual',
    sizeBytes: 487_170_055,
    sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
    archiveUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
  },
  'whisper-base-int8': {
    type: 'whisper',
    description: 'OpenAI Whisper base, multilingual',
    sizeBytes: 207_557_382,
    sha256: '911b2083efd7c0dca2ac3b358b75222660dc09fb716d64fbfc417ba6c99ff3de',
    archiveUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-base',
    files: { encoder: 'base-encoder.int8.onnx', decoder: 'base-decoder.int8.onnx', tokens: 'base-tokens.txt' },
  },
  'whisper-tiny-int8': {
    type: 'whisper',
    description: 'OpenAI Whisper tiny, multilingual',
    sizeBytes: 116_204_861,
    sha256: 'c46116994e539aa165266d96b325252728429c12535eb9d8b6a2b10f129e66b1',
    archiveUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-tiny',
    files: { encoder: 'tiny-encoder.int8.onnx', decoder: 'tiny-decoder.int8.onnx', tokens: 'tiny-tokens.txt' },
  },
});

export const LOCAL_STT_MODEL_IDS = Object.freeze(Object.keys(LOCAL_STT_MODEL_CATALOG));
export const DEFAULT_LOCAL_STT_MODEL = 'parakeet-tdt-0.6b-v2-int8';

export function isLocalSttModelId(value) {
  return typeof value === 'string' && Object.hasOwn(LOCAL_STT_MODEL_CATALOG, value);
}

export function getLocalSttModelSpec(modelId) {
  if (!isLocalSttModelId(modelId)) throw new Error('Unknown STT model');
  const spec = LOCAL_STT_MODEL_CATALOG[modelId];
  return { id: modelId, ...spec, requiredFiles: Object.values(spec.files) };
}

export function getLocalSttModelDir(modelsDir, modelId) {
  return path.join(modelsDir, getLocalSttModelSpec(modelId).extractedDir);
}
