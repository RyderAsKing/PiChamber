import { PCM_BYTES_PER_SECOND, PCM_SAMPLE_RATE, pcm16Peak } from './audio.js';

const MAX_RECORDING_BYTES = 5 * 60 * PCM_BYTES_PER_SECOND;
const SEGMENT_MIN_BYTES = 60 * PCM_BYTES_PER_SECOND;
const SEGMENT_MAX_BYTES = 90 * PCM_BYTES_PER_SECOND;
const SILENCE_PEAK = 300;
const RECONNECT_GRACE_MS = 30_000;
const FINAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_STREAMS = 8;
const MAX_REORDERED_CHUNKS = 64;

const send = (state, message) => {
  try { state.emit?.({ version: 1, recordingId: state.id, ...message }); } catch {}
};

export class SttStreamManager {
  constructor({ createTranscriber }) {
    this.createTranscriber = createTranscriber;
    this.streams = new Map();
    this.pendingStarts = new Map();
  }

  async start({ recordingId, providerConfigId, emit }) {
    if (typeof recordingId !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(recordingId)) throw new Error('Invalid recording id');
    const existing = this.streams.get(recordingId);
    if (existing) {
      clearTimeout(existing.detachTimer);
      existing.detachTimer = null;
      existing.emit = emit;
      send(existing, existing.completed
        ? { type: 'final', text: existing.finalText }
        : { type: 'started', ackSequence: existing.nextSequence - 1, maxDurationSeconds: 300 });
      return existing;
    }
    const pendingStart = this.pendingStarts.get(recordingId);
    if (pendingStart) {
      await pendingStart;
      return this.start({ recordingId, providerConfigId, emit });
    }
    if (this.streams.size + this.pendingStarts.size >= MAX_STREAMS) throw Object.assign(new Error('The STT server is busy'), { code: 'STT_BUSY' });
    const creating = this.createTranscriber(providerConfigId);
    this.pendingStarts.set(recordingId, creating);
    let transcriber;
    try { transcriber = await creating; }
    finally { this.pendingStarts.delete(recordingId); }
    const state = {
      id: recordingId,
      providerConfigId: providerConfigId || null,
      transcriber,
      emit,
      received: new Map(),
      nextSequence: 0,
      audioBytes: 0,
      segmentChunks: [],
      segmentBytes: 0,
      segmentPeak: 0,
      jobs: [],
      finishing: false,
      finalSequence: null,
      completed: false,
      finalText: '',
      detachTimer: null,
      finalTimer: null,
    };
    this.streams.set(recordingId, state);
    send(state, { type: 'started', ackSequence: -1, maxDurationSeconds: 300 });
    return state;
  }

  append(recordingId, sequence, pcm16) {
    const state = this.streams.get(recordingId);
    if (!state || state.completed) throw new Error('STT recording was not started');
    if (state.finishing) throw new Error('STT recording is already finishing');
    if (!Number.isInteger(sequence) || sequence < 0) throw new Error('Invalid STT audio sequence');
    if (sequence < state.nextSequence) {
      send(state, { type: 'ack', ackSequence: state.nextSequence - 1 });
      return;
    }
    if (state.received.has(sequence)) return;
    if (state.received.size >= MAX_REORDERED_CHUNKS) throw new Error('Too many out-of-order STT chunks');
    if (state.audioBytes + pcm16.byteLength > MAX_RECORDING_BYTES) {
      throw Object.assign(new Error('Recording reached the five minute limit'), { code: 'RECORDING_LIMIT' });
    }
    state.audioBytes += pcm16.byteLength;
    state.received.set(sequence, Buffer.from(pcm16));
    while (state.received.has(state.nextSequence)) {
      const chunk = state.received.get(state.nextSequence);
      state.received.delete(state.nextSequence);
      state.nextSequence += 1;
      state.segmentChunks.push(chunk);
      state.segmentBytes += chunk.byteLength;
      const peak = pcm16Peak(chunk);
      state.segmentPeak = Math.max(state.segmentPeak, peak);
      if (state.segmentBytes >= SEGMENT_MAX_BYTES || (state.segmentBytes >= SEGMENT_MIN_BYTES && peak < SILENCE_PEAK)) {
        this.commitSegment(state);
      }
    }
    send(state, { type: 'ack', ackSequence: state.nextSequence - 1 });
  }

  commitSegment(state) {
    const chunks = state.segmentChunks;
    const bytes = state.segmentBytes;
    const peak = state.segmentPeak;
    state.segmentChunks = [];
    state.segmentBytes = 0;
    state.segmentPeak = 0;
    if (!bytes || peak < SILENCE_PEAK) return;
    const pcm16 = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, bytes);
    const previous = state.jobs.at(-1)?.promise ?? Promise.resolve();
    const job = { promise: null };
    job.promise = previous.then(() => {
      if (!this.streams.has(state.id)) return { text: '' };
      return state.transcriber.transcribe(pcm16, PCM_SAMPLE_RATE);
    });
    state.jobs.push(job);
  }

  finish(recordingId, finalSequence) {
    const state = this.streams.get(recordingId);
    if (!state || state.completed) throw new Error('STT recording was not started');
    if (!Number.isInteger(finalSequence) || finalSequence < -1) throw new Error('Invalid final STT sequence');
    if (state.nextSequence - 1 < finalSequence) {
      send(state, { type: 'ack', ackSequence: state.nextSequence - 1 });
      return false;
    }
    if (state.finishing) return true;
    state.finishing = true;
    state.finalSequence = finalSequence;
    this.commitSegment(state);
    send(state, { type: 'transcribing' });
    state.finalTimer = setTimeout(() => this.fail(state, new Error('Transcription timed out'), 'TRANSCRIPTION_TIMEOUT'), FINAL_TIMEOUT_MS);
    state.finalTimer.unref?.();
    void Promise.all(state.jobs.map((job) => job.promise)).then((results) => {
      if (!this.streams.has(state.id)) return;
      const text = results.map((result) => String(result?.text ?? '').trim()).filter(Boolean).join(' ').trim();
      if (!text) {
        this.fail(state, new Error('No speech was detected'), 'EMPTY_AUDIO');
        return;
      }
      clearTimeout(state.finalTimer);
      state.completed = true;
      state.finalText = text;
      state.transcriber.close?.();
      send(state, { type: 'final', text });
      this.scheduleRemoval(state);
    }).catch((error) => this.fail(state, error, error?.code || 'TRANSCRIPTION_FAILED'));
    return true;
  }

  cancel(recordingId) {
    const state = this.streams.get(recordingId);
    if (state) this.remove(state);
  }

  detach(recordingId, emit) {
    const state = this.streams.get(recordingId);
    if (!state || state.emit !== emit) return;
    state.emit = null;
    this.scheduleRemoval(state);
  }

  scheduleRemoval(state) {
    clearTimeout(state.detachTimer);
    state.detachTimer = setTimeout(() => this.remove(state), RECONNECT_GRACE_MS);
    state.detachTimer.unref?.();
  }

  fail(state, error, code) {
    if (!this.streams.has(state.id)) return;
    send(state, { type: 'error', code, message: error?.message || 'Transcription failed' });
    this.remove(state);
  }

  remove(state) {
    if (this.streams.get(state.id) !== state) return;
    this.streams.delete(state.id);
    clearTimeout(state.detachTimer);
    clearTimeout(state.finalTimer);
    state.received.clear();
    state.segmentChunks.length = 0;
    try { state.transcriber.close?.(); } catch {}
  }

  shutdown() {
    for (const state of this.streams.values()) this.remove(state);
  }
}
