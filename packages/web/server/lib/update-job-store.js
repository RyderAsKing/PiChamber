import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePiChamberDataDir } from './pichamber-data-dir.js';
import { withCrossProcessLock } from './server/cross-process-lock.js';

const UPDATE_JOB_STATES = new Set(['queued', 'installing', 'verifying', 'restarting', 'complete', 'failed']);
const ACTIVE_UPDATE_STATES = new Set(['queued', 'installing', 'verifying', 'restarting']);
const UPDATE_JOB_MAX_AGE_MS = 30 * 60 * 1000;
const UPDATE_JOB_STARTUP_GRACE_MS = 30 * 1000;
const UPDATE_JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UPDATE_CHANNELS = new Set(['stable', 'rc']);

const invalidJobError = () => {
  const error = new Error('Update status is invalid.');
  error.code = 'UPDATE_JOB_INVALID';
  return error;
};

const normalizeError = (value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 2000) : undefined;
};

const isValidJob = (job) => (
  job
  && typeof job === 'object'
  && !Array.isArray(job)
  && UPDATE_JOB_ID_PATTERN.test(job.id)
  && UPDATE_JOB_STATES.has(job.state)
  && Number.isFinite(job.startedAt)
  && Number.isFinite(job.updatedAt)
  && (job.channel === undefined || UPDATE_CHANNELS.has(job.channel))
);

export const createUpdateJobStore = ({
  file = join(resolvePiChamberDataDir(), 'run', 'update-job.json'),
  now = () => Date.now(),
  createId = randomUUID,
  maxAgeMs = UPDATE_JOB_MAX_AGE_MS,
  startupGraceMs = UPDATE_JOB_STARTUP_GRACE_MS,
  processLike = process,
} = {}) => {
  const lockFile = `${file}.lock`;

  const readFileValue = async () => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (!isValidJob(parsed)) throw invalidJobError();
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code === 'UPDATE_JOB_INVALID') throw error;
      throw invalidJobError();
    }
  };

  const writeFileValue = async (job) => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
    await rename(temporary, file);
    return job;
  };

  const reconcileActiveJob = async (job, timestamp) => {
    if (!job || !ACTIVE_UPDATE_STATES.has(job.state)) return job;

    const age = timestamp - job.updatedAt;
    if (!Number.isInteger(job.workerPid) || job.workerPid <= 0) {
      const graceMs = job.state === 'queued' ? Math.min(startupGraceMs, maxAgeMs) : maxAgeMs;
      if (age >= 0 && age <= graceMs) return job;
      return writeFileValue({
        ...job,
        state: 'failed',
        updatedAt: timestamp,
        error: job.state === 'queued'
          ? 'The update worker did not start within the allowed time. Run: pichamber update'
          : 'The update worker stopped before recording its process ID. Run: pichamber update',
      });
    }

    try {
      processLike.kill(job.workerPid, 0);
      return job;
    } catch (error) {
      if (error?.code === 'EPERM') return job;
      return writeFileValue({
        ...job,
        state: 'failed',
        updatedAt: timestamp,
        error: 'The update worker exited before the update completed. Run: pichamber update',
      });
    }
  };

  const claim = async ({ previousVersion, targetVersion, packageManager, channel } = {}) => withCrossProcessLock(lockFile, async () => {
    let current = null;
    try {
      current = await readFileValue();
    } catch (error) {
      if (error?.code !== 'UPDATE_JOB_INVALID') throw error;
    }
    const timestamp = now();
    current = await reconcileActiveJob(current, timestamp);
    if (current && ACTIVE_UPDATE_STATES.has(current.state)) {
      return { job: current, created: false };
    }

    const job = {
      id: createId(),
      state: 'queued',
      previousVersion: typeof previousVersion === 'string' ? previousVersion : undefined,
      targetVersion: typeof targetVersion === 'string' ? targetVersion : undefined,
      packageManager: typeof packageManager === 'string' ? packageManager : undefined,
      channel: UPDATE_CHANNELS.has(channel) ? channel : 'stable',
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    await writeFileValue(job);
    return { job, created: true };
  });

  const update = async (id, changes = {}) => {
    if (!UPDATE_JOB_ID_PATTERN.test(id)) throw invalidJobError();
    return withCrossProcessLock(lockFile, async () => {
      const current = await readFileValue();
      if (!current || current.id !== id) {
        const error = new Error('Update job was not found.');
        error.code = 'UPDATE_JOB_NOT_FOUND';
        throw error;
      }
      if (changes.state !== undefined && !UPDATE_JOB_STATES.has(changes.state)) throw invalidJobError();
      if (!ACTIVE_UPDATE_STATES.has(current.state) && changes.state !== undefined && changes.state !== current.state) {
        const error = new Error('Update job is already in a terminal state.');
        error.code = 'UPDATE_JOB_NOT_ACTIVE';
        throw error;
      }
      if (changes.channel !== undefined && !UPDATE_CHANNELS.has(changes.channel)) throw invalidJobError();
      const next = { ...current, updatedAt: now() };
      for (const key of ['state', 'previousVersion', 'targetVersion', 'currentVersion', 'packageManager', 'channel']) {
        if (typeof changes[key] === 'string' && changes[key].length > 0) next[key] = changes[key];
      }
      if (Number.isInteger(changes.workerPid) && changes.workerPid > 0) next.workerPid = changes.workerPid;
      if (Object.hasOwn(changes, 'error')) {
        const error = normalizeError(changes.error);
        if (error) next.error = error;
        else delete next.error;
      }
      await writeFileValue(next);
      return next;
    });
  };

  const read = async (id) => {
    if (id !== undefined && !UPDATE_JOB_ID_PATTERN.test(id)) return null;
    return withCrossProcessLock(lockFile, async () => {
      const job = await readFileValue();
      if (!job || (id !== undefined && job.id !== id)) return null;
      return reconcileActiveJob(job, now());
    });
  };

  return { claim, read, update };
};

const defaultUpdateJobStore = createUpdateJobStore();

export const claimUpdateJob = (details) => defaultUpdateJobStore.claim(details);
export const readUpdateJob = (id) => defaultUpdateJobStore.read(id);
export const updateUpdateJob = (id, changes) => defaultUpdateJobStore.update(id, changes);
