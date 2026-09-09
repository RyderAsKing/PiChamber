import { afterEach, describe, expect, test } from 'bun:test';

import { createBrowserUuid } from './uuid';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const randomUuidDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
const getRandomValuesOriginal = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

afterEach(() => {
  if (randomUuidDescriptor) {
    Object.defineProperty(globalThis.crypto, 'randomUUID', randomUuidDescriptor);
  } else {
    Reflect.deleteProperty(globalThis.crypto as unknown as Record<string, unknown>, 'randomUUID');
  }
  globalThis.crypto.getRandomValues = getRandomValuesOriginal;
});

describe('createBrowserUuid', () => {
  test('prefers native randomUUID when available', () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: () => 'native-id',
    });
    let randomValuesCalled = false;
    globalThis.crypto.getRandomValues = (<T extends ArrayBufferView>(array: T): T => {
      randomValuesCalled = true;
      return getRandomValuesOriginal(array);
    }) as typeof globalThis.crypto.getRandomValues;

    expect(createBrowserUuid()).toBe('native-id');
    expect(randomValuesCalled).toBe(false);
  });

  test('falls back to cryptographic getRandomValues UUIDv4 without randomUUID', () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });

    const first = createBrowserUuid();
    const second = createBrowserUuid();
    expect(UUID_V4_PATTERN.test(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  test('formats controlled getRandomValues bytes as UUID v4', () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    globalThis.crypto.getRandomValues = (<T extends ArrayBufferView>(array: T): T => {
      const bytes = array as unknown as Uint8Array;
      for (let i = 0; i < 16; i += 1) bytes[i] = i;
      return array;
    }) as typeof globalThis.crypto.getRandomValues;

    expect(createBrowserUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  test('propagates native randomUUID failures without falling back', () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: () => {
        throw new Error('random source failed');
      },
    });
    expect(() => createBrowserUuid()).toThrow('random source failed');
  });

  test('throws when no secure random source exists', () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    globalThis.crypto.getRandomValues = undefined as unknown as typeof globalThis.crypto.getRandomValues;
    expect(() => createBrowserUuid()).toThrow('Secure random UUID is unavailable');
  });

  test('propagates getRandomValues failures', () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    globalThis.crypto.getRandomValues = (() => {
      throw new Error('entropy unavailable');
    }) as typeof globalThis.crypto.getRandomValues;
    expect(() => createBrowserUuid()).toThrow('entropy unavailable');
  });
});
