import fs from 'node:fs';
import path from 'node:path';

const KIBIBYTE = 1024;
const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;

const finiteNumberOrNull = (value) => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const kibibytesToBytes = (value) => {
  const number = finiteNumberOrNull(value);
  return number === null ? null : Math.round(number * KIBIBYTE);
};

const sanitizeProcessMetric = (metric) => ({
  pid: finiteNumberOrNull(metric?.pid),
  type: typeof metric?.type === 'string' ? metric.type : 'unknown',
  cpu: {
    percent: finiteNumberOrNull(metric?.cpu?.percentCPUUsage),
    idleWakeupsPerSecond: finiteNumberOrNull(metric?.cpu?.idleWakeupsPerSecond),
  },
  memory: {
    workingSetBytes: kibibytesToBytes(metric?.memory?.workingSetSize),
    peakWorkingSetBytes: kibibytesToBytes(metric?.memory?.peakWorkingSetSize),
    privateBytes: kibibytesToBytes(metric?.memory?.privateBytes),
  },
});

const sanitizeMainMemory = (memory) => ({
  rssBytes: finiteNumberOrNull(memory?.rss),
  heapTotalBytes: finiteNumberOrNull(memory?.heapTotal),
  heapUsedBytes: finiteNumberOrNull(memory?.heapUsed),
  externalBytes: finiteNumberOrNull(memory?.external),
  arrayBuffersBytes: finiteNumberOrNull(memory?.arrayBuffers),
});

export const buildProcessPerformanceSample = ({
  recordedAt,
  elapsedMs,
  appMetadata,
  processMetrics,
  mainMemory,
  webContentsCount,
}) => {
  const processes = Array.isArray(processMetrics)
    ? processMetrics.map(sanitizeProcessMetric)
    : [];
  const measuredWorkingSets = processes
    .map((processMetric) => processMetric.memory.workingSetBytes)
    .filter((value) => value !== null);
  const totalWorkingSetBytes = measuredWorkingSets.length > 0
    ? measuredWorkingSets.reduce((total, value) => total + value, 0)
    : null;

  return {
    schemaVersion: 1,
    kind: 'process-performance-sample',
    recordedAt,
    elapsedMs: Math.max(0, finiteNumberOrNull(elapsedMs) ?? 0),
    app: {
      version: typeof appMetadata?.version === 'string' ? appMetadata.version : 'unknown',
      platform: typeof appMetadata?.platform === 'string' ? appMetadata.platform : 'unknown',
      arch: typeof appMetadata?.arch === 'string' ? appMetadata.arch : 'unknown',
      packaged: appMetadata?.packaged === true,
    },
    webContentsCount: Math.max(0, finiteNumberOrNull(webContentsCount) ?? 0),
    totalWorkingSetBytes,
    mainMemory: sanitizeMainMemory(mainMemory),
    processes,
  };
};

export const createProcessPerformanceRecorder = ({
  outputDirectory,
  appMetadata,
  getProcessMetrics,
  getMainMemoryUsage,
  getWebContentsCount,
  logger = console,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  createWriteStream = fs.createWriteStream,
  makeDirectory = fs.mkdirSync,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) => {
  let stream = null;
  let timer = null;
  let startedAt = 0;
  let outputPath = null;
  let active = false;

  const stopAfterError = (error) => {
    logger.error?.('[performance] process recorder stopped after a write failure', error);
    active = false;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    const failedStream = stream;
    stream = null;
    failedStream?.destroy();
  };

  const capture = () => {
    if (!active || !stream) return;
    try {
      const sample = buildProcessPerformanceSample({
        recordedAt: now().toISOString(),
        elapsedMs: monotonicNow() - startedAt,
        appMetadata,
        processMetrics: getProcessMetrics(),
        mainMemory: getMainMemoryUsage(),
        webContentsCount: getWebContentsCount(),
      });
      stream.write(`${JSON.stringify(sample)}\n`);
    } catch (error) {
      stopAfterError(error);
    }
  };

  const start = async () => {
    if (active) return { active: true, outputPath };

    try {
      makeDirectory(outputDirectory, { recursive: true, mode: 0o700 });
      const timestamp = now().toISOString().replace(/[:.]/g, '-');
      outputPath = path.join(outputDirectory, `process-performance-${timestamp}.ndjson`);
      stream = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
      await new Promise((resolve, reject) => {
        const handleOpenError = (error) => reject(error);
        stream.once('error', handleOpenError);
        stream.once('open', () => {
          stream.off('error', handleOpenError);
          resolve();
        });
      });
      stream.on('error', stopAfterError);
      startedAt = monotonicNow();
      active = true;
      capture();
      timer = setIntervalFn(capture, sampleIntervalMs);
      timer?.unref?.();
      logger.info?.(`[performance] recording Electron process metrics to ${outputPath}`);
      return { active: true, outputPath };
    } catch (error) {
      active = false;
      stream?.destroy();
      stream = null;
      outputPath = null;
      logger.error?.('[performance] failed to start process recorder', error);
      return { active: false, outputPath: null };
    }
  };

  const stop = () => {
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
    const currentStream = stream;
    stream = null;
    const wasActive = active;
    active = false;
    currentStream?.end();
    if (wasActive) logger.info?.('[performance] stopped recording Electron process metrics');
  };

  return {
    start,
    stop,
    isActive: () => active,
    getOutputPath: () => outputPath,
  };
};
