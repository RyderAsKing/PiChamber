import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

const SOCKET_OPEN = 1;
const MAX_AUDIO_BYTES = 5 * 60 * 16_000 * 2;

type ConnectionState = 'recording' | 'reconnecting' | 'transcribing';

const audioFrame = (sequence: number, pcm16: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(4 + pcm16.byteLength);
  new DataView(frame.buffer).setUint32(0, sequence, true);
  frame.set(pcm16, 4);
  return frame;
};

const id = (): string => typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `${Date.now()}-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`;

export class DictationClient {
  private readonly recordingId = id();
  private socket: RelayTunnelWebSocket | null = null;
  private socketStarted = false;
  private chunks: Uint8Array[] = [];
  private audioBytes = 0;
  private finishing = false;
  private cancelled = false;
  private failures = 0;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private finishPromise: Promise<string> | null = null;
  private resolveFinish: ((text: string) => void) | null = null;
  private rejectFinish: ((error: Error) => void) | null = null;

  constructor(
    private readonly providerConfigId: string,
    private readonly onState: (state: ConnectionState) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  begin(): void { void this.connect(); }

  append(chunk: Uint8Array): void {
    if (this.cancelled || this.finishing || !chunk.byteLength) return;
    if (this.audioBytes + chunk.byteLength > MAX_AUDIO_BYTES) {
      this.fail(new Error('Recording reached the five minute limit'));
      return;
    }
    const retained = chunk.slice();
    const sequence = this.chunks.length;
    this.chunks.push(retained);
    this.audioBytes += retained.byteLength;
    if (this.socketStarted && this.socket?.readyState === SOCKET_OPEN) this.socket.send(audioFrame(sequence, retained));
  }

  finish(): Promise<string> {
    if (this.finishPromise) return this.finishPromise;
    this.finishing = true;
    this.onState('transcribing');
    this.finishPromise = new Promise<string>((resolve, reject) => {
      this.resolveFinish = resolve;
      this.rejectFinish = reject;
    });
    if (this.socketStarted) this.sendFinish();
    else void this.connect();
    return this.finishPromise;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.generation += 1;
    if (this.socket?.readyState === SOCKET_OPEN && this.socketStarted) {
      this.socket.send(JSON.stringify({ version: 1, type: 'cancel', recordingId: this.recordingId }));
    }
    this.closeSocket();
    this.clearAudio();
    this.rejectFinish?.(new Error('Dictation cancelled'));
    this.rejectFinish = null;
    this.resolveFinish = null;
  }

  private async connect(): Promise<void> {
    if (this.cancelled || this.socket || this.reconnectTimer) return;
    const generation = ++this.generation;
    if (this.failures > 0) this.onState(this.finishing ? 'transcribing' : 'reconnecting');
    try {
      const urlAuthToken = await refreshRuntimeUrlAuthToken();
      if (this.cancelled || generation !== this.generation) return;
      const socket = openRuntimeWebSocket(getRuntimeUrlResolver().websocket('/api/stt/ws', undefined, urlAuthToken));
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      let opened = false;
      socket.onopen = () => {
        opened = true;
        if (this.socket !== socket || this.cancelled) return;
        socket.send(JSON.stringify({ version: 1, type: 'start', recordingId: this.recordingId, providerConfigId: this.providerConfigId }));
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string' || this.socket !== socket) return;
        let message: { type?: string; recordingId?: string; ackSequence?: number; text?: string; message?: string; code?: string };
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.recordingId && message.recordingId !== this.recordingId) return;
        if (message.type === 'started') {
          this.failures = 0;
          this.socketStarted = true;
          const acknowledged = Number.isInteger(message.ackSequence) ? message.ackSequence! : -1;
          for (let sequence = acknowledged + 1; sequence < this.chunks.length; sequence += 1) socket.send(audioFrame(sequence, this.chunks[sequence]));
          if (this.finishing) this.sendFinish();
          else this.onState('recording');
        } else if (message.type === 'transcribing') {
          this.onState('transcribing');
        } else if (message.type === 'final') {
          const text = String(message.text ?? '').trim();
          this.resolveFinish?.(text);
          this.resolveFinish = null;
          this.rejectFinish = null;
          this.clearAudio();
          this.cancelled = true;
          this.closeSocket();
        } else if (message.type === 'error') {
          this.fail(Object.assign(new Error(message.message || 'Transcription failed'), { code: message.code }));
        }
      };
      socket.onerror = () => {};
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.socketStarted = false;
        if (!opened) clearRuntimeUrlAuthToken(urlAuthToken);
        if (!this.cancelled) this.scheduleReconnect();
      };
    } catch (error) {
      if (!this.cancelled && generation === this.generation) {
        this.socket = null;
        this.scheduleReconnect(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private sendFinish(): void {
    if (!this.socketStarted || this.socket?.readyState !== SOCKET_OPEN) return;
    this.socket.send(JSON.stringify({ version: 1, type: 'finish', recordingId: this.recordingId, finalSequence: this.chunks.length - 1 }));
  }

  private scheduleReconnect(lastError?: Error): void {
    this.failures += 1;
    this.onState(this.finishing ? 'transcribing' : 'reconnecting');
    const hiddenOrOffline = typeof document !== 'undefined' && (document.visibilityState === 'hidden' || navigator.onLine === false);
    const delay = hiddenOrOffline ? 30_000 : Math.min(10_000, 300 * 2 ** Math.min(this.failures, 5));
    if (this.failures >= 8) {
      this.fail(lastError ?? new Error('Could not reconnect to the transcription server'));
      return;
    }
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
  }

  private fail(error: Error): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.onError(error);
    this.rejectFinish?.(error);
    this.resolveFinish = null;
    this.rejectFinish = null;
    this.closeSocket();
    this.clearAudio();
  }

  private closeSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.socketStarted = false;
    if (socket) { socket.onclose = null; socket.onmessage = null; try { socket.close(); } catch { /* already closed */ } }
  }

  private clearAudio(): void { this.chunks = []; this.audioBytes = 0; }
}
