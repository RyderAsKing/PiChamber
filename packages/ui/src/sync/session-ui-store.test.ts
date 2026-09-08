import { afterEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { hydrateSessionFromDetail } from '@/lib/pi/event-reducer';
import {
  draftBranchCheckoutReceiptMatches,
  materializeOpenDraftSession,
  routeMessage,
  useSessionUIStore,
} from './session-ui-store';
import { clearAllRevertNavigations, setRevertNavigation } from './revert-navigation-store';
import { isNewSessionDraftSendPending } from './session-ui-draft-helpers';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

const store = getPiSessionStore();
const originalCreateSession = useSessionUIStore.getState().createSession;
const originals = {
  upload: store.upload,
  uploadFile: store.uploadFile,
  deleteUpload: store.deleteUpload,
  prompt: store.prompt,
  setModel: store.setModel,
  setThinking: store.setThinking,
  fork: store.fork,
  navigate: store.navigate,
};

afterEach(() => {
  store.upload = originals.upload;
  store.uploadFile = originals.uploadFile;
  store.deleteUpload = originals.deleteUpload;
  store.prompt = originals.prompt;
  store.setModel = originals.setModel;
  store.setThinking = originals.setThinking;
  store.fork = originals.fork;
  store.navigate = originals.navigate;
  useSessionUIStore.setState({
    createSession: originalCreateSession,
    currentSessionId: null,
    currentSessionDirectory: null,
    sendingNewSessionDraftId: null,
    newSessionDraft: {
      id: null,
      open: false,
      directoryOverride: null,
      parentID: null,
    },
  });
  clearAllRevertNavigations();
});

// bun's typed expect in this project has no asymmetric matcher typings, so
// prompt-option assertions extract the options object explicitly.
const promptOptionsOf = (args: unknown[] | undefined) =>
  args?.[4] as { operationId?: string; messageId?: string; streamEpoch?: string; model?: { providerId: string; modelId: string }; thinking?: string; knownEmptyTranscript?: boolean } | undefined;

describe('routeMessage', () => {
  test('uploads attached files and forwards their opaque ids with the prompt', async () => {
    const uploads: Array<{ filename: string; mime: string; base64: string }> = [];
    const prompts: unknown[][] = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.uploadFile = async (file, input) => {
      uploads.push({ filename: input.filename, mime: input.mime, base64: Buffer.from(await file.arrayBuffer()).toString('base64') });
      return { id: `attachment-${uploads.length}`, name: input.filename, mime: input.mime, size: file.size, expiresAt: Date.now() + 60_000 };
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
    expect(prompts).toHaveLength(1);
    const [promptArgs] = prompts as unknown as [unknown[]];
    expect(promptArgs?.slice(0, 4)).toEqual(['session-1', 'hello', 'prompt', [{ id: 'attachment-1' }]]);
    const promptOptions = promptOptionsOf(promptArgs);
    expect(typeof promptOptions?.operationId).toBe('string');
    expect(promptOptions?.model).toEqual({ providerId: 'provider', modelId: 'model' });
  });

  test('deletes refreshed uploads only when the operation id will never be retried', async () => {
    const deleted: string[] = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.uploadFile = async (file, input) => ({
      id: 'refreshed-1', name: input.filename, mime: input.mime, size: file.size, expiresAt: Date.now() + 60_000,
    });
    store.deleteUpload = async (id) => { deleted.push(id); };
    try {
      const { clearSendIntentsForTests } = await import('@/lib/pi/send-intent');
      clearSendIntentsForTests();
    } catch { /* test-only cache clear */ }
    // A definite rejection that requires a new id frees the refreshed upload.
    const definite = Object.assign(new Error('bad prompt'), { code: 'INVALID_PROMPT', status: 400 });
    store.prompt = async () => { throw definite; };
    await expect(routeMessage({
      sessionId: 'session-legacy', directory: '/workspace', content: 'hello', providerID: 'provider', modelID: 'model',
      files: [{ type: 'file', mime: 'text/plain', filename: 'legacy.txt', url: 'data:text/plain;base64,aGVsbG8=' }],
      operationId: 'op-definite-cleanup',
    })).rejects.toThrow('bad prompt');
    expect(deleted).toEqual(['refreshed-1']);
  });

  test('keeps refreshed uploads for uncertain outcomes so a same-id retry reuses them', async () => {
    const deleted: string[] = [];
    store.uploadFile = async (file, input) => ({
      id: 'refreshed-uncertain', name: input.filename, mime: input.mime, size: file.size, expiresAt: Date.now() + 60_000,
    });
    store.deleteUpload = async (id) => { deleted.push(id); };
    try {
      const { clearSendIntentsForTests } = await import('@/lib/pi/send-intent');
      clearSendIntentsForTests();
    } catch { /* test-only cache clear */ }
    store.prompt = async () => { throw new Error('prompt failed'); };
    await expect(routeMessage({
      sessionId: 'session-legacy-uncertain', directory: '/workspace', content: 'hello', providerID: 'provider', modelID: 'model',
      files: [{ type: 'file', mime: 'text/plain', filename: 'legacy.txt', url: 'data:text/plain;base64,aGVsbG8=' }],
      operationId: 'op-uncertain-cleanup',
    })).rejects.toThrow('prompt failed');
    expect(deleted).toEqual([]);
  });

  test('forwards ready attachment ids without uploading again', async () => {
    const prompts: unknown[][] = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.upload = async () => { throw new Error('ready attachments must not upload again'); };
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-ready' };
    };

    await routeMessage({
      sessionId: 'session-ready',
      directory: '/workspace',
      content: 'hello',
      providerID: 'provider',
      modelID: 'model',
      files: [{
        type: 'file', mime: 'text/plain', filename: 'note.txt', url: 'data:text/plain;base64,aGVsbG8=',
        uploadState: { status: 'ready', attachmentId: 'opaque-1', expiresAt: Date.now() + 60_000 },
      }],
    });

    expect(prompts).toHaveLength(1);
    const readyArgs = (prompts as unknown as unknown[][])[0];
    expect(readyArgs?.slice(0, 4)).toEqual(['session-ready', 'hello', 'prompt', [{ id: 'opaque-1' }]]);
    const readyOptions = promptOptionsOf(readyArgs);
    expect(typeof readyOptions?.operationId).toBe('string');
    expect(readyOptions?.model).toEqual({ providerId: 'provider', modelId: 'model' });
  });

  test('rejects pending and failed attachments before prompt dispatch', async () => {
    let prompted = false;
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.prompt = async () => {
      prompted = true;
      return { accepted: true, messageId: 'message-never' };
    };
    const base = {
      sessionId: 'session-1', directory: '/workspace', content: 'hello', providerID: 'provider', modelID: 'model',
    };

    await expect(routeMessage({ ...base, files: [{ type: 'file', mime: 'text/plain', filename: 'a', url: '', uploadState: { status: 'uploading', progress: 10 } }] })).rejects.toThrow('still uploading');
    await expect(routeMessage({ ...base, files: [{ type: 'file', mime: 'text/plain', filename: 'a', url: '', uploadState: { status: 'failed', error: 'nope' } }] })).rejects.toThrow('Retry or remove');
    expect(prompted).toBe(false);
  });

  test('filters out non-data/server file references without throwing base64 errors', async () => {
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
      return { accepted: true, messageId: 'message-2' };
    };

    await routeMessage({
      sessionId: 'session-2',
      directory: '/workspace',
      content: 'How hard will it be for us to update @PiChamber/ entirely with this kind of UI: https://github.com/zeronsh/comet',
      providerID: 'provider',
      modelID: 'model',
      files: [{ type: 'file', mime: 'text/plain', filename: 'PiChamber', url: 'file:///workspace/PiChamber' }],
    });

    expect(uploads).toEqual([]);
    expect(prompts).toHaveLength(1);
    const filteredArgs = (prompts as unknown as unknown[][])[0];
    expect(filteredArgs?.slice(0, 4)).toEqual(['session-2', 'How hard will it be for us to update @PiChamber/ entirely with this kind of UI: https://github.com/zeronsh/comet', 'prompt', undefined]);
    const filteredOptions = promptOptionsOf(filteredArgs);
    expect(typeof filteredOptions?.operationId).toBe('string');
    expect(filteredOptions?.model).toEqual({ providerId: 'provider', modelId: 'model' });
  });

  test('carries the captured model and thinking inline with the send intent', async () => {
    const calls: string[] = [];
    store.setModel = async () => { calls.push('setModel'); };
    store.setThinking = async () => { calls.push('setThinking'); };
    store.upload = async () => ({ id: 'attachment-1', name: 'x', mime: 'text/plain', size: 1 });
    const promptArgs: unknown[][] = [];
    store.prompt = async (...args) => {
      calls.push('prompt');
      promptArgs.push(args);
      return { accepted: true, messageId: 'message-3' };
    };

    await routeMessage({
      sessionId: 'session-3',
      directory: '/workspace',
      content: 'hello',
      providerID: 'opencode-go',
      modelID: 'muse-spark-1.2-contributor',
      variant: 'xhigh',
    });

    // Inline atomic intent (finding #4): no standalone config writes — the
    // daemon applies model+thinking atomically with acceptance.
    expect(calls).toEqual(['prompt']);
    expect(promptArgs[0]?.slice(0, 4)).toEqual(['session-3', 'hello', 'prompt', undefined]);
    const inlineOptions = promptOptionsOf(promptArgs[0]);
    expect(typeof inlineOptions?.operationId).toBe('string');
    expect(inlineOptions?.model).toEqual({ providerId: 'opencode-go', modelId: 'muse-spark-1.2-contributor' });
    expect(inlineOptions?.thinking).toBe('xhigh');
  });

  test('carries the captured thinking inline even when the session had a previous model and level', async () => {
    const sessionId = 'session-direct-mode';
    const originalState = store.getState();
    const existing = hydrateSessionFromDetail({
      session: {
        id: sessionId,
        directory: '/workspace',
        model: { providerId: 'opencode-go', modelId: 'previous-model' },
        thinking: 'max',
      },
      lastSequence: 1,
      messages: [],
    }).session;
    (store as unknown as { state: typeof originalState }).state = {
      ...originalState,
      reducer: {
        ...originalState.reducer,
        bySession: new Map([[sessionId, existing]]),
      },
    };

    const promptArgs: unknown[][] = [];
    store.prompt = async (...args) => {
      promptArgs.push(args);
      return { accepted: true, messageId: 'message-direct-mode' };
    };

    try {
      await routeMessage({
        sessionId,
        directory: '/workspace',
        content: 'hello',
        providerID: 'openai-codex',
        modelID: 'gpt-5.6-luna',
        variant: 'max',
      });
      expect(promptArgs[0]?.slice(0, 4)).toEqual([sessionId, 'hello', 'prompt', undefined]);
      const carriedOptions = promptOptionsOf(promptArgs[0]);
      expect(typeof carriedOptions?.operationId).toBe('string');
      expect(carriedOptions?.model).toEqual({ providerId: 'openai-codex', modelId: 'gpt-5.6-luna' });
      expect(carriedOptions?.thinking).toBe('max');
    } finally {
      (store as unknown as { state: typeof originalState }).state = originalState;
    }
  });

  test('sends without a thinking override leave the level to the daemon while still capturing the model', async () => {
    const prompts: unknown[][] = [];
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-4' };
    };

    await routeMessage({
      sessionId: 'session-4',
      directory: '/workspace',
      content: 'hello',
      providerID: 'provider',
      modelID: 'model',
      variant: undefined,
    });
    expect(prompts).toHaveLength(1);
    const plainArgs = (prompts as unknown as unknown[][])[0];
    expect(plainArgs?.slice(0, 4)).toEqual(['session-4', 'hello', 'prompt', undefined]);
    const plainOptions = promptOptionsOf(plainArgs);
    expect(typeof plainOptions?.operationId).toBe('string');
    expect(plainOptions?.model).toEqual({ providerId: 'provider', modelId: 'model' });
    expect(plainOptions?.thinking).toBeUndefined();
  });

  test('same operation id reuses message id, epoch, config, and uploads across manual retries', async () => {
    const prompts: unknown[][] = [];
    let uploads = 0;
    store.uploadFile = async (_file, input) => {
      uploads += 1;
      return { id: `attachment-${uploads}`, name: input.filename, mime: input.mime, size: 4, expiresAt: Date.now() + 60_000 };
    };
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-stable' };
    };
    try {
      const { clearSendIntentsForTests } = await import('@/lib/pi/send-intent');
      clearSendIntentsForTests();
    } catch { /* test-only cache clear */ }

    const base = {
      sessionId: 'session-stable', directory: '/workspace', content: 'hello',
      providerID: 'provider', modelID: 'model', variant: 'high' as const,
      files: [{ type: 'file' as const, mime: 'text/plain', filename: 'a.txt', url: 'data:text/plain;base64,aGVsbG8=' }],
      operationId: 'op-stable-1',
    };
    await routeMessage({ ...base });
    await routeMessage({ ...base });
    expect(uploads).toBe(1);
    expect(prompts).toHaveLength(2);
    const firstOptions = promptOptionsOf((prompts as unknown as unknown[][])[0]);
    const secondOptions = promptOptionsOf((prompts as unknown as unknown[][])[1]);
    expect(firstOptions?.operationId).toBe('op-stable-1');
    expect(secondOptions?.operationId).toBe('op-stable-1');
    expect(secondOptions).toMatchObject({
      messageId: (firstOptions as unknown as { messageId: string }).messageId,
      model: { providerId: 'provider', modelId: 'model' },
      thinking: 'high',
    });
    expect((prompts as unknown as unknown[][])[0]?.[3]).toEqual((prompts as unknown as unknown[][])[1]?.[3]);
  });

  test('same operation id with a different payload is a caller bug', async () => {
    store.prompt = async () => ({ accepted: true, messageId: 'm' });
    try {
      const { clearSendIntentsForTests } = await import('@/lib/pi/send-intent');
      clearSendIntentsForTests();
    } catch { /* test-only cache clear */ }
    const base = {
      sessionId: 'session-mismatch', directory: '/workspace', content: 'hello',
      providerID: 'provider', modelID: 'model', operationId: 'op-mismatch-1',
    };
    await routeMessage({ ...base });
    await expect(routeMessage({ ...base, content: 'different' })).rejects.toThrow('different payload');
    await expect(routeMessage({ ...base, sessionId: 'session-other' })).rejects.toThrow('different payload');
  });

  test('distinct operation ids are distinct intents with distinct message ids', async () => {
    const prompts: unknown[][] = [];
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'm' };
    };
    try {
      const { clearSendIntentsForTests } = await import('@/lib/pi/send-intent');
      clearSendIntentsForTests();
    } catch { /* test-only cache clear */ }
    const base = {
      sessionId: 'session-distinct', directory: '/workspace', content: 'hello',
      providerID: 'provider', modelID: 'model',
    };
    await routeMessage({ ...base, operationId: 'op-a' });
    await routeMessage({ ...base, operationId: 'op-b' });
    const a = promptOptionsOf((prompts as unknown as unknown[][])[0]) as unknown as { messageId: string };
    const b = promptOptionsOf((prompts as unknown as unknown[][])[1]) as unknown as { messageId: string };
    expect(a.messageId).not.toBe(b.messageId);
  });

  test('forkFromMessage calls the backend even when the session catalog has no row and waits for it to resolve', async () => {
    const calls: Array<[string, string | undefined]> = [];
    let resolveFork!: () => void;
    store.fork = (async (sessionId: string, messageId?: string) => {
      calls.push([sessionId, messageId]);
      await new Promise<void>((resolve) => { resolveFork = resolve; });
    }) as typeof store.fork;

    let settled = false;
    const pending = useSessionUIStore.getState().forkFromMessage('temporarily-absent-session', 'live-message-id');
    void pending.then(() => { settled = true; });
    await Promise.resolve();

    expect(calls).toEqual([['temporarily-absent-session', 'live-message-id']]);
    expect(settled).toBe(false);

    resolveFork();
    await pending;
    expect(settled).toBe(true);
  });

  test('forkFromMessage rejects when the backend rejects', async () => {
    const failure = new Error('Invalid entry ID for forking');
    store.fork = (async () => { throw failure; }) as typeof store.fork;

    await expect(useSessionUIStore.getState().forkFromMessage('session-1', 'live-message-id')).rejects.toThrow(failure.message);
  });

  test('restore rejects when Pi cannot navigate to the original leaf', async () => {
    setRevertNavigation('session-1', {
      targetEntryId: 'reverted-entry',
      previousLeafId: 'original-leaf',
      newLeafId: 'short-leaf',
    }, []);
    const failure = new Error('Restore target not found');
    store.navigate = (async () => { throw failure; }) as typeof store.navigate;

    await expect(useSessionUIStore.getState().handleSlashRedo('session-1')).rejects.toThrow(failure.message);
  });

  test('matches branch checkout receipts only to the exact runtime, directory, and branch', () => {
    const intent = { runtimeKey: 'runtime-a', directory: '/workspace/project', branch: 'feature/a' };

    expect(draftBranchCheckoutReceiptMatches(intent, { ...intent })).toBe(true);
    expect(draftBranchCheckoutReceiptMatches(intent, { ...intent, runtimeKey: 'runtime-b' })).toBe(false);
    expect(draftBranchCheckoutReceiptMatches(intent, { ...intent, directory: '/workspace/other' })).toBe(false);
    expect(draftBranchCheckoutReceiptMatches(intent, { ...intent, branch: 'main' })).toBe(false);
    expect(draftBranchCheckoutReceiptMatches(intent, null)).toBe(false);
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

  test('refuses to materialize a draft with an unconfirmed branch intent', async () => {
    const { openNewSessionDraft } = useSessionUIStore.getState();
    openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
      branchIntent: {
        runtimeKey: getRuntimeKey(),
        directory: '/workspace/proj-1',
        branch: 'feature/a',
      },
    });

    await expect(materializeOpenDraftSession({
      providerID: 'provider',
      modelID: 'model',
    })).rejects.toThrow('Confirm the selected branch');
  });

  test('refuses to materialize a draft with an uncreated worktree intent', async () => {
    const { openNewSessionDraft } = useSessionUIStore.getState();
    openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
      worktreeIntent: {
        runtimeKey: getRuntimeKey(),
        projectRoot: '/workspace/proj-1',
        sourceDirectory: '/workspace/proj-1',
        startRef: 'main',
      },
    });

    await expect(materializeOpenDraftSession({
      providerID: 'provider',
      modelID: 'model',
    })).rejects.toThrow('Create the selected worktree');
  });

  test('does not derive a new session title from an extension command', async () => {
    const titles: Array<string | undefined> = [];
    useSessionUIStore.getState().setCurrentSession('session-other', '/workspace/other');
    useSessionUIStore.getState().openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
    });
    useSessionUIStore.setState({
      createSession: async (title, directoryOverride) => {
        titles.push(title);
        return { id: 'session-extension', directory: directoryOverride ?? '/workspace/proj-1' };
      },
    });

    await materializeOpenDraftSession({
      providerID: 'provider',
      modelID: 'model',
      initialPrompt: '/balance',
      initialInputKind: 'extension-command',
    });

    expect(titles).toEqual([undefined]);
  });

  test('routes a completed worktree draft to its created session after navigation', async () => {
    const prompts: unknown[][] = [];
    const creationMetadata: Array<Record<string, unknown> | undefined> = [];
    store.setModel = async () => undefined;
    store.setThinking = async () => undefined;
    store.prompt = async (...args) => {
      prompts.push(args);
      return { accepted: true, messageId: 'message-1' };
    };

    const worktreeIntent = {
      runtimeKey: getRuntimeKey(),
      projectRoot: '/workspace/proj-1',
      sourceDirectory: '/workspace/proj-1',
      startRef: 'main',
    };
    useSessionUIStore.getState().openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
      worktreeIntent,
    });
    const draftSnapshot = useSessionUIStore.getState().newSessionDraft;

    useSessionUIStore.getState().setCurrentSession('session-other', '/workspace/other');
    useSessionUIStore.setState({
      createSession: async (_title, directoryOverride, _parentId, metadata) => {
        creationMetadata.push(metadata);
        return {
          id: 'session-worktree',
          directory: directoryOverride ?? '/worktrees/new',
        };
      },
    });

    await useSessionUIStore.getState().sendMessage(
      'initial worktree prompt',
      'provider',
      'model',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        worktreeCreationReceipt: {
          ...worktreeIntent,
          path: '/worktrees/new',
          branch: 'pichamber/new',
        },
        draftSnapshot,
      },
    );

    expect(creationMetadata).toEqual([{
      model: { providerId: 'provider', modelId: 'model' },
      thinking: undefined,
      select: false,
    }]);
    expect(prompts).toHaveLength(1);
    const worktreeArgs = (prompts as unknown as unknown[][])[0];
    expect(worktreeArgs?.slice(0, 4)).toEqual(['session-worktree', 'initial worktree prompt', 'prompt', undefined]);
    const worktreeOptions = promptOptionsOf(worktreeArgs);
    expect(worktreeOptions?.knownEmptyTranscript).toBe(true);
    expect(typeof worktreeOptions?.operationId).toBe('string');
    expect(worktreeOptions?.model).toEqual({ providerId: 'provider', modelId: 'model' });
    expect(useSessionUIStore.getState().currentSessionId).toBe('session-other');
  });

  test('stores a worktree intent and clears it when the draft directory changes', () => {
    const { openNewSessionDraft, setNewSessionDraftTarget } = useSessionUIStore.getState();
    openNewSessionDraft({ selectedProjectId: 'proj-1', directoryOverride: '/workspace/proj-1' });
    setNewSessionDraftTarget({
      branchIntent: null,
      worktreeIntent: {
        runtimeKey: getRuntimeKey(),
        projectRoot: '/workspace/proj-1',
        sourceDirectory: '/workspace/proj-1',
        startRef: 'main',
      },
    });
    expect(useSessionUIStore.getState().newSessionDraft.worktreeIntent?.startRef).toBe('main');

    setNewSessionDraftTarget({ directoryOverride: '/workspace/proj-2' });
    expect(useSessionUIStore.getState().newSessionDraft.worktreeIntent).toBeNull();
  });

  test('stores a branch intent and clears it when the draft directory changes', () => {
    const { openNewSessionDraft, setNewSessionDraftTarget } = useSessionUIStore.getState();
    openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
    });

    setNewSessionDraftTarget({
      branchIntent: {
        runtimeKey: getRuntimeKey(),
        directory: '/workspace/proj-1',
        branch: 'feature/a',
      },
    });
    const draftWithBranch = useSessionUIStore.getState().newSessionDraft;
    expect(draftWithBranch.open).toBe(true);
    expect(draftWithBranch.branchIntent).toEqual({
      runtimeKey: getRuntimeKey(),
      directory: '/workspace/proj-1',
      branch: 'feature/a',
    });

    setNewSessionDraftTarget({ directoryOverride: '/workspace/proj-2' });
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().newSessionDraft.branchIntent).toBeNull();
  });
});

describe('sendingNewSessionDraftId', () => {
  test('tracks only the draft that owns the in-flight send', () => {
    const { openNewSessionDraft, setSendingNewSessionDraftId } = useSessionUIStore.getState();
    openNewSessionDraft({
      selectedProjectId: 'proj-1',
      directoryOverride: '/workspace/proj-1',
    });
    const draftId = useSessionUIStore.getState().newSessionDraft.id;

    expect(draftId).not.toBeNull();
    expect(useSessionUIStore.getState().sendingNewSessionDraftId).toBeNull();
    setSendingNewSessionDraftId(draftId);
    expect(useSessionUIStore.getState().sendingNewSessionDraftId).toBe(draftId);
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe(null);
    expect(isNewSessionDraftSendPending(
      useSessionUIStore.getState().newSessionDraft,
      useSessionUIStore.getState().currentSessionId,
      useSessionUIStore.getState().sendingNewSessionDraftId,
    )).toBe(true);

    useSessionUIStore.getState().setCurrentSession('session-other', '/workspace/other');
    openNewSessionDraft({ directoryOverride: '/workspace/proj-1' });
    expect(useSessionUIStore.getState().newSessionDraft.id).not.toBe(draftId);
    expect(useSessionUIStore.getState().sendingNewSessionDraftId).toBe(draftId);
    expect(isNewSessionDraftSendPending(
      useSessionUIStore.getState().newSessionDraft,
      useSessionUIStore.getState().currentSessionId,
      useSessionUIStore.getState().sendingNewSessionDraftId,
    )).toBe(false);
  });

  test('restoreForRuntimeSwitch clears a stale in-flight owner', () => {
    useSessionUIStore.getState().setSendingNewSessionDraftId('draft-old');
    expect(useSessionUIStore.getState().sendingNewSessionDraftId).toBe('draft-old');
    useSessionUIStore.getState().restoreForRuntimeSwitch();
    expect(useSessionUIStore.getState().sendingNewSessionDraftId).toBeNull();
  });
});
