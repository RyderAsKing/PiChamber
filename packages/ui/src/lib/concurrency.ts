export const mapWithConcurrency = async <T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> => {
  if (values.length === 0) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, values.length));
  const results = new Array<R>(values.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const nextIndex = cursor;
      cursor += 1;
      if (nextIndex >= values.length) {
        return;
      }
      results[nextIndex] = await mapper(values[nextIndex]);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return results;
};

const createAbortError = (reason?: unknown): Error => {
  if (reason instanceof Error) return reason;
  if (typeof DOMException !== 'undefined') {
    return new DOMException(
      typeof reason === 'string' ? reason : 'The operation was aborted.',
      'AbortError',
    );
  }
  const error = new Error(typeof reason === 'string' ? reason : 'The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

/** Rejects with an AbortError as soon as `signal` aborts, even if `fn` ignores it. */
export const raceSignalAbort = <T>(fn: () => Promise<T>, signal?: AbortSignal | null): Promise<T> => {
  if (!signal) return fn();
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    fn().then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};
