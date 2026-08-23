import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { applySherpaLoaderEnv } from './sherpa-loader.js';

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export class SttWorkerClient {
  constructor({ idleShutdownMs = IDLE_SHUTDOWN_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.idleShutdownMs = idleShutdownMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.worker = null;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.idleTimer = null;
    this.stderrTail = '';
    this.intentional = new WeakSet();
  }

  transcribe(input) {
    const operation = this.queue.catch(() => {}).then(() => this.request({ type: 'transcribe', ...input }));
    this.queue = operation;
    return operation;
  }

  request(message) {
    const worker = this.ensureWorker();
    const requestId = randomUUID();
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('STT worker timed out'));
        this.scheduleIdleShutdown();
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });
      worker.send({ ...message, requestId }, (error) => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        pending.reject(error);
        this.scheduleIdleShutdown();
      });
    });
  }

  ensureWorker() {
    if (this.worker?.connected && !this.worker.killed) return this.worker;
    const env = { ...process.env };
    applySherpaLoaderEnv(env);
    const worker = fork(fileURLToPath(new URL('./worker-process.js', import.meta.url)), [], {
      env,
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.worker = worker;
    this.stderrTail = '';
    worker.stderr?.on('data', (chunk) => { this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000); });
    worker.on('message', (message) => this.handleMessage(message));
    worker.on('close', (code, signal) => this.handleExit(worker, code, signal));
    return worker;
  }

  handleMessage(message) {
    if (message?.type !== 'response') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || 'STT worker failed'));
    this.scheduleIdleShutdown();
  }

  handleExit(worker, code, signal) {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.intentional.has(worker)) return;
    const detail = this.stderrTail.trim().slice(-500);
    const error = new Error(`STT worker exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${detail ? `: ${detail}` : ''}`);
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
  }

  scheduleIdleShutdown() {
    if (this.pending.size || !this.worker) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.pending.size) this.shutdownWorker(); }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  shutdownWorker() {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    this.intentional.add(worker);
    try { worker.disconnect(); } catch {}
    const timer = setTimeout(() => { try { worker.kill(); } catch {} }, 1000);
    timer.unref?.();
  }

  shutdown() {
    clearTimeout(this.idleTimer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error('STT worker shut down')); }
    this.pending.clear();
    this.shutdownWorker();
  }
}
