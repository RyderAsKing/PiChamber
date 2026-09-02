import {
  TunnelFrameType,
  type TunnelHttpRequestPayload,
  type TunnelWsOpenPayload,
} from './protocol';
import {
  chunkPayload,
  decodeJsonPayload,
  encodeFragmentedMessage,
  encodeJsonPayload,
  encodeTunnelFrame,
} from './tunnel-codec';
import {
  isHttpResponsePayload,
  isStreamAbortPayload,
  isWsClosePayload,
  normalizeTunnelRequest,
} from './tunnel-payloads';
import { markAmbiguousTransportFailure } from './transport-error';
import type { ActiveChannel } from './tunnel-types';
import {
  type RelayTunnelWebSocket,
  WS_CONNECTING,
  WS_OPEN,
  WS_CLOSING,
  WS_CLOSED,
} from './wire-socket';

const EMPTY_PAYLOAD = new Uint8Array(0);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
const abortError = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

export const tunnelFetch = async (
  waitForChannel: (signal?: AbortSignal) => Promise<ActiveChannel>,
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const request = await normalizeTunnelRequest(input, init);
  const signal = request.signal;
  if (signal?.aborted) throw abortError();
  const channel = await waitForChannel(signal);
  const streamId = channel.nextStreamId();

  return await new Promise<Response>((resolve, reject) => {
    let responseDelivered = false;
    let finished = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let onAbort: (() => void) | null = null;

    const cleanupStream = (): void => {
      channel.streams.delete(streamId);
      channel.assembler.dropStream(streamId);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };

    const finishError = (error: Error): void => {
      if (finished) return;
      finished = true;
      cleanupStream();
      if (!responseDelivered) {
        reject(error);
        return;
      }
      try {
        bodyController?.error(error);
      } catch {
        // Controller may already be closed.
      }
    };

    const sendAbort = (reason: string): void => {
      if (!channel.dead) {
        channel.send(encodeTunnelFrame(TunnelFrameType.StreamAbort, streamId, encodeJsonPayload({ reason })));
      }
    };

    // The request head is written to the channel below before any of these
    // failures can fire, so losing the stream never proves the server did
    // not process the request — only that the response was lost. Callers
    // that would otherwise retry (prompt sends) must see that distinction.
    const dispatchedFailure = (message: string): Error =>
      markAmbiguousTransportFailure(new Error(message));

    onAbort = () => {
      sendAbort('aborted');
      finishError(abortError());
    };

    channel.streams.set(streamId, {
      handleFrame(frameType, payload) {
        if (frameType === TunnelFrameType.HttpResponse) {
          if (responseDelivered || finished) return;
          let head;
          try {
            head = decodeJsonPayload(payload, isHttpResponsePayload);
          } catch (error) {
            sendAbort('malformed response head');
            finishError(dispatchedFailure(toError(error).message));
            return;
          }
          const nullBody = head.status === 204 || head.status === 205 || head.status === 304;
          let body: ReadableStream<Uint8Array> | null = null;
          if (!nullBody) {
            body = new ReadableStream<Uint8Array>({
              start(controller) {
                bodyController = controller;
              },
              cancel() {
                if (finished) return;
                finished = true;
                cleanupStream();
                sendAbort('response body cancelled');
              },
            });
          }
          responseDelivered = true;
          resolve(new Response(body, { status: head.status, headers: head.headers }));
          if (nullBody) {
            finished = true;
            cleanupStream();
          }
          return;
        }
        if (frameType === TunnelFrameType.HttpBody) {
          if (!responseDelivered || finished) return;
          try {
            bodyController?.enqueue(payload);
          } catch {
            // Consumer already cancelled the stream.
          }
          return;
        }
        if (frameType === TunnelFrameType.StreamEnd) {
          if (finished) return;
          if (!responseDelivered) {
            finishError(dispatchedFailure('tunnel stream ended before response head'));
            return;
          }
          finished = true;
          cleanupStream();
          try {
            bodyController?.close();
          } catch {
            // Consumer already cancelled the stream.
          }
          return;
        }
        if (frameType === TunnelFrameType.StreamAbort) {
          let reason = 'stream aborted by host';
          try {
            reason = decodeJsonPayload(payload, isStreamAbortPayload).reason;
          } catch {
            // Keep the generic reason.
          }
          finishError(dispatchedFailure(reason));
        }
      },
      fail(error) {
        // Channel death (reconnect, keepalive timeout) with this stream still
        // open — same rule as above: dispatched, outcome unknown. A fresh
        // error is tagged instead of the shared one so the tag cannot leak to
        // waiters whose request never reached the wire.
        finishError(dispatchedFailure(error.message));
      },
    });

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const head: TunnelHttpRequestPayload = {
      method: request.method,
      path: request.path,
      query: request.query,
      headers: request.headers,
    };
    channel.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, streamId, encodeJsonPayload(head)));
    void (async () => {
      try {
        if (request.body) {
          for await (const chunk of request.body) {
            if (finished || channel.dead) return;
            for (const piece of chunkPayload(chunk)) {
              channel.send(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, piece));
            }
          }
        }
        if (!finished && !channel.dead) {
          channel.send(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, EMPTY_PAYLOAD));
        }
      } catch (error) {
        sendAbort('request body failed');
        finishError(dispatchedFailure(toError(error).message));
      }
    })();
  });
};

export const splitPathQuery = (pathWithQuery: string): { path: string; query: string } => {
  const index = pathWithQuery.indexOf('?');
  if (index === -1) return { path: pathWithQuery, query: '' };
  return { path: pathWithQuery.slice(0, index), query: pathWithQuery.slice(index + 1) };
};

export const openTunnelWebSocket = (
  waitForChannel: () => Promise<ActiveChannel>,
  pathWithQuery: string,
  protocols?: string[]
): RelayTunnelWebSocket => {
  let readyState = WS_CONNECTING;
  let channelRef: ActiveChannel | null = null;
  let streamId = 0;
  let finished = false;

  const socket: RelayTunnelWebSocket = {
    get readyState() {
      return readyState;
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      if (readyState !== WS_OPEN || !channelRef || channelRef.dead) {
        throw new Error('relay tunnel socket is not open');
      }
      if (typeof data === 'string') {
        for (const frame of encodeFragmentedMessage(TunnelFrameType.WsText, streamId, textEncoder.encode(data))) {
          channelRef.send(frame);
        }
        return;
      }
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data.slice(0))
          : (() => {
              const copy = new Uint8Array(data.byteLength);
              copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
              return copy;
            })();
      for (const frame of encodeFragmentedMessage(TunnelFrameType.WsBinary, streamId, bytes)) {
        channelRef.send(frame);
      }
    },
    close(code = 1000, reason = '') {
      if (readyState === WS_CLOSED || readyState === WS_CLOSING) return;
      if (readyState === WS_OPEN && channelRef && !channelRef.dead) {
        readyState = WS_CLOSING;
        channelRef.send(encodeTunnelFrame(TunnelFrameType.WsClose, streamId, encodeJsonPayload({ code, reason })));
      }
      settleClose(code, reason);
    },
  };

  const settleClose = (code: number, reason: string, errored = false): void => {
    if (finished) return;
    finished = true;
    if (channelRef) {
      channelRef.streams.delete(streamId);
      channelRef.assembler.dropStream(streamId);
    }
    readyState = WS_CLOSED;
    if (errored) {
      try {
        socket.onerror?.();
      } catch {
        // Handler failures must not break teardown.
      }
    }
    try {
      socket.onclose?.({ code, reason });
    } catch {
      // Handler failures must not break teardown.
    }
  };

  void (async () => {
    let channel: ActiveChannel;
    try {
      channel = await waitForChannel();
    } catch (error) {
      settleClose(1006, toError(error).message, true);
      return;
    }
    if (finished) return;
    channelRef = channel;
    streamId = channel.nextStreamId();
    channel.streams.set(streamId, {
      handleFrame(frameType, payload) {
        if (frameType === TunnelFrameType.WsOpened) {
          if (readyState === WS_CONNECTING) {
            readyState = WS_OPEN;
            try {
              socket.onopen?.();
            } catch {
              // Handler failures must not break the stream.
            }
          }
          return;
        }
        if (frameType === TunnelFrameType.WsText) {
          try {
            socket.onmessage?.({ data: textDecoder.decode(payload) });
          } catch {
            // Handler failures must not break the stream.
          }
          return;
        }
        if (frameType === TunnelFrameType.WsBinary) {
          const buffer = new ArrayBuffer(payload.byteLength);
          new Uint8Array(buffer).set(payload);
          try {
            socket.onmessage?.({ data: buffer });
          } catch {
            // Handler failures must not break the stream.
          }
          return;
        }
        if (frameType === TunnelFrameType.WsClose) {
          let code = 1000;
          let reason = '';
          try {
            const parsed = decodeJsonPayload(payload, isWsClosePayload);
            code = parsed.code;
            reason = parsed.reason;
          } catch {
            // Keep defaults.
          }
          settleClose(code, reason);
          return;
        }
        if (frameType === TunnelFrameType.StreamAbort) {
          let reason = 'stream aborted';
          try {
            reason = decodeJsonPayload(payload, isStreamAbortPayload).reason;
          } catch {
            // Keep the generic reason.
          }
          settleClose(1006, reason, true);
        }
      },
      fail(error) {
        // Spec: streams killed by a tunnel reset close with 1012 so callers'
        // reconnect machinery treats it as "host went away, retry".
        settleClose(1012, error.message, true);
      },
    });
    const { path, query } = splitPathQuery(pathWithQuery);
    // The host sets the WS Origin itself (to the loopback origin it dials); the
    // client's window.location.origin is unreliable in WKWebView, so we don't send it.
    const openPayload: TunnelWsOpenPayload = protocols && protocols.length > 0 ? { path, query, protocols } : { path, query };
    channel.send(encodeTunnelFrame(TunnelFrameType.WsOpen, streamId, encodeJsonPayload(openPayload)));
  })();

  return socket;
};
