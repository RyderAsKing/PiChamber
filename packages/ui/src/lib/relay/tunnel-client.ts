// Relay tunnel client: Layer 1 wiring (relay WS, role=client), Layer 2 E2EE
// initiator, and Layer 3 mux (HTTP/SSE/WS streams) on the client side.
// One relay connection per client session carries all app traffic; a tunnel
// reconnect fails every open stream and the app's existing retry machinery
// (runtime-fetch retries, event-pipeline reconnect) recovers.
// Protocol: PiChamber private relay

import { createClientHandshake, type EstablishedChannelCrypto } from './handshake';
import {
  RELAY_PROTOCOL_VERSION,
  TunnelFrameType,
} from './protocol';
import {
  createFragmentAssembler,
  createOutboundFrameBatcher,
  createStreamIdAllocator,
  DEFAULT_BATCH_WINDOW_MS,
  decodeFrameBatch,
  decodeTunnelFrame,
  encodeTunnelFrame,
  type OutboundFrameBatcher,
  type TunnelFrame,
} from './tunnel-codec';
import type { ActiveChannel, ChannelWaiter, StreamHandler } from './tunnel-types';
import {
  type TunnelWireSocket,
  type RelayTunnelSocketMessageEvent,
  type RelayTunnelSocketCloseEvent,
  type RelayTunnelWebSocket,
  wrapNativeWebSocket,
  wrapBrowserWebSocket,
  TERMINAL_RELAY_CLOSE_CODES,
  RELAY_CLOSE_MESSAGES,
} from './wire-socket';
import { tunnelFetch, openTunnelWebSocket } from './tunnel-stream';

export type {
  TunnelWireSocket,
  RelayTunnelSocketMessageEvent,
  RelayTunnelSocketCloseEvent,
  RelayTunnelWebSocket,
};
export { wrapBrowserWebSocket };

const EMPTY_PAYLOAD = new Uint8Array(0);

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

export type RelayTunnelState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface RelayTunnelStatus {
  state: RelayTunnelState;
  lastError?: string;
}

export interface RelayTunnelClientOptions {
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: JsonWebKey;
  grant?: string;
  /** Test hook: replaces native WebSocket construction with a fake wire. */
  createWireSocket?: (url: string) => TunnelWireSocket;
  helloRetryMs?: number;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** Frame-batching flush window in ms (default 150). Only applies once negotiated. */
  batchWindowMs?: number;
  /** Advertise frame batching in the handshake. Default true. */
  batch?: boolean;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  hiddenOrOfflineMaxDelayMs?: number;
}

export interface RelayTunnelClient {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  openWebSocket(pathWithQuery: string, protocols?: string[]): RelayTunnelWebSocket;
  getStatus(): RelayTunnelStatus;
  subscribeStatus(listener: (status: RelayTunnelStatus) => void): () => void;
  close(): void;
}

const isOfflineOrHidden = (): boolean => {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  return offline || hidden;
};

export const createRelayTunnelClient = (options: RelayTunnelClientOptions): RelayTunnelClient => {
  const helloRetryMs = options.helloRetryMs ?? 1_000;
  const helloTimeoutMs = options.helloTimeoutMs ?? 30_000;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  // Pong wait after an idle keepalive ping — must be well under the interval so a
  // dead socket is caught within one cycle rather than after two.
  const pingTimeoutMs = options.pingTimeoutMs ?? 15_000;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const advertiseBatch = options.batch !== false;
  const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
  const hiddenOrOfflineMaxDelayMs = options.hiddenOrOfflineMaxDelayMs ?? 60_000;

  const createWire = options.createWireSocket ?? ((url: string) => wrapNativeWebSocket(new WebSocket(url)));

  let closed = false;
  let status: RelayTunnelStatus = { state: 'idle' };
  // Plain listener set — status must not fan out through shared stores.
  const statusListeners = new Set<(next: RelayTunnelStatus) => void>();
  let activeChannel: ActiveChannel | null = null;
  let currentWire: TunnelWireSocket | null = null;
  let currentAttemptCleanup: (() => void) | null = null;
  let attemptGeneration = 0;
  let consecutiveFailures = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let channelWaiters: ChannelWaiter[] = [];
  let wakeListenersInstalled = false;

  const setStatus = (next: RelayTunnelStatus): void => {
    if (status.state === next.state && status.lastError === next.lastError) return;
    status = next;
    for (const listener of statusListeners) {
      try {
        listener(status);
      } catch {
        // A listener throwing must not break the tunnel.
      }
    }
  };

  const rejectWaiters = (error: Error): void => {
    const waiters = channelWaiters;
    channelWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  };

  const resolveWaiters = (channel: ActiveChannel): void => {
    const waiters = channelWaiters;
    channelWaiters = [];
    for (const waiter of waiters) waiter.resolve(channel);
  };

  const failChannelStreams = (channel: ActiveChannel, error: Error): void => {
    channel.dead = true;
    const handlers = Array.from(channel.streams.values());
    channel.streams.clear();
    for (const handler of handlers) {
      try {
        handler.fail(error);
      } catch {
        // Stream teardown must not break the rest.
      }
    }
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const onWake = (): void => {
    if (closed || reconnectTimer === null || isOfflineOrHidden()) return;
    clearReconnectTimer();
    removeWakeListeners();
    void connect();
  };

  const onVisibilityWake = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible') onWake();
  };

  const installWakeListeners = (): void => {
    if (wakeListenersInstalled) return;
    wakeListenersInstalled = true;
    if (typeof window !== 'undefined') window.addEventListener('online', onWake);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityWake);
  };

  const removeWakeListeners = (): void => {
    if (!wakeListenersInstalled) return;
    wakeListenersInstalled = false;
    if (typeof window !== 'undefined') window.removeEventListener('online', onWake);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityWake);
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return;
    // Exponential backoff capped at reconnectMaxDelayMs; when offline or the
    // document is hidden, slow down further so a background tab doesn't burn cycles.
    const base = reconnectBaseDelayMs * Math.pow(1.5, Math.min(consecutiveFailures, 8));
    const jitter = Math.random() * 0.3 * base;
    const standardDelay = Math.min(reconnectMaxDelayMs, Math.round(base + jitter));
    const delay = isOfflineOrHidden()
      ? Math.max(standardDelay, hiddenOrOfflineMaxDelayMs)
      : standardDelay;

    installWakeListeners();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      removeWakeListeners();
      void connect();
    }, delay);
  };

  const buildRelayWsUrl = (): string => {
    const url = new URL(options.relayUrl);
    url.searchParams.set('v', String(RELAY_PROTOCOL_VERSION));
    url.searchParams.set('role', 'client');
    url.searchParams.set('serverId', options.serverId);
    if (options.grant) url.searchParams.set('grant', options.grant);
    return url.toString();
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    const generation = ++attemptGeneration;
    clearReconnectTimer();
    removeWakeListeners();

    currentAttemptCleanup?.();
    currentAttemptCleanup = null;

    setStatus({ state: consecutiveFailures === 0 ? 'connecting' : 'reconnecting' });

    let handshake;
    try {
      handshake = await createClientHandshake(options.hostEncPubJwk, {
        batch: advertiseBatch,
      });
    } catch (error) {
      failAttempt(generation, toError(error), true);
      return;
    }
    if (closed || generation !== attemptGeneration) return;

    let wire: TunnelWireSocket;
    try {
      wire = createWire(buildRelayWsUrl());
    } catch (error) {
      failAttempt(generation, toError(error));
      return;
    }
    currentWire = wire;

    let helloInterval: ReturnType<typeof setInterval> | null = null;
    let helloDeadline: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pongDeadline: ReturnType<typeof setTimeout> | null = null;
    let batcher: OutboundFrameBatcher | null = null;
    let settled = false;
    let channel: ActiveChannel | null = null;
    let cryptoChannel: EstablishedChannelCrypto | null = null;
    let lastActivityAt = Date.now();
    let batchNegotiated = false;
    let recvChain: Promise<void> = Promise.resolve();

    const cleanupAttempt = (): void => {
      if (helloInterval !== null) {
        clearInterval(helloInterval);
        helloInterval = null;
      }
      if (helloDeadline !== null) {
        clearTimeout(helloDeadline);
        helloDeadline = null;
      }
      if (pingTimer !== null) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (pongDeadline !== null) {
        clearTimeout(pongDeadline);
        pongDeadline = null;
      }
      batcher?.dispose();
      batcher = null;
    };
    currentAttemptCleanup = cleanupAttempt;

    const failAttemptLocal = (
      error: Error,
      failure: { terminal?: boolean; asErrorState?: boolean } = {},
    ): void => {
      const { terminal = false, asErrorState = false } = failure;
      if (settled || generation !== attemptGeneration) return;
      settled = true;
      cleanupAttempt();
      if (currentAttemptCleanup === cleanupAttempt) currentAttemptCleanup = null;
      if (channel) failChannelStreams(channel, error);
      if (activeChannel === channel) activeChannel = null;
      try {
        wire.close();
      } catch {
        // Wire close must not mask the underlying failure.
      }
      if (currentWire === wire) currentWire = null;
      if (terminal) {
        // Terminal errors: unblock any waiters with this error and do NOT reconnect.
        closed = true;
        rejectWaiters(error);
        setStatus({ state: 'error', lastError: error.message });
        return;
      }
      failAttempt(generation, error, asErrorState);
    };

    const sendHello = (): void => {
      if (wire.readyState !== 1) return;
      try {
        wire.send(handshake.helloText);
      } catch (error) {
        failAttemptLocal(toError(error));
      }
    };

    const establish = (crypto: EstablishedChannelCrypto, batch: boolean): void => {
      cryptoChannel = crypto;
      batchNegotiated = batch;
      if (helloInterval !== null) {
        clearInterval(helloInterval);
        helloInterval = null;
      }
      if (helloDeadline !== null) {
        clearTimeout(helloDeadline);
        helloDeadline = null;
      }
      consecutiveFailures = 0;

      const streams = new Map<number, StreamHandler>();
      const allocator = createStreamIdAllocator();
      const assembler = createFragmentAssembler();
      let sendChain: Promise<void> = Promise.resolve();

      // Serialize encrypt+send: the per-direction IV counter must hit the wire in
      // encryption order or the receiver fails closed. One call == one encrypted
      // WS message == one counter tick, whether it carries a batch or a lone frame.
      const sendEncryptedPlaintext = (plaintext: Uint8Array): void => {
        sendChain = sendChain
          .then(async () => {
            if (channelObj.dead) return;
            const encrypted = await crypto.encryptor.encrypt(plaintext);
            wire.send(encrypted);
          })
          .catch(() => {
            // Send failures surface via wire close; do not break the chain.
          });
      };

      const localBatcher = batch
        ? createOutboundFrameBatcher({ windowMs: batchWindowMs, sendBatch: sendEncryptedPlaintext })
        : null;
      batcher = localBatcher;

      const sendFrame = (frame: Uint8Array): void => {
        lastActivityAt = Date.now();
        if (localBatcher) {
          localBatcher.enqueue(frame);
          return;
        }
        sendEncryptedPlaintext(frame);
      };

      const channelObj: ActiveChannel = {
        streams,
        assembler,
        nextStreamId: () => allocator.next(),
        send: sendFrame,
        dead: false,
      };
      channel = channelObj;
      activeChannel = channelObj;
      setStatus({ state: 'connected' });
      resolveWaiters(channelObj);
      pingTimer = setInterval(() => {
        const now = Date.now();
        // Only ping when the tunnel has actually been idle; streaming traffic
        // keeps lastActivityAt fresh, so sustained bursts send zero pings.
        if (now - lastActivityAt < pingIntervalMs) return;
        channelObj.send(encodeTunnelFrame(TunnelFrameType.Ping, 0, EMPTY_PAYLOAD));
        // Expect a Pong (or any frame) before the deadline; otherwise it's dead.
        if (pongDeadline === null) {
          pongDeadline = setTimeout(() => {
            pongDeadline = null;
            failAttemptLocal(new Error('relay keepalive timeout'));
          }, pingTimeoutMs);
        }
      }, pingIntervalMs);
    };

    const handleTunnelFrame = (channelObj: ActiveChannel, plaintext: Uint8Array): void => {
      let frame: TunnelFrame;
      try {
        frame = decodeTunnelFrame(plaintext);
      } catch (error) {
        failAttemptLocal(toError(error));
        return;
      }
      // Any received frame proves the tunnel is alive — clear the pong deadline.
      if (pongDeadline !== null) {
        clearTimeout(pongDeadline);
        pongDeadline = null;
      }
      if (frame.frameType === TunnelFrameType.Ping) {
        channelObj.send(encodeTunnelFrame(TunnelFrameType.Pong, frame.streamId, EMPTY_PAYLOAD));
        return;
      }
      if (frame.frameType === TunnelFrameType.Pong) return;
      // Non-keepalive inbound traffic counts as activity (suppresses our ping).
      lastActivityAt = Date.now();

      let payload = frame.payload;
      if (frame.frameType === TunnelFrameType.WsText || frame.frameType === TunnelFrameType.WsBinary) {
        let complete: Uint8Array | null;
        try {
          complete = channelObj.assembler.push(frame);
        } catch (error) {
          failAttemptLocal(toError(error));
          return;
        }
        if (complete === null) return;
        payload = complete;
      } else if (frame.hasMoreFragments) {
        failAttemptLocal(new Error('unexpected fragmented tunnel frame'));
        return;
      }

      const handler = channelObj.streams.get(frame.streamId);
      // Late frames for a stream we already dropped (abort race) are expected.
      if (!handler) return;
      handler.handleFrame(frame.frameType, payload);
    };

    wire.onopen = () => {
      if (settled || generation !== attemptGeneration) return;
      sendHello();
      helloInterval = setInterval(sendHello, helloRetryMs);
    };

    wire.onmessage = (event) => {
      if (settled || generation !== attemptGeneration) return;
      const data = event.data;
      if (typeof data === 'string') {
        recvChain = recvChain
          .then(async () => {
            if (settled || generation !== attemptGeneration) return;
            // Post-establish text frames go through the handshake too: the host
            // re-answers retried hellos with duplicate `ready` frames, which the
            // handshake ignores; anything else fails closed there.
            const action = await handshake.handleText(data);
            if (action.type === 'established') {
              if (cryptoChannel) return;
              establish(action.channel, action.batch);
            } else if (action.type === 'fail') {
              failAttemptLocal(new Error(`relay handshake failed: ${action.reason}`));
            }
          })
          .catch((error: unknown) => {
            failAttemptLocal(toError(error));
          });
        return;
      }
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
      if (!bytes) return;
      // Decrypt sequentially: the counter check requires wire order.
      recvChain = recvChain
        .then(async () => {
          if (settled || generation !== attemptGeneration) return;
          const currentChannel = channel;
          const currentCrypto = cryptoChannel;
          if (!currentChannel || !currentCrypto) {
            failAttemptLocal(new Error('encrypted frame before handshake completed'));
            return;
          }
          let plaintext: Uint8Array;
          try {
            plaintext = await currentCrypto.decryptor.decrypt(bytes);
          } catch (error) {
            failAttemptLocal(toError(error));
            return;
          }
          if (batchNegotiated) {
            // One encrypted message may carry several tunnel frames; dispatch
            // each in order through the same per-frame handling as legacy.
            let frames: Uint8Array[];
            try {
              frames = decodeFrameBatch(plaintext);
            } catch (error) {
              failAttemptLocal(toError(error));
              return;
            }
            for (const frame of frames) {
              if (settled || generation !== attemptGeneration || currentChannel.dead) return;
              handleTunnelFrame(currentChannel, frame);
            }
            return;
          }
          handleTunnelFrame(currentChannel, plaintext);
        })
        .catch((error: unknown) => {
          failAttemptLocal(toError(error));
        });
    };

    wire.onclose = (event) => {
      const terminal = TERMINAL_RELAY_CLOSE_CODES.has(event.code);
      failAttemptLocal(
        new Error(RELAY_CLOSE_MESSAGES[event.code] ?? `relay socket closed (code ${event.code})`),
        { terminal, asErrorState: terminal },
      );
    };

    wire.onerror = () => {
      // onclose follows with the failure path.
    };

    helloDeadline = setTimeout(() => {
      helloDeadline = null;
      failAttemptLocal(new Error('relay handshake timeout'), { asErrorState: true });
    }, helloTimeoutMs);

    function failAttempt(gen: number, error: Error, asErrorState = false): void {
      if (gen !== attemptGeneration || closed) return;
      rejectWaiters(error);
      consecutiveFailures += 1;
      setStatus({ state: asErrorState ? 'error' : 'reconnecting', lastError: error.message });
      scheduleReconnect();
    }
  };

  const waitForChannel = (signal?: AbortSignal): Promise<ActiveChannel> => {
    if (closed) return Promise.reject(new Error('relay tunnel closed'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (activeChannel && !activeChannel.dead) return Promise.resolve(activeChannel);
    return new Promise<ActiveChannel>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      const waiter: ChannelWaiter = {
        resolve(channel) {
          if (onAbort && signal) signal.removeEventListener('abort', onAbort);
          resolve(channel);
        },
        reject(error) {
          if (onAbort && signal) signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      if (signal) {
        onAbort = () => {
          channelWaiters = channelWaiters.filter((entry) => entry !== waiter);
          reject(abortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      channelWaiters.push(waiter);
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    attemptGeneration += 1;
    clearReconnectTimer();
    removeWakeListeners();
    currentAttemptCleanup?.();
    currentAttemptCleanup = null;
    const channel = activeChannel;
    activeChannel = null;
    const error = new Error('relay tunnel closed');
    if (channel) failChannelStreams(channel, error);
    rejectWaiters(error);
    try {
      currentWire?.close();
    } catch {
      // Wire may already be closed.
    }
    currentWire = null;
    setStatus({ state: 'idle' });
  };

  void connect();

  return {
    fetch: (input, init) => tunnelFetch(waitForChannel, input, init),
    openWebSocket: (pathWithQuery, protocols) =>
      openTunnelWebSocket(() => waitForChannel(), pathWithQuery, protocols),
    getStatus: () => status,
    subscribeStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    close,
  };
};
