import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  buildProcessPerformanceSample,
  createProcessPerformanceRecorder,
} from './process-performance-recorder.mjs';

test('buildProcessPerformanceSample reports process memory in bytes without sensitive fields', () => {
  const sample = buildProcessPerformanceSample({
    recordedAt: '2026-01-02T03:04:05.000Z',
    elapsedMs: 1250,
    appMetadata: { version: '1.2.3', platform: 'win32', arch: 'x64', packaged: true },
    processMetrics: [{
      pid: 42,
      type: 'Tab',
      cpu: { percentCPUUsage: 7.5, idleWakeupsPerSecond: 2 },
      memory: { workingSetSize: 100, peakWorkingSetSize: 150, privateBytes: 80 },
      serviceName: 'must-not-be-recorded',
    }],
    mainMemory: {
      rss: 5000,
      heapTotal: 4000,
      heapUsed: 3000,
      external: 2000,
      arrayBuffers: 1000,
    },
    webContentsCount: 3,
  });

  assert.equal(sample.totalWorkingSetBytes, 100 * 1024);
  assert.deepEqual(sample.processes[0], {
    pid: 42,
    type: 'Tab',
    cpu: { percent: 7.5, idleWakeupsPerSecond: 2 },
    memory: {
      workingSetBytes: 100 * 1024,
      peakWorkingSetBytes: 150 * 1024,
      privateBytes: 80 * 1024,
    },
  });
  assert.deepEqual(sample.mainMemory, {
    rssBytes: 5000,
    heapTotalBytes: 4000,
    heapUsedBytes: 3000,
    externalBytes: 2000,
    arrayBuffersBytes: 1000,
  });
  assert.equal(JSON.stringify(sample).includes('must-not-be-recorded'), false);

  const unavailableMemory = buildProcessPerformanceSample({
    recordedAt: '2026-01-02T03:04:05.000Z',
    elapsedMs: 0,
    appMetadata: {},
    processMetrics: [{ pid: 43, type: 'GPU' }],
    mainMemory: {},
    webContentsCount: 0,
  });
  assert.equal(unavailableMemory.totalWorkingSetBytes, null);
});

test('process performance recorder starts, samples immediately, and stops cleanly', async () => {
  const writes = [];
  let ended = false;
  let scheduledCapture = null;
  let clearedTimer = null;
  const stream = new EventEmitter();
  stream.write = (value) => { writes.push(value); };
  stream.end = () => { ended = true; };
  stream.destroy = () => {};
  const timer = { unref() {} };

  const recorder = createProcessPerformanceRecorder({
    outputDirectory: '/tmp/pichamber-performance-test',
    appMetadata: { version: '1.2.3', platform: 'win32', arch: 'x64', packaged: true },
    getProcessMetrics: () => [],
    getMainMemoryUsage: () => ({ rss: 1 }),
    getWebContentsCount: () => 1,
    logger: { info() {}, error() {} },
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    monotonicNow: () => 10,
    makeDirectory() {},
    createWriteStream: () => {
      queueMicrotask(() => stream.emit('open'));
      return stream;
    },
    setIntervalFn: (capture) => {
      scheduledCapture = capture;
      return timer;
    },
    clearIntervalFn: (value) => { clearedTimer = value; },
  });

  const status = await recorder.start();
  assert.equal(status.active, true);
  assert.match(status.outputPath, /process-performance-2026-01-02T03-04-05-000Z\.ndjson$/);
  assert.equal(writes.length, 1);

  scheduledCapture();
  assert.equal(writes.length, 2);

  recorder.stop();
  assert.equal(recorder.isActive(), false);
  assert.equal(clearedTimer, timer);
  assert.equal(ended, true);
});

test('process performance recorder closes its stream after a later write failure', async () => {
  let destroyed = false;
  let clearedTimer = null;
  const stream = new EventEmitter();
  stream.write = () => {};
  stream.end = () => {};
  stream.destroy = () => { destroyed = true; };
  const timer = { unref() {} };

  const recorder = createProcessPerformanceRecorder({
    outputDirectory: '/tmp/pichamber-performance-test',
    appMetadata: {},
    getProcessMetrics: () => [],
    getMainMemoryUsage: () => ({}),
    getWebContentsCount: () => 0,
    logger: { info() {}, error() {} },
    makeDirectory() {},
    createWriteStream: () => {
      queueMicrotask(() => stream.emit('open'));
      return stream;
    },
    setIntervalFn: () => timer,
    clearIntervalFn: (value) => { clearedTimer = value; },
  });

  await recorder.start();
  stream.emit('error', new Error('disk full'));

  assert.equal(recorder.isActive(), false);
  assert.equal(destroyed, true);
  assert.equal(clearedTimer, timer);
});

test('process performance recorder stays inactive when the output file cannot open', async () => {
  const errors = [];
  const stream = new EventEmitter();
  stream.destroy = () => {};

  const recorder = createProcessPerformanceRecorder({
    outputDirectory: '/tmp/pichamber-performance-test',
    appMetadata: {},
    getProcessMetrics: () => [],
    getMainMemoryUsage: () => ({}),
    getWebContentsCount: () => 0,
    logger: { info() {}, error(...args) { errors.push(args); } },
    makeDirectory() {},
    createWriteStream: () => {
      queueMicrotask(() => stream.emit('error', new Error('disk full')));
      return stream;
    },
    setIntervalFn: () => {
      throw new Error('timer must not start');
    },
  });

  assert.deepEqual(await recorder.start(), { active: false, outputPath: null });
  assert.equal(recorder.isActive(), false);
  assert.equal(errors.length, 1);
});
