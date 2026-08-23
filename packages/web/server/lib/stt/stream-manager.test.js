import { describe, expect, test } from 'bun:test';

import { SttStreamManager } from './stream-manager.js';

const speech = (samples = 4000) => {
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(index % 2 ? 5000 : -5000, index * 2);
  return pcm;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SttStreamManager', () => {
  test('emits one final transcript after finish and never emits partial text', async () => {
    const messages = [];
    const calls = [];
    const manager = new SttStreamManager({
      createTranscriber: async () => ({
        transcribe: async (pcm16, sampleRate) => { calls.push({ pcm16, sampleRate }); return { text: 'hello world' }; },
        close() {},
      }),
    });
    await manager.start({ recordingId: 'recording-123456789', providerConfigId: 'local', emit: (message) => messages.push(message) });
    manager.append('recording-123456789', 0, speech());
    manager.finish('recording-123456789', 0);
    await settle();
    expect(calls).toHaveLength(1);
    expect(messages.some((message) => message.type === 'partial')).toBe(false);
    expect(messages.at(-1)).toMatchObject({ type: 'final', text: 'hello world' });
    manager.shutdown();
  });

  test('reattaches to a retained recording and acks replayed chunks without decoding twice', async () => {
    const first = [];
    const second = [];
    let calls = 0;
    const manager = new SttStreamManager({
      createTranscriber: async () => ({ transcribe: async () => { calls += 1; return { text: 'retained' }; }, close() {} }),
    });
    const emitFirst = (message) => first.push(message);
    await manager.start({ recordingId: 'recording-abcdefgh', emit: emitFirst });
    manager.append('recording-abcdefgh', 0, speech());
    manager.detach('recording-abcdefgh', emitFirst);
    await manager.start({ recordingId: 'recording-abcdefgh', emit: (message) => second.push(message) });
    manager.append('recording-abcdefgh', 0, speech());
    manager.finish('recording-abcdefgh', 0);
    await settle();
    expect(second[0]).toMatchObject({ type: 'started', ackSequence: 0 });
    expect(calls).toBe(1);
    manager.shutdown();
  });

  test('rejects silent recordings without calling a provider', async () => {
    const messages = [];
    let calls = 0;
    const manager = new SttStreamManager({ createTranscriber: async () => ({ transcribe: async () => { calls += 1; return { text: '' }; }, close() {} }) });
    await manager.start({ recordingId: 'recording-silence12', emit: (message) => messages.push(message) });
    manager.append('recording-silence12', 0, Buffer.alloc(8000));
    manager.finish('recording-silence12', 0);
    await settle();
    expect(calls).toBe(0);
    expect(messages.at(-1)).toMatchObject({ type: 'error', code: 'EMPTY_AUDIO' });
  });
});
