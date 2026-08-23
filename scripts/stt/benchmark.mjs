import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SttWorkerClient } from '../../packages/web/server/lib/stt/local/worker-client.js';
import { LOCAL_STT_MODEL_IDS } from '../../packages/web/server/lib/stt/local/model-catalog.js';

const durations = [5, 30, 90, 300];
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const fixturesDir = argument('--fixtures');
const modelsDir = argument('--models');
const output = argument('--output') || 'artifacts/stt-benchmark.json';
const runs = Math.max(1, Number.parseInt(argument('--runs') || '5', 10));
if (!fixturesDir || !modelsDir) {
  console.error('Usage: node scripts/stt/benchmark.mjs --fixtures <dir> --models <dir> [--runs 5] [--output file]');
  process.exit(2);
}

const percentile = (values, value) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * value) - 1)];
const median = (values) => percentile(values, 0.5);
const results = [];

for (const modelId of LOCAL_STT_MODEL_IDS) {
  for (const durationSeconds of durations) {
    const pcm16 = await readFile(path.join(fixturesDir, `${durationSeconds}.pcm`));
    const expectedBytes = durationSeconds * 16_000 * 2;
    if (pcm16.byteLength !== expectedBytes) throw new Error(`${durationSeconds}.pcm must contain exactly ${expectedBytes} bytes of 16 kHz mono PCM16LE`);
    const samples = [];
    const client = new SttWorkerClient({ idleShutdownMs: 60 * 60 * 1000 });
    try {
      for (let run = 0; run < runs; run += 1) {
        const startedAt = performance.now();
        const result = await client.transcribe({ pcm16, sampleRate: 16_000, modelsDir: path.resolve(modelsDir), modelId, language: '' });
        const finalizationMs = performance.now() - startedAt;
        samples.push({
          run,
          cold: run === 0,
          finalizationMs,
          modelLoadMs: result.modelLoadMs,
          inferenceMs: result.inferenceMs,
          workerStartupAndIpcMs: Math.max(0, finalizationMs - result.modelLoadMs - result.inferenceMs),
          rssBytes: result.rssBytes,
          textLength: result.text.length,
        });
      }
    } finally { client.shutdown(); }
    const warm = samples.slice(1).length ? samples.slice(1) : samples;
    results.push({
      modelId,
      durationSeconds,
      runs: samples,
      warm: {
        medianFinalizationMs: median(warm.map((sample) => sample.finalizationMs)),
        p95FinalizationMs: percentile(warm.map((sample) => sample.finalizationMs), 0.95),
        medianRealTimeFactor: median(warm.map((sample) => sample.inferenceMs / (durationSeconds * 1000))),
        p95RealTimeFactor: percentile(warm.map((sample) => sample.inferenceMs / (durationSeconds * 1000)), 0.95),
        maxRssBytes: Math.max(...warm.map((sample) => sample.rssBytes)),
      },
    });
    console.log(`${modelId} ${durationSeconds}s: median ${Math.round(results.at(-1).warm.medianFinalizationMs)} ms, RTF ${results.at(-1).warm.medianRealTimeFactor.toFixed(3)}`);
  }
}

await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), runs, results }, null, 2)}\n`);
console.log(`Wrote ${output}`);
