import { DICTATION_AUDIO_WORKLET_SOURCE } from './audio-worklet';

const OUTPUT_RATE = 16_000;
const CHUNK_SAMPLES = 4_000;

type LevelListener = (level: number) => void;
type AudioContextConstructor = typeof AudioContext;

interface CaptureOptions {
  onChunk: (chunk: Uint8Array) => void;
  onPermissionGranted?: () => void;
}

const contextConstructor = (): AudioContextConstructor | null => {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as typeof window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext ?? null;
};

const disconnect = (node: AudioNode | null): void => { try { node?.disconnect(); } catch { /* already disconnected */ } };

export class DictationAudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | ScriptProcessorNode | null = null;
  private gain: GainNode | null = null;
  private listeners = new Set<LevelListener>();
  private pendingFallback: number[] = [];
  private fallbackPosition = 0;
  private fallbackCarry: number[] = [];
  private flushed: (() => void) | null = null;
  private cancelled = false;

  constructor(private readonly options: CaptureOptions) {}

  subscribeLevel(listener: LevelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private level(value: number): void { for (const listener of this.listeners) listener(value); }
  private chunk(samples: Int16Array): void {
    if (!samples.length) return;
    this.options.onChunk(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength).slice());
  }

  async start(): Promise<void> {
    if (this.stream) return;
    const Context = contextConstructor();
    if (!Context || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone recording is not supported');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (this.cancelled) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Dictation cancelled');
    }
    this.stream = stream;
    this.options.onPermissionGranted?.();
    const context = new Context();
    this.context = context;
    if (context.state === 'suspended') await context.resume();
    this.source = context.createMediaStreamSource(stream);
    this.gain = context.createGain();
    this.gain.gain.value = 0;

    let worklet: AudioWorkletNode | null = null;
    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      const url = URL.createObjectURL(new Blob([DICTATION_AUDIO_WORKLET_SOURCE], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(url);
        worklet = new AudioWorkletNode(context, 'pichamber-dictation', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      } catch { worklet = null; }
      finally { URL.revokeObjectURL(url); }
    }
    if (worklet) {
      worklet.port.onmessage = (event: MessageEvent<{ type: string; value?: number; buffer?: ArrayBuffer }>) => {
        if (event.data.type === 'level') this.level(event.data.value ?? 0);
        else if (event.data.type === 'chunk' && event.data.buffer) this.chunk(new Int16Array(event.data.buffer));
        else if (event.data.type === 'flushed') { this.flushed?.(); this.flushed = null; }
      };
      this.processor = worklet;
    } else {
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => this.processFallback(event.inputBuffer.getChannelData(0), context.sampleRate);
      this.processor = processor;
    }
    this.source.connect(this.processor);
    this.processor.connect(this.gain);
    this.gain.connect(context.destination);
  }

  private processFallback(input: Float32Array, inputRate: number): void {
    let sum = 0;
    for (const sample of input) sum += sample * sample;
    this.level(Math.min(1, Math.sqrt(sum / Math.max(1, input.length)) * 3));
    const source = this.fallbackCarry.concat(Array.from(input));
    const step = inputRate / OUTPUT_RATE;
    while (this.fallbackPosition + 1 < source.length) {
      const index = Math.floor(this.fallbackPosition);
      const fraction = this.fallbackPosition - index;
      const sample = source[index] + (source[index + 1] - source[index]) * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.pendingFallback.push(clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767));
      this.fallbackPosition += step;
    }
    const consumed = Math.floor(this.fallbackPosition);
    this.fallbackCarry = source.slice(consumed);
    this.fallbackPosition -= consumed;
    while (this.pendingFallback.length >= CHUNK_SAMPLES) this.chunk(Int16Array.from(this.pendingFallback.splice(0, CHUNK_SAMPLES)));
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    const processor = this.processor;
    if (typeof AudioWorkletNode !== 'undefined' && processor instanceof AudioWorkletNode) {
      await Promise.race([
        new Promise<void>((resolve) => { this.flushed = resolve; processor.port.postMessage({ type: 'flush' }); }),
        new Promise<void>((resolve) => window.setTimeout(resolve, 100)),
      ]);
    } else if (this.pendingFallback.length) {
      this.chunk(Int16Array.from(this.pendingFallback.splice(0)));
    }
    if (typeof ScriptProcessorNode !== 'undefined' && processor instanceof ScriptProcessorNode) processor.onaudioprocess = null;
    disconnect(this.source); disconnect(processor); disconnect(this.gain);
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close().catch(() => {});
    this.level(0);
    this.stream = null; this.context = null; this.source = null; this.processor = null; this.gain = null;
    this.pendingFallback = []; this.fallbackCarry = []; this.fallbackPosition = 0; this.flushed = null;
  }
}

export const isDictationCaptureSupported = (): boolean => Boolean(contextConstructor() && navigator.mediaDevices?.getUserMedia);
