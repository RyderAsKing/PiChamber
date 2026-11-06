// A Chrome DevTools Protocol client over `--remote-debugging-pipe`: Chrome
// reads commands from fd 3 and writes replies and events to fd 4, each
// message a JSON object followed by a NUL byte. Unlike a debugging port, the
// pipe cannot be reached by any other process on the machine.

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message || 'CDP command failed'}`);
    this.name = 'CdpError';
    this.code = error?.code;
  }
}

class CdpClosedError extends Error {
  constructor(method) {
    super(method ? `${method}: browser connection closed` : 'Browser connection closed');
    this.name = 'CdpClosedError';
  }
}

/**
 * @param {{ writable: import('node:stream').Writable, readable: import('node:stream').Readable, commandTimeoutMs?: number }} pipes
 */
export const createCdpConnection = ({ writable, readable, commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }) => {
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Set();
  const closeListeners = new Set();
  let buffered = [];

  const dispatch = (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(entry.method, message.error));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== 'string') return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // One failing listener must not starve the others.
      }
    }
  };

  readable.on('data', (chunk) => {
    let start = 0;
    let index = chunk.indexOf(0);
    while (index !== -1) {
      buffered.push(chunk.subarray(start, index));
      const text = Buffer.concat(buffered).toString('utf8');
      buffered = [];
      dispatch(text);
      start = index + 1;
      index = chunk.indexOf(0, start);
    }
    if (start < chunk.length) buffered.push(chunk.subarray(start));
  });

  const close = () => {
    if (closed) return;
    closed = true;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new CdpClosedError(entry.method));
    }
    pending.clear();
    for (const listener of closeListeners) {
      try { listener(); } catch { /* ignore */ }
    }
    closeListeners.clear();
    listeners.clear();
  };
  readable.on('close', close);
  readable.on('end', close);
  readable.on('error', close);
  writable.on('error', close);

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId]
   */
  const send = (method, params = {}, sessionId) => {
    if (closed) return Promise.reject(new CdpClosedError(method));
    const id = ++nextId;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new CdpError(method, { message: 'timed out' }));
      }, commandTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, method, timer });
      try {
        writable.write(`${JSON.stringify(message)}\0`);
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(new CdpClosedError(method));
      }
    });
  };

  return {
    send,
    /** Every event, as `{ method, params, sessionId? }`. Returns an unsubscribe function. */
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      if (closed) {
        listener();
        return () => {};
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    get closed() {
      return closed;
    },
    close,
  };
};
