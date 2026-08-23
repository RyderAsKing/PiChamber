import { describe, expect, test } from 'bun:test';

import { createSttAudioFrame, parseSttAudioFrame, parseSttControlFrame } from './protocol.js';

describe('STT protocol', () => {
  test('round trips binary PCM frames without base64', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const parsed = parseSttAudioFrame(createSttAudioFrame(42, pcm));
    expect(parsed.sequence).toBe(42);
    expect([...parsed.pcm16]).toEqual([...pcm]);
  });

  test('rejects odd PCM payloads and oversized controls', () => {
    expect(() => parseSttAudioFrame(createSttAudioFrame(0, new Uint8Array([1])))).toThrow('PCM16');
    expect(() => parseSttControlFrame(Buffer.from(`{"type":"start","padding":"${'x'.repeat(20_000)}"}`))).toThrow('too large');
  });
});
