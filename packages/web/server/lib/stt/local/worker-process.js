import { SherpaRecognizer } from './recognizer.js';

process.title = 'PiChamber STT Worker';

const MAX_ENGINES = 2;
const engines = new Map();
let work = Promise.resolve();
let closing = false;

const send = (message) => {
  if (closing || !process.connected || !process.send) return;
  try { process.send(message, (error) => { if (error) closing = true; }); }
  catch { closing = true; }
};

const toBuffer = (value) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Invalid PCM16 worker payload');
};

function engineFor(message) {
  const language = typeof message.language === 'string' ? message.language.trim().toLowerCase() : '';
  const key = `${message.modelsDir}\u0000${message.modelId}\u0000${language}`;
  const existing = engines.get(key);
  if (existing) {
    engines.delete(key);
    engines.set(key, existing);
    return { engine: existing, modelLoadMs: 0 };
  }
  const loadStartedAt = performance.now();
  const engine = new SherpaRecognizer({ modelsDir: message.modelsDir, modelId: message.modelId, language });
  engines.set(key, engine);
  while (engines.size > MAX_ENGINES) {
    const oldestKey = engines.keys().next().value;
    const oldest = engines.get(oldestKey);
    engines.delete(oldestKey);
    oldest?.free();
  }
  return { engine, modelLoadMs: Math.round(performance.now() - loadStartedAt) };
}

async function handle(message) {
  if (message?.type !== 'transcribe') throw new Error('Unknown STT worker request');
  const loaded = engineFor(message);
  const startedAt = performance.now();
  const text = loaded.engine.transcribe(toBuffer(message.pcm16), message.sampleRate);
  return { text, modelLoadMs: loaded.modelLoadMs, inferenceMs: Math.round(performance.now() - startedAt), rssBytes: process.memoryUsage().rss };
}

process.on('message', (message) => {
  work = work.then(async () => {
    try { send({ type: 'response', requestId: message?.requestId, ok: true, result: await handle(message) }); }
    catch (error) { send({ type: 'response', requestId: message?.requestId, ok: false, error: error?.message || 'STT inference failed' }); }
  });
});

process.once('disconnect', () => {
  closing = true;
  void work.finally(() => {
    for (const engine of engines.values()) engine.free();
    process.exit(0);
  });
});
