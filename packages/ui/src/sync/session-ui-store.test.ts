import { afterEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { routeMessage, useSessionUIStore } from './session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';

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

  test('setNewSessionDraftTarget preserves draft open state and updates target project/directory', () => {
    useProjectsStore.setState({
      projects: [
        { id: 'proj-1', path: '/workspace/proj-1', label: 'Proj 1', addedAt: 1, lastOpenedAt: 1 },
        { id: 'proj-2', path: '/workspace/proj-2', label: 'Proj 2', addedAt: 2, lastOpenedAt: 2 },
      ],
      activeProjectId: 'proj-1',
    });

    const { openNewSessionDraft, setNewSessionDraftTarget } = useSessionUIStore.getState();
    openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
    });

    const stateAfterOpen = useSessionUIStore.getState();
    expect(stateAfterOpen.newSessionDraft.open).toBe(true);
    expect(stateAfterOpen.newSessionDraft.selectedProjectId).toBe('proj-1');
    expect(stateAfterOpen.currentSessionId).toBe(null);

    setNewSessionDraftTarget({
      projectId: 'proj-2',
      directoryOverride: '/workspace/proj-2',
    });

    const stateAfterTargetChange = useSessionUIStore.getState();
    expect(stateAfterTargetChange.newSessionDraft.open).toBe(true);
    expect(stateAfterTargetChange.newSessionDraft.selectedProjectId).toBe('proj-2');
    expect(stateAfterTargetChange.newSessionDraft.directoryOverride).toBe('/workspace/proj-2');
    expect(stateAfterTargetChange.currentSessionId).toBe(null);
  });
});
