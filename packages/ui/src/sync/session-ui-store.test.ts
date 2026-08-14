import { afterEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { routeMessage } from './session-ui-store';

const store = getPiSessionStore();
const originals = {
  upload: store.upload,
  prompt: store.prompt,
  setModel: store.setModel,
  setThinking: store.setThinking,
};

afterEach(() => {
  store.upload = originals.upload;
  store.prompt = originals.prompt;
  store.setModel = originals.setModel;
  store.setThinking = originals.setThinking;
});

describe('routeMessage', () => {
  test('uploads attached files and forwards their opaque ids with the prompt', async () => {
    const uploads: Array<{ filename: string; mime: string; base64: string }> = [];
    const prompts: unknown[][] = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.upload = async (input) => {
      uploads.push(input);
      return { id: `attachment-${uploads.length}`, name: input.filename, mime: input.mime, size: 3 };
    };
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-1' };
    };

    await routeMessage({
      sessionId: 'session-1',
      directory: '/workspace',
      content: 'hello',
      providerID: 'provider',
      modelID: 'model',
      files: [{ type: 'file', mime: 'image/png', filename: '../screen.png', url: 'data:image/png;base64,AQID' }],
    });

    expect(uploads).toEqual([{ filename: '__screen.png', mime: 'image/png', base64: 'AQID' }]);
    expect(prompts).toEqual([['session-1', 'hello', 'prompt', [{ id: 'attachment-1' }]]]);
  });
});
