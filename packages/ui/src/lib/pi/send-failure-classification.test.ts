import { describe, expect, test } from 'bun:test';
import { markAmbiguousTransportFailure } from '@/lib/relay/transport-error';
import { classifySendFailure } from './send-failure-classification';
import { PiRequestError } from './client';

describe('classifySendFailure', () => {
  test('ambiguous transport failures are uncertain, never definite', () => {
    expect(classifySendFailure(markAmbiguousTransportFailure(new Error('stream died')))).toBe('uncertain');
  });

  test('a server error response is a definite rejection', () => {
    expect(classifySendFailure(new PiRequestError('SESSION_BUSY', undefined, 409))).toBe('rejected');
    expect(classifySendFailure(new PiRequestError('INVALID_PROMPT', undefined, 400))).toBe('rejected');
    expect(classifySendFailure(new PiRequestError('OPERATION_PAYLOAD_MISMATCH', undefined, 409))).toBe('rejected');
  });

  test('a request timeout is uncertain and distinct from an abort', () => {
    expect(classifySendFailure(new PiRequestError('DAEMON_TIMEOUT'))).toBe('uncertain');
  });

  test('local cancellation is aborted and distinct from network failure', () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    expect(classifySendFailure(abort)).toBe('aborted');
    expect(classifySendFailure(new PiRequestError('DAEMON_UNAVAILABLE', 'Runtime changed during request'))).toBe('aborted');
  });

  test('network errors are uncertain because the request may have been dispatched', () => {
    expect(classifySendFailure(new TypeError('fetch failed'))).toBe('uncertain');
    expect(classifySendFailure(new Error('socket hang up'))).toBe('uncertain');
  });
});
