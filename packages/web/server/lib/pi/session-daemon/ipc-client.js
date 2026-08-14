import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class SessionDaemonClientError extends Error {
  constructor(code, message = 'The Pi session daemon is unavailable.') {
    super(message);
    this.code = code;
  }
}

/**
 * Send one authenticated request to the private daemon. This module is server
 * infrastructure: callers must never return its endpoint or credential.
 */
export const requestSessionDaemon = ({ endpoint, credential, command, payload, timeoutMs = 30_000 }) => new Promise((resolve, reject) => {
  const requestId = randomUUID();
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let authenticated = false;
  let settled = false;
  let timer;

  const socket = createConnection(endpoint);
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    callback(value);
  };
  const fail = (code) => finish(reject, new SessionDaemonClientError(code));

  timer = setTimeout(() => fail('DAEMON_UNAVAILABLE'), timeoutMs);
  socket.once('error', (error) => fail(error?.code === 'ECONNREFUSED' ? 'DAEMON_CONNECTION_REFUSED' : 'DAEMON_UNAVAILABLE'));
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
      fail('MALFORMED_DAEMON_RESPONSE');
      return;
    }

    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail('MALFORMED_DAEMON_RESPONSE');
        return;
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        fail('UNSUPPORTED_DAEMON_PROTOCOL');
        return;
      }
      if (!authenticated) {
        if (message.kind !== 'authenticated') {
          fail('DAEMON_AUTH_FAILED');
          return;
        }
        authenticated = true;
        socket.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, kind: 'request', requestId, command, payload })}\n`);
        continue;
      }
      if (message.kind === 'response' && message.requestId === requestId) {
        finish(resolve, message.result);
        return;
      }
      if (message.kind === 'error') {
        fail(typeof message.error?.code === 'string' ? message.error.code : 'DAEMON_REQUEST_FAILED');
        return;
      }
    }
  });
});

/**
 * Open an authenticated server-only event subscription. The caller owns the
 * returned close function and must relay only projected frames to browsers.
 */
export const subscribeSessionDaemon = ({ endpoint, credential, sessionId, fromSequence, onEvent, onError, timeoutMs = 30_000 }) => {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let authenticated = false;
  let closed = false;
  const socket = createConnection(endpoint);
  const timer = setTimeout(() => fail(new SessionDaemonClientError('DAEMON_UNAVAILABLE')), timeoutMs);
  const finish = () => {
    clearTimeout(timer);
    if (!closed) socket.destroy();
  };
  const fail = (error) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    socket.destroy();
    onError?.(error);
  };
  socket.once('error', () => fail(new SessionDaemonClientError('DAEMON_UNAVAILABLE')));
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ kind: 'authenticate', credential, ...(sessionId ? { sessionId } : {}), ...(Number.isSafeInteger(fromSequence) && fromSequence >= 0 ? { fromSequence } : {}) })}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return fail(new SessionDaemonClientError('MALFORMED_DAEMON_RESPONSE'));
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(new SessionDaemonClientError('MALFORMED_DAEMON_RESPONSE')); return; }
      if (message.protocolVersion !== PROTOCOL_VERSION) { fail(new SessionDaemonClientError('UNSUPPORTED_DAEMON_PROTOCOL')); return; }
      if (!authenticated) {
        if (message.kind !== 'authenticated') { fail(new SessionDaemonClientError('DAEMON_AUTH_FAILED')); return; }
        authenticated = true;
        clearTimeout(timer);
        continue;
      }
      if (message.kind === 'event') onEvent?.(message);
      else if (message.kind === 'error') fail(new SessionDaemonClientError(message.error?.code ?? 'DAEMON_REQUEST_FAILED'));
    }
  });
  socket.on('close', () => {
    if (!closed) fail(new SessionDaemonClientError('DAEMON_UNAVAILABLE'));
  });
  return () => {
    if (closed) return;
    closed = true;
    finish();
  };
};
